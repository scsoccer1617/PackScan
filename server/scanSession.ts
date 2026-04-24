// Scan session cache — stores preliminary front-side OCR results keyed by a
// client-generated scanId so the main /api/analyze-card-dual-images handler
// can skip redundant Vision calls and the front analyzer when the user has
// already kicked off a preliminary scan on front capture.
//
// F-3a: Preliminary front-OCR during card flip.
//
// Storage is a simple in-memory Map with TTL + periodic GC. There is no
// persistence and no cross-process sharing — scan sessions are short-lived
// (seconds between front shutter and back shutter) and a single server
// process handles the whole flow today. If the cache is cleared (process
// restart) or the TTL expires before the final upload arrives, the main
// handler falls back to the existing behaviour (runs front OCR + analyzer
// inline) with zero functional regression.

import type { CardFormValues } from '@shared/schema';
import type { CatalogLookupResult } from './sportscardspro';
import type { FoilDetectionResult } from './visualFoilDetector';

export interface PendingScanEntry {
  /** Partial front-side analyzer output (CardFormValues subset).
   *  For image scans this is the analyzer output; for voice scans this is
   *  the Gemini-extracted fields mapped into CardFormValues shape. Used by
   *  the speculative SCP sanity check to compare player identity before/after
   *  the user may have edited fields. */
  frontResult: Partial<CardFormValues>;
  /** Raw Google Vision OCR text for the front image. Image scans only.
   *  Voice scans leave this empty. */
  frontOCRText: string;
  /** Rotation-normalized front image buffer — reused as-is by the main
   *  dual-image handler so it doesn't re-run `sharp.rotate()` on the same
   *  bytes. Absent for voice scans, which have no image. */
  frontImageBuffer?: Buffer;
  /** F-3b: Speculative SportsCardsPro lookup, fired in background during
   *  preliminary if the front OCR had enough identifying fields. Populated
   *  asynchronously via `updatePendingScan` after the preliminary response
   *  has already returned to the client — consumers must tolerate this
   *  being `undefined` (lookup still in flight) or a miss result. */
  scpResult?: CatalogLookupResult | null;
  /** F-3c: Preliminary visual-foil hint. Computed during the preliminary
   *  endpoint by running `detectFoilFromImage` on the front image buffer
   *  with `isNumbered: false` (we don't have the back-side serial yet).
   *  The main dual-image handler consumes this to skip the second visual
   *  foil Vision call inside `combineCardResults`. When this is present
   *  the hint is treated as authoritative for visual detection; FoilDB
   *  validation / rejection logic downstream still runs against it using
   *  whatever back-side context is available when the main handler runs. */
  visualFoilPrelim?: FoilDetectionResult | null;
  /** Absolute epoch ms at which this entry becomes invalid. */
  expiresAt: number;
}

// ── TTL / GC configuration ────────────────────────────────────────────────
// 60 s is generous: a typical scan flip is 2–5 s, and we want to cover users
// who pause between front and back shutters. Entries are deleted on read
// (consume-once semantics) and also swept by a periodic GC in case the final
// upload never arrives (e.g. user cancels the scan or the network drops).
const TTL_MS = 60_000;
const GC_INTERVAL_MS = 30_000;

const pendingScans = new Map<string, PendingScanEntry>();

// Periodic GC — `unref()` so this timer doesn't keep the Node process alive
// on shutdown.
const gcTimer = setInterval(() => {
  const now = Date.now();
  let removed = 0;
  // `.forEach` avoids the `--downlevelIteration` requirement that a `for..of`
  // over a Map would impose under this tsconfig's target.
  const toDelete: string[] = [];
  pendingScans.forEach((entry, id) => {
    if (entry.expiresAt <= now) toDelete.push(id);
  });
  for (const id of toDelete) {
    pendingScans.delete(id);
    removed++;
  }
  if (removed > 0) {
    console.log(`[scanSession] GC swept ${removed} expired entr${removed === 1 ? 'y' : 'ies'}; ${pendingScans.size} remaining`);
  }
}, GC_INTERVAL_MS);
if (typeof gcTimer.unref === 'function') gcTimer.unref();

/** Stash a preliminary front-side result for later consumption. */
export function putPendingScan(
  scanId: string,
  data: Omit<PendingScanEntry, 'expiresAt'>,
): void {
  pendingScans.set(scanId, {
    ...data,
    expiresAt: Date.now() + TTL_MS,
  });
  console.log(`[scanSession] stored scanId=${scanId} (${pendingScans.size} pending)`);
}

/**
 * Merge a partial patch into an existing pending entry in place. Used by F-3b
 * to attach the speculative SCP result once its background lookup resolves.
 * Silent no-op if the entry has already been evicted (TTL, GC, or a retry
 * minted a new scanId) — the speculative result is purely an optimization.
 */
export function updatePendingScan(
  scanId: string,
  patch: Partial<Omit<PendingScanEntry, 'expiresAt'>>,
): void {
  const entry = pendingScans.get(scanId);
  if (!entry) return;
  // Preserve TTL — updating shouldn't extend the window.
  if (entry.expiresAt <= Date.now()) {
    pendingScans.delete(scanId);
    return;
  }
  Object.assign(entry, patch);
}

/**
 * Fetch a preliminary entry WITHOUT consuming it. Used when the main handler
 * might be called multiple times in the same session (defensive), or when we
 * want to peek before committing to the short-circuit path.
 */
export function peekPendingScan(scanId: string): PendingScanEntry | null {
  const entry = pendingScans.get(scanId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    pendingScans.delete(scanId);
    return null;
  }
  return entry;
}

/**
 * Fetch AND remove a preliminary entry. This is the primary read path — the
 * main dual-image handler consumes the cache exactly once per scan so retries
 * re-run the full pipeline (safer than serving stale cached OCR).
 */
export function takePendingScan(scanId: string): PendingScanEntry | null {
  const entry = peekPendingScan(scanId);
  if (!entry) return null;
  pendingScans.delete(scanId);
  console.log(`[scanSession] consumed scanId=${scanId} (${pendingScans.size} remaining)`);
  return entry;
}

/**
 * Wait up to `timeoutMs` for a preliminary entry to appear. Resolves with
 * the entry if/when it's written, or `null` on timeout. Used by the main
 * handler to briefly wait for an in-flight preliminary call rather than
 * racing ahead and duplicating OCR work.
 */
export async function waitForPendingScan(
  scanId: string,
  timeoutMs = 2000,
): Promise<PendingScanEntry | null> {
  const immediate = peekPendingScan(scanId);
  if (immediate) return immediate;

  const deadline = Date.now() + timeoutMs;
  const POLL_MS = 50;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const entry = peekPendingScan(scanId);
    if (entry) return entry;
  }
  return null;
}

/** Test / diagnostic helper — snapshot current cache size. */
export function pendingScanCount(): number {
  return pendingScans.size;
}
