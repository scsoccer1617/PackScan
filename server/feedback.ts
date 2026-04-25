// ─── Beta Feedback Sheet Append ─────────────────────────────────────────────
//
// All beta feedback funnels into a single Google Sheet owned by the admin
// (daniel.j.holley@gmail.com). Every submission appends one row on the
// sheet's first tab so the admin can read it as a flat log without filters
// or pivots.
//
// Design rationale:
//   - The feedback sheet is *not* per-user — it's a single admin-owned
//     spreadsheet whose ID lives in FEEDBACK_SHEET_ID. Testers do NOT need
//     to share or own anything; the server writes on the admin's behalf.
//   - We reuse the admin's existing OAuth tokens (already stored in
//     `users` keyed by email = ADMIN_EMAIL) instead of provisioning a
//     service account. This keeps the auth surface consistent with the
//     rest of the app's Sheets integration (server/googleSheets.ts) and
//     means we don't need a new credential to ship beta.
//   - Failure mode: if the admin hasn't connected Google yet, or the env
//     var is unset, /api/feedback returns 503 with a clear error so the
//     frontend can show a retry. We never silently drop feedback.

import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../shared/schema';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'daniel.j.holley@gmail.com').toLowerCase();

// Column order for the feedback sheet. Header row is written once at first
// append; subsequent appends just add a new row at the bottom. Keep this in
// sync with the values produced in `appendFeedbackRow`.
export const FEEDBACK_HEADERS = [
  'Timestamp',
  'User email',
  'User ID',
  'Category',
  'Message',
  'Page URL',
  'Last scan ID',
  'User agent',
];

export class FeedbackNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`Feedback sheet is not configured: ${reason}`);
  }
}

export interface FeedbackRow {
  userId: number | null;
  userEmail: string | null;
  category: string;
  message: string;
  pageUrl: string | null;
  lastScanId: number | string | null;
  userAgent: string | null;
}

async function getAdminOAuthClient(): Promise<OAuth2Client> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new FeedbackNotConfiguredError('GOOGLE_OAUTH_CLIENT_ID/SECRET missing');
  }
  // Find the admin row by email. The auth code lower-cases emails on insert,
  // and ADMIN_EMAIL is also lower-cased above.
  const [admin] = await db
    .select()
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL))
    .limit(1);
  if (!admin) {
    throw new FeedbackNotConfiguredError(
      `admin user (email=${ADMIN_EMAIL}) not found — sign in once to provision`,
    );
  }
  if (!admin.googleAccessToken && !admin.googleRefreshToken) {
    throw new FeedbackNotConfiguredError(
      `admin (${ADMIN_EMAIL}) has not connected Google OAuth yet`,
    );
  }
  const oauth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth.setCredentials({
    access_token: admin.googleAccessToken || undefined,
    refresh_token: admin.googleRefreshToken || undefined,
    expiry_date: admin.googleTokenExpiresAt
      ? new Date(admin.googleTokenExpiresAt).getTime()
      : undefined,
  });
  // Persist refreshed tokens back to the admin row. Mirrors the pattern in
  // server/googleSheets.ts so the admin stays connected indefinitely after
  // the first OAuth handshake.
  oauth.on('tokens', async (tokens) => {
    try {
      const update: any = {};
      if (tokens.access_token) update.googleAccessToken = tokens.access_token;
      if (tokens.refresh_token) update.googleRefreshToken = tokens.refresh_token;
      if (tokens.expiry_date) update.googleTokenExpiresAt = new Date(tokens.expiry_date);
      if (Object.keys(update).length) {
        await db.update(users).set(update).where(eq(users.id, admin.id));
      }
    } catch (err) {
      console.error('[feedback] failed to persist refreshed admin tokens:', err);
    }
  });
  return oauth;
}

// Idempotently ensure row 1 of the feedback sheet matches FEEDBACK_HEADERS.
// We only write the header when the sheet is empty so we don't overwrite a
// pinned/styled header the admin may have customized. If the existing first
// row has a different shape we leave it alone — feedback rows below still
// align column-for-column because they're appended in FEEDBACK_HEADERS order.
async function ensureHeaderRow(oauth: OAuth2Client, spreadsheetId: string): Promise<void> {
  const sheets = google.sheets({ version: 'v4', auth: oauth });
  try {
    const got = await sheets.spreadsheets.values.get({ spreadsheetId, range: '1:1' });
    const current = (got.data.values?.[0] || []) as string[];
    if (current.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'A1',
        valueInputOption: 'RAW',
        requestBody: { values: [FEEDBACK_HEADERS] },
      });
    }
  } catch (err) {
    console.warn('[feedback] ensureHeaderRow failed (continuing):', err);
  }
}

/**
 * Append a single feedback row to the configured feedback sheet. Throws
 * `FeedbackNotConfiguredError` when env/admin tokens aren't set up; callers
 * should map that to 503 so the frontend can prompt the admin to connect.
 */
export async function appendFeedbackRow(row: FeedbackRow): Promise<void> {
  const sheetId = process.env.FEEDBACK_SHEET_ID;
  if (!sheetId) {
    throw new FeedbackNotConfiguredError('FEEDBACK_SHEET_ID env var not set');
  }
  const oauth = await getAdminOAuthClient();
  await ensureHeaderRow(oauth, sheetId);
  const sheets = google.sheets({ version: 'v4', auth: oauth });
  // Build the row in FEEDBACK_HEADERS order. Coerce nulls to empty strings
  // so Sheets renders blank cells rather than the literal "null".
  const values: string[] = [
    new Date().toISOString(),
    row.userEmail ?? '',
    row.userId != null ? String(row.userId) : '',
    row.category || '',
    row.message || '',
    row.pageUrl ?? '',
    row.lastScanId != null ? String(row.lastScanId) : '',
    row.userAgent ?? '',
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'A1',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}
