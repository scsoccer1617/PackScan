import type { Express, Request, Response, NextFunction } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { z } from 'zod';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { db, pool } from '../db';
import {
  users,
  authTokens,
  userPreferencesSchema,
  DEFAULT_USER_PREFERENCES,
  type User,
  type UserPreferences,
} from '../shared/schema';
import { sendEmail, verificationEmail, passwordResetEmail } from './email';
import { ensureDefaultSheetForUser, appendCardRow, NotConnectedError, type CardRowInput } from './googleSheets';

declare module 'express-session' {
  interface SessionData {
    pendingSheetAppend?: { card: CardRowInput; sheetId?: number; createdAt: number };
  }
}

function resolveSessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET environment variable is required in production (must be at least 16 characters).');
  }
  console.warn('[auth] SESSION_SECRET is not set — using an ephemeral random secret for this dev process. Sessions will be invalidated on restart.');
  return crypto.randomBytes(48).toString('hex');
}
const SESSION_SECRET = resolveSessionSecret();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
// REPLIT_DEV_DOMAIN is only set inside the dev workspace, never in a published
// deployment. Prefer it over APP_BASE_URL so the dev process always sends
// Google a dev-domain callback URL, even when APP_BASE_URL is configured as a
// shared secret pointing at production. Deployments fall through to
// APP_BASE_URL as before.
const APP_BASE_URL = (process.env.REPLIT_DEV_DOMAIN
  ? `https://${process.env.REPLIT_DEV_DOMAIN}`
  : '')
  || process.env.APP_BASE_URL
  || 'http://localhost:5000';

export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback';
export const GOOGLE_CONNECT_CALLBACK_PATH = '/api/auth/google/connect/callback';

// `drive.file` lets us touch files we created (sheet creation flow); the
// broader `drive` scope is required for the bulk-scan pipeline because
// dealers paste arbitrary folder URLs that the app didn't create — listing
// images, reading folder names, and moving processed files all need full
// Drive access. We keep both scopes; Google de-dupes overlapping access.
const GOOGLE_OAUTH_SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive',
];

declare global {
  namespace Express {
    interface User {
      id: number;
      email: string | null;
      displayName: string | null;
      emailVerifiedAt: Date | null;
      googleId: string | null;
    }
  }
}

export function isGoogleConfigured(): boolean {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    emailVerifiedAt: u.emailVerifiedAt,
    googleId: u.googleId,
    googleConnected: !!(u.googleAccessToken || u.googleRefreshToken),
  };
}

function hashToken(t: string) {
  return crypto.createHash('sha256').update(t).digest('hex');
}

async function createAuthToken(userId: number, kind: 'verify_email' | 'reset_password', ttlMs: number) {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(authTokens).values({ userId, kind, tokenHash, expiresAt });
  return raw;
}

async function consumeAuthToken(rawToken: string, kind: 'verify_email' | 'reset_password') {
  const tokenHash = hashToken(rawToken);
  const [row] = await db.select().from(authTokens).where(
    and(
      eq(authTokens.tokenHash, tokenHash),
      eq(authTokens.kind, kind),
      isNull(authTokens.usedAt),
      gt(authTokens.expiresAt, new Date()),
    )
  ).limit(1);
  if (!row) return null;
  await db.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, row.id));
  return row;
}

async function sendVerificationEmail(user: User) {
  if (!user.email) return;
  const raw = await createAuthToken(user.id, 'verify_email', 24 * 60 * 60 * 1000);
  const link = `${APP_BASE_URL}/verify-email?token=${raw}`;
  const tpl = verificationEmail(user.displayName, link);
  await sendEmail({ to: user.email, ...tpl });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

export function setupAuth(app: Express) {
  // Session middleware (Postgres-backed)
  const PgStore = connectPgSimple(session);
  app.set('trust proxy', 1);
  app.use(session({
    store: new PgStore({ pool, tableName: 'session', createTableIfMissing: true }),
    name: 'packscan.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // In the Replit dev workspace the app is loaded inside a cross-site
      // iframe (replit.com embedding *.picard.replit.dev). Browsers refuse to
      // send SameSite=Lax cookies in that context, so the user appears logged
      // out inside the workspace preview even after authenticating in a
      // standalone tab. Use SameSite=None+Secure in dev so the iframe sees
      // the session cookie. Production keeps the safer Lax default.
      secure: process.env.NODE_ENV === 'production' || !!process.env.REPLIT_DEV_DOMAIN,
      sameSite: process.env.REPLIT_DEV_DOMAIN ? 'none' : 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  }));

  app.use(passport.initialize());
  app.use(passport.session());

  // Local strategy (email + password)
  passport.use(new LocalStrategy(
    { usernameField: 'email', passwordField: 'password' },
    async (email, password, done) => {
      try {
        const normalized = String(email || '').trim().toLowerCase();
        const [u] = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
        if (!u || !u.passwordHash) return done(null, false, { message: 'Invalid email or password' });
        const ok = await bcrypt.compare(password, u.passwordHash);
        if (!ok) return done(null, false, { message: 'Invalid email or password' });
        return done(null, publicUser(u));
      } catch (err) {
        return done(err as any);
      }
    }
  ));

  // Google strategy (login + sheets/drive scopes)
  if (isGoogleConfigured()) {
    const googleStrategy = new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID!,
        clientSecret: GOOGLE_CLIENT_SECRET!,
        callbackURL: `${APP_BASE_URL}${GOOGLE_CALLBACK_PATH}`,
        passReqToCallback: true,
      },
      async (req: any, accessToken: string, refreshToken: string, params: any, profile: any, done: any) => {
        try {
          const email = profile.emails?.[0]?.value?.toLowerCase() || null;
          const tokenExpiresAt = params?.expires_in
            ? new Date(Date.now() + Number(params.expires_in) * 1000)
            : null;

          // If a user is already logged in, this is a "connect Google" flow:
          // attach the Google account / tokens to the existing user.
          if (req.user?.id) {
            const [existing] = await db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
            if (existing) {
              await db.update(users).set({
                googleId: profile.id,
                googleAccessToken: accessToken,
                googleRefreshToken: refreshToken || existing.googleRefreshToken,
                googleTokenExpiresAt: tokenExpiresAt,
                displayName: existing.displayName || profile.displayName || null,
              }).where(eq(users.id, existing.id));
              ensureDefaultSheetForUser(existing.id).catch(err =>
                console.error('[auth] ensureDefaultSheetForUser (connect):', err?.message || err));
              const [reread] = await db.select().from(users).where(eq(users.id, existing.id)).limit(1);
              return done(null, publicUser(reread));
            }
          }

          // Find by googleId or email
          let [u] = await db.select().from(users).where(eq(users.googleId, profile.id)).limit(1);
          if (!u && email) {
            [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
          }

          if (u) {
            await db.update(users).set({
              googleId: profile.id,
              googleAccessToken: accessToken,
              googleRefreshToken: refreshToken || u.googleRefreshToken,
              googleTokenExpiresAt: tokenExpiresAt,
              emailVerifiedAt: u.emailVerifiedAt || new Date(),
              displayName: u.displayName || profile.displayName || null,
            }).where(eq(users.id, u.id));
          } else {
            const [created] = await db.insert(users).values({
              email,
              googleId: profile.id,
              displayName: profile.displayName || null,
              emailVerifiedAt: new Date(),
              googleAccessToken: accessToken,
              googleRefreshToken: refreshToken || null,
              googleTokenExpiresAt: tokenExpiresAt,
            }).returning();
            u = created;
          }

          // Best-effort default sheet creation (don't block login on it)
          ensureDefaultSheetForUser(u.id).catch(err => console.error('[auth] ensureDefaultSheetForUser:', err?.message || err));

          const [reread] = await db.select().from(users).where(eq(users.id, u.id)).limit(1);
          return done(null, publicUser(reread));
        } catch (err) {
          return done(err);
        }
      }
    );
    passport.use('google', googleStrategy);
  }

  passport.serializeUser((user: any, done) => done(null, user.id));
  passport.deserializeUser(async (id: number, done) => {
    try {
      const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      if (!u) return done(null, false);
      done(null, publicUser(u));
    } catch (err) { done(err as any); }
  });

  // ──────────── Routes ────────────
  const apiPrefix = '/api/auth';

  const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    displayName: z.string().min(1).max(100).optional(),
  });

  app.post(`${apiPrefix}/register`, async (req, res) => {
    try {
      const parsed = registerSchema.parse(req.body);
      const email = parsed.email.toLowerCase();
      const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (existing) return res.status(400).json({ error: 'An account with this email already exists.' });
      const passwordHash = await bcrypt.hash(parsed.password, 12);
      const [u] = await db.insert(users).values({
        email,
        passwordHash,
        displayName: parsed.displayName || null,
      }).returning();
      sendVerificationEmail(u).catch(err => console.error('[auth] verification email error:', err));
      req.login(publicUser(u), (err) => {
        if (err) return res.status(500).json({ error: 'Login after register failed' });
        res.json({ user: publicUser(u) });
      });
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message || 'Invalid input' });
      console.error('[auth] register error:', err);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  app.post(`${apiPrefix}/login`, (req, res, next) => {
    passport.authenticate('local', (err: any, user: any, info: any) => {
      if (err) return next(err);
      if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
      req.login(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        res.json({ user });
      });
    })(req, res, next);
  });

  app.post(`${apiPrefix}/logout`, (req, res) => {
    req.logout((err) => {
      if (err) return res.status(500).json({ error: 'Logout failed' });
      req.session?.destroy(() => {
        res.clearCookie('packscan.sid');
        res.json({ ok: true });
      });
    });
  });

  app.get(`${apiPrefix}/me`, async (req, res) => {
    if (!req.user) return res.status(401).json({ user: null });
    const [u] = await db.select().from(users).where(eq(users.id, (req.user as any).id)).limit(1);
    if (!u) return res.status(401).json({ user: null });
    res.json({ user: publicUser(u) });
  });

  // Google OAuth — login flow
  app.get(`${apiPrefix}/google`, (req, res, next) => {
    if (!isGoogleConfigured()) return res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
    passport.authenticate('google', {
      scope: GOOGLE_OAUTH_SCOPES,
      accessType: 'offline',
      prompt: 'consent',
    } as any)(req, res, next);
  });
  app.get(GOOGLE_CALLBACK_PATH, (req, res, next) => {
    if (!isGoogleConfigured()) return res.redirect('/login?error=google_not_configured');
    passport.authenticate('google', {
      failureRedirect: '/login?error=google_failed',
    })(req, res, async () => {
      // Resume any pending "Add to Google Sheet" the user started before connecting.
      const pending = req.session?.pendingSheetAppend;
      const userId = (req.user as any)?.id as number | undefined;
      if (pending && userId) {
        const ageMs = Date.now() - (pending.createdAt || 0);
        delete req.session.pendingSheetAppend;
        if (ageMs < 15 * 60 * 1000) {
          try {
            await appendCardRow(userId, pending.card, pending.sheetId);
            return res.redirect('/scan?sheetAdded=1');
          } catch (err: any) {
            if (!(err instanceof NotConnectedError)) {
              console.error('[auth] resume append failed:', err?.message || err);
            }
            return res.redirect('/scan?sheetAddFailed=1');
          }
        }
      }
      res.redirect('/');
    });
  });

  // Google OAuth — connect-existing-account flow (user already signed in)
  app.get(`${apiPrefix}/google/connect`, requireAuth, (req, res, next) => {
    if (!isGoogleConfigured()) return res.status(503).json({ error: 'Google sign-in is not configured.' });
    // Stash a pending sheet append (set via POST /api/auth/google/connect-and-add) is already in session.
    passport.authenticate('google', {
      scope: GOOGLE_OAUTH_SCOPES,
      accessType: 'offline',
      prompt: 'consent',
    } as any)(req, res, next);
  });

  // Stash a pending sheet append in the session, then the client redirects to /api/auth/google/connect.
  app.post(`${apiPrefix}/google/pending-append`, requireAuth, (req, res) => {
    const card = req.body?.card;
    const sheetId = typeof req.body?.sheetId === 'number' ? req.body.sheetId : undefined;
    if (!card || typeof card !== 'object') {
      return res.status(400).json({ error: 'card is required' });
    }
    req.session.pendingSheetAppend = { card: card as CardRowInput, sheetId, createdAt: Date.now() };
    res.json({ ok: true });
  });

  // Email verification
  app.post(`${apiPrefix}/verify-email`, async (req, res) => {
    const token = String(req.body?.token || '');
    if (!token) return res.status(400).json({ error: 'Missing token' });
    const row = await consumeAuthToken(token, 'verify_email');
    if (!row) return res.status(400).json({ error: 'This verification link is invalid or has expired.' });
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, row.userId));
    res.json({ ok: true });
  });
  app.post(`${apiPrefix}/resend-verification`, requireAuth, async (req, res) => {
    const [u] = await db.select().from(users).where(eq(users.id, (req.user as any).id)).limit(1);
    if (!u || !u.email) return res.status(400).json({ error: 'No email on file' });
    if (u.emailVerifiedAt) return res.json({ ok: true, alreadyVerified: true });
    await sendVerificationEmail(u);
    res.json({ ok: true });
  });

  // Forgot / reset password
  app.post(`${apiPrefix}/forgot-password`, async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required' });
    const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    // Always respond OK to avoid leaking whether the email is registered.
    if (u && u.passwordHash) {
      const raw = await createAuthToken(u.id, 'reset_password', 60 * 60 * 1000);
      const link = `${APP_BASE_URL}/reset-password?token=${raw}`;
      const tpl = passwordResetEmail(u.displayName, link);
      sendEmail({ to: u.email!, ...tpl }).catch(err => console.error('[auth] reset email:', err));
    }
    res.json({ ok: true });
  });
  app.post(`${apiPrefix}/reset-password`, async (req, res) => {
    const token = String(req.body?.token || '');
    const password = String(req.body?.password || '');
    if (!token || password.length < 8) return res.status(400).json({ error: 'Invalid token or password too short.' });
    const row = await consumeAuthToken(token, 'reset_password');
    if (!row) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    const passwordHash = await bcrypt.hash(password, 12);
    await db.update(users).set({ passwordHash }).where(eq(users.id, row.userId));
    res.json({ ok: true });
  });

  app.post(`${apiPrefix}/change-password`, requireAuth, async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    const [u] = await db.select().from(users).where(eq(users.id, (req.user as any).id)).limit(1);
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (!u.passwordHash) {
      // Google-only account — allow setting an initial password without current.
      const passwordHash = await bcrypt.hash(newPassword, 12);
      await db.update(users).set({ passwordHash }).where(eq(users.id, u.id));
      return res.json({ ok: true, setInitialPassword: true });
    }
    const ok = await bcrypt.compare(currentPassword, u.passwordHash);
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect.' });
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.update(users).set({ passwordHash }).where(eq(users.id, u.id));
    res.json({ ok: true });
  });

  // Expose config (so client knows whether to show Google button)
  app.get(`${apiPrefix}/config`, (_req, res) => {
    res.json({ googleEnabled: isGoogleConfigured() });
  });

  // ── Per-user preferences ────────────────────────────────────────────────
  // Stored in users.preferences (JSONB). We merge with DEFAULT_USER_PREFERENCES
  // on every read so adding new keys later is a no-op for existing rows.
  app.get('/api/user/preferences', requireAuth, async (req, res) => {
    const [u] = await db.select().from(users).where(eq(users.id, (req.user as any).id)).limit(1);
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json({ preferences: readPreferences(u.preferences) });
  });

  app.patch('/api/user/preferences', requireAuth, async (req, res) => {
    const [u] = await db.select().from(users).where(eq(users.id, (req.user as any).id)).limit(1);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const current = readPreferences(u.preferences);
    // Merge partial patch into current prefs, then validate the full shape.
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    const next = userPreferencesSchema.safeParse({ ...current, ...patch });
    if (!next.success) {
      return res.status(400).json({ error: 'Invalid preferences', issues: next.error.issues });
    }
    await db.update(users).set({ preferences: next.data }).where(eq(users.id, u.id));
    res.json({ preferences: next.data });
  });
}

/**
 * Normalize the `users.preferences` JSONB value into a fully-populated
 * UserPreferences object. Rows that pre-date the column (or rows that
 * were written before a new key was added) may have `null` or a partial
 * shape — we always merge against defaults so callers see every key.
 *
 * Exported so server-side code (e.g. scan routes) can ask "is autoGrade on
 * for this user?" in one place instead of duplicating the merge logic.
 */
export function readPreferences(raw: unknown): UserPreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_USER_PREFERENCES };
  const parsed = userPreferencesSchema.safeParse({ ...DEFAULT_USER_PREFERENCES, ...raw });
  return parsed.success ? parsed.data : { ...DEFAULT_USER_PREFERENCES };
}

/**
 * Fetch a user's effective preferences. Anonymous callers (no user id)
 * get the defaults — e.g. auto-grading stays OFF for unauthenticated
 * requests, matching signed-in new-user behavior.
 */
export async function getUserPreferences(userId: number | undefined | null): Promise<UserPreferences> {
  if (!userId) return { ...DEFAULT_USER_PREFERENCES };
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return readPreferences(u?.preferences);
}
