// Per-user rate-limit gate + 429 backoff helper for Google Sheets writes.
//
// Google Sheets imposes a 60-write-per-minute-per-user quota. A 64-card
// bulk batch writes one row per card and trips that limit several
// rows in. The processor caught the resulting error and demoted those
// cards to review, surfacing as "1/3 of my batch landed in review".
//
// This module wraps Sheets write calls with two safety nets:
//
//   1. A rolling 60-second window gate that admits at most
//      MAX_WRITES_PER_MINUTE requests per user — set to 50 so we keep
//      10 requests of headroom for concurrent UI saves on the same user.
//
//   2. A 429-aware exponential backoff (2s, 4s, 8s, 16s, 30s; max 5
//      retries) that retries only true quota errors. Other failures
//      bubble up unchanged so the caller can demote-to-review.
//
// Both gates are in-memory and per-process. A multi-instance deploy
// would need a shared store (Redis), but the current Replit single-
// process layout makes this sufficient.

const MAX_WRITES_PER_MINUTE = 50;
const WINDOW_MS = 60_000;
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

const userWindows = new Map<number, number[]>();

function pruneWindow(timestamps: number[], now: number): number[] {
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < timestamps.length && timestamps[i] <= cutoff) i++;
  return i === 0 ? timestamps : timestamps.slice(i);
}

/**
 * Acquire a write slot for `userId`. Resolves immediately if the user
 * has fewer than MAX_WRITES_PER_MINUTE timestamps in the last 60 s,
 * otherwise sleeps until the oldest timestamp falls out of the window.
 *
 * Records the slot at acquisition time, not at call time, so a long
 * caller doesn't hold a slot it isn't using.
 */
export async function acquireSheetsWriteSlot(userId: number): Promise<void> {
  while (true) {
    const now = Date.now();
    let win = userWindows.get(userId) || [];
    win = pruneWindow(win, now);
    if (win.length < MAX_WRITES_PER_MINUTE) {
      win.push(now);
      userWindows.set(userId, win);
      return;
    }
    const wait = WINDOW_MS - (now - win[0]) + 25;
    userWindows.set(userId, win);
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

function isQuotaError(err: any): boolean {
  const status = err?.status ?? err?.code ?? err?.response?.status;
  if (status === 429) return true;
  const message = String(err?.message ?? err ?? '');
  return (
    /\b429\b/.test(message) ||
    /RESOURCE_EXHAUSTED/i.test(message) ||
    /rate.?limit/i.test(message) ||
    /quota/i.test(message)
  );
}

/**
 * Run `fn` (a Sheets API write) under the per-user rate limit, retrying
 * only on 429/quota errors with exponential backoff. Non-quota errors
 * fall through unchanged so the caller can demote-to-review.
 */
export async function withSheetsWriteGuard<T>(
  userId: number,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  let attempt = 0;
  while (true) {
    await acquireSheetsWriteSlot(userId);
    try {
      return await fn();
    } catch (err: any) {
      if (!isQuotaError(err) || attempt >= RETRY_DELAYS_MS.length) throw err;
      const delay = RETRY_DELAYS_MS[attempt++];
      console.warn(
        `[sheetsRateLimit] 429/quota on ${label} attempt ${attempt}, retrying in ${delay}ms: ${String(err?.message ?? err).slice(0, 200)}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
