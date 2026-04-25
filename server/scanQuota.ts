// ─── Scan Quota (Beta) ──────────────────────────────────────────────────────
//
// During the beta we cap each user at `users.scanLimit` total successful card
// analyses (default 50, see DEFAULT_BETA_SCAN_LIMIT in shared/schema.ts). The
// counter (`users.scanCount`) increments by 1 every time an analyze endpoint
// returns a result the user actually keeps — Single Scan, Bulk Scan, and the
// legacy single-image endpoint all roll up to the same counter so it reflects
// "cards processed" regardless of which path the user came through.
//
// Design rules:
//   1. Only authenticated users are quota-gated. Anonymous traffic (e.g.
//      health checks, demo paths) bypasses the quota — auth is a separate
//      concern handled by `requireAuth` upstream of these helpers.
//   2. The quota check is best-effort: if the DB query fails, we let the
//      scan proceed (fail open) and log. We never want a transient DB blip
//      to block a paying-or-soon-to-pay dealer mid-batch.
//   3. The increment runs only AFTER a successful analysis. We never charge
//      a card against the quota for 4xx/5xx responses, missing-back-image
//      validation failures, or thrown errors.
//   4. Bulk-scan increments per item (not per batch) so a 30-card batch
//      against a user with 5 remaining stops cleanly at item 5 + marks the
//      remainder `skipped` with a `quota_exhausted` reason.
//
// The admin page (POST /api/admin/users/:id/limit, /reset, /bump-all) writes
// directly to scanLimit/scanCount; it does not go through these helpers.

import type { Request, Response, NextFunction } from 'express';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../shared/schema';

export interface ScanQuotaState {
  /** Cards already counted against the user's quota. */
  used: number;
  /** Cap for this user. */
  limit: number;
  /** True when used >= limit (no more scans allowed). */
  exhausted: boolean;
  /** Cards remaining (>= 0). */
  remaining: number;
  /**
   * True for users exempt from the beta cap entirely (currently the admin
   * account). Quota gates skip the 429 when this is set; the UI pill hides
   * itself because `limit` stays 0.
   */
  unlimited?: boolean;
}

const QUOTA_NOT_FOUND: ScanQuotaState = {
  used: 0,
  limit: 0,
  exhausted: false,
  remaining: 0,
};

// Admin email mirrors the same default used by feedback.ts and routes.ts so a
// single ADMIN_EMAIL env var (case-insensitive) controls admin gating AND
// scan-quota exemption together. Beta testers stay capped at users.scanLimit;
// only the admin runs unlimited so dev/QA can scan freely without burning
// through testers' quotas.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'daniel.j.holley@gmail.com').toLowerCase();

/**
 * Read the current quota state for a user. Returns a fail-open shape (limit=0,
 * exhausted=false) when the user row can't be found — anonymous and unknown
 * users are not quota-gated. Errors bubble; callers decide whether to fail
 * open or closed.
 *
 * The admin user (email === ADMIN_EMAIL) is reported as `unlimited:true` with
 * limit=0 so quota gates skip the cap and the usage pill hides itself.
 */
export async function getScanQuota(userId: number | undefined | null): Promise<ScanQuotaState> {
  if (!userId) return QUOTA_NOT_FOUND;
  const [row] = await db
    .select({ limit: users.scanLimit, count: users.scanCount, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return QUOTA_NOT_FOUND;
  const used = row.count ?? 0;
  const limit = row.limit ?? 0;
  const isAdmin = (row.email || '').toLowerCase() === ADMIN_EMAIL;
  if (isAdmin) {
    // Admin runs uncapped. We still report the actual used count for diagnostic
    // purposes (admin's own scan history is still useful), but limit=0 hides
    // the pill and exhausted=false ensures every gate passes.
    return {
      used,
      limit: 0,
      exhausted: false,
      remaining: 0,
      unlimited: true,
    };
  }
  return {
    used,
    limit,
    exhausted: used >= limit,
    remaining: Math.max(0, limit - used),
  };
}

/**
 * Increment the user's scan counter by 1. Called AFTER a successful analyze.
 * Failures are logged and swallowed — we never want bookkeeping to break a
 * scan that already produced a result. Returns the new count for callers
 * that want to surface "X / 50" inline.
 *
 * Uses a SQL expression instead of a read-modify-write so two concurrent
 * scans (e.g. an in-flight Single Scan while bulk is processing) can't
 * stomp each other's increment.
 */
export async function incrementScanCount(userId: number | undefined | null): Promise<number | null> {
  if (!userId) return null;
  try {
    const [row] = await db
      .update(users)
      .set({ scanCount: sql`${users.scanCount} + 1` })
      .where(eq(users.id, userId))
      .returning({ count: users.scanCount });
    return row?.count ?? null;
  } catch (err) {
    console.warn(`[scanQuota] incrementScanCount(user=${userId}) failed:`, err);
    return null;
  }
}

/**
 * Express middleware: 429s when the authenticated user has hit their cap.
 * Anonymous requests fall through (auth middleware should run first if the
 * route requires login). Fails open on DB errors — see Design rules above.
 *
 * Response body shape on 429: `{ error: 'limit_reached', limit, used }`.
 * The `Retry-After` header is intentionally omitted because the limit is
 * not time-based; the user must be granted more scans by the admin.
 */
export async function requireScanQuota(req: Request, res: Response, next: NextFunction) {
  const userId = (req.user as any)?.id as number | undefined;
  if (!userId) return next();
  try {
    const quota = await getScanQuota(userId);
    // Admin / unlimited users always pass.
    if (quota.unlimited) return next();
    if (quota.limit > 0 && quota.exhausted) {
      return res.status(429).json({
        error: 'limit_reached',
        limit: quota.limit,
        used: quota.used,
      });
    }
  } catch (err) {
    console.warn(`[scanQuota] requireScanQuota(user=${userId}) failed open:`, err);
  }
  return next();
}
