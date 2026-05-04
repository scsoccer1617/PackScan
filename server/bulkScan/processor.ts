// Bulk-scan batch processor.
//
// Orchestrates:
//   1. List Drive inbox folder for a user.
//   2. Insert a scan_batches row.
//   3. For each page: download, probe orientation, classify side.
//   4. Pair pages (position-based + classifier verification).
//   5. For each pair: run dual-side analyzer, evaluate confidence gate.
//      • auto_save → append to user's Google Sheet + move files to
//        processed folder.
//      • review    → persist the analysis snapshot so the review UI can
//        replay it without re-running OCR.
//   6. Mark the batch completed.
//
// Resumable: on process startup, any batch still in 'running' is requeued
// via `resumeRunningBatches()`. Any items in 'processing' inside that
// batch are reset to 'pending' so the fresh worker picks them up.
//
// Concurrency: pairs process serially by default. OCR + SCP + CardDB are
// all I/O bound and hitting them concurrently multiplies rate-limit risk
// without a huge win on batches of 50–200 pairs. If dealers bring 10K-card
// batches we can revisit with a small PQueue.

import { eq, and, inArray, asc } from 'drizzle-orm';
import { db } from '@db';
import {
  scanBatches,
  scanBatchItems,
  googleDriveFolders,
  type ScanBatch,
  type ScanBatchItem,
} from '@shared/schema';

import { listInboxImages, downloadFile, moveFile, type DriveImageFile } from './driveClient';
import { or, isNotNull } from 'drizzle-orm';
import { classifyCardSide } from './sideClassifier';
import { detectOrientation } from './orientation';
import { pairPages, groupFilesByDuplexBatch, type ScanPage, type PairedScan } from './pairing';
import { evaluateConfidence, isCardDbCorroboration } from './confidenceGate';
import { BatchTimingsRecorder } from './timingsRecorder';
import { normalizeImageOrientation } from '../dualSideOCR';
import { lookupCard as cardDbLookup } from '../cardDatabaseService';
import { isCardDbLookupEnabled } from '../featureFlags';
import { appendCardRow, appendCardRowsBatch, type CardRowInput } from '../googleSheets';
import { getEbaySearchUrl } from '../ebayService';
import { applyTopps2026ImprintOverride } from '../yearOverrides';
import { getScanQuota, incrementScanCount } from '../scanQuota';
import { logUserScan, type ScanFieldValues } from '../userScans';
// p-queue is ESM-only; pull it via a typed `as any` to keep typecheck quiet
// without changing tsconfig module resolution.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import PQueue from 'p-queue';

/**
 * Project the analyzer's loose `analysis` blob down to the ScanFieldValues
 * shape used by the user-scans logger. Mirrors the projection used in the
 * single-card scan flow (ScanResult.tsx → snapshotFromCardData) so a row
 * from bulk-scan is comparable to a row from /scan in /admin/scans.
 */
function analysisToScanFieldValues(a: Record<string, any>): ScanFieldValues {
  return {
    sport: a.sport ?? null,
    playerFirstName: a.playerFirstName ?? null,
    playerLastName: a.playerLastName ?? null,
    brand: a.brand ?? null,
    collection: a.collection ?? null,
    set: a.set ?? null,
    cardNumber: a.cardNumber ?? null,
    year: typeof a.year === 'number' ? a.year : (a.year ? Number.parseInt(String(a.year), 10) || null : null),
    variant: a.variant ?? null,
    team: a.team ?? null,
    cmpNumber: a.cmpNumber ?? null,
    serialNumber: a.serialNumber ?? null,
    foilType: a.foilType ?? null,
    isRookie: typeof a.isRookieCard === 'boolean' ? a.isRookieCard : null,
    isAuto: typeof a.isAutographed === 'boolean' ? a.isAutographed : null,
    isNumbered: typeof a.isNumbered === 'boolean' ? a.isNumbered : null,
    isFoil: null,
  };
}

// ── Batch lifecycle ──────────────────────────────────────────────────────

export interface CreateBatchOptions {
  userId: number;
  dryRun?: boolean;
  /** Override the user's configured inbox folder (mostly for testing). */
  inboxFolderOverride?: string;
  /** Override the user's configured processed folder. */
  processedFolderOverride?: string;
}

/**
 * Create a new scan batch row and enqueue it. Returns the created row so
 * callers can show the dealer an immediate "Batch #123 queued" response
 * while the worker processes in the background.
 */
export async function createBatch(opts: CreateBatchOptions): Promise<ScanBatch> {
  const folders = await getOrInitFolders(opts.userId);
  const inboxFolderId = opts.inboxFolderOverride || folders?.inboxFolderId || null;
  const processedFolderId = opts.processedFolderOverride || folders?.processedFolderId || null;
  if (!inboxFolderId) {
    throw new Error('No Drive inbox folder configured for this user.');
  }
  const [batch] = await db.insert(scanBatches).values({
    userId: opts.userId,
    status: 'queued',
    sourceFolderId: inboxFolderId,
    processedFolderId,
    dryRun: !!opts.dryRun,
  }).returning();
  return batch;
}

export async function getOrInitFolders(userId: number) {
  const [row] = await db.select().from(googleDriveFolders).where(eq(googleDriveFolders.userId, userId)).limit(1);
  return row || null;
}

/**
 * Normalize a folder input: trim, pull the id out of a Drive URL if one was
 * pasted (defense-in-depth — the client already extracts, but we can't
 * assume that for direct API callers), empty string → null.
 */
function normalizeFolderInput(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = String(v).trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  return trimmed;
}

export async function setUserFolders(
  userId: number,
  input: { inboxFolderId?: string | null; processedFolderId?: string | null },
) {
  // Treat undefined as "don't touch" but null / empty-string as "clear".
  const inbox = 'inboxFolderId' in input ? normalizeFolderInput(input.inboxFolderId) : undefined;
  const processed = 'processedFolderId' in input ? normalizeFolderInput(input.processedFolderId) : undefined;

  const existing = await getOrInitFolders(userId);
  if (existing) {
    const [updated] = await db
      .update(googleDriveFolders)
      .set({
        inboxFolderId: inbox === undefined ? existing.inboxFolderId : inbox,
        processedFolderId: processed === undefined ? existing.processedFolderId : processed,
        updatedAt: new Date(),
      })
      .where(eq(googleDriveFolders.userId, userId))
      .returning();
    console.log(`[bulkScan] setUserFolders(user=${userId}): updated → inbox=${updated.inboxFolderId}, processed=${updated.processedFolderId}`);
    return updated;
  }
  const [created] = await db
    .insert(googleDriveFolders)
    .values({
      userId,
      inboxFolderId: inbox ?? null,
      processedFolderId: processed ?? null,
    })
    .returning();
  console.log(`[bulkScan] setUserFolders(user=${userId}): inserted → inbox=${created.inboxFolderId}, processed=${created.processedFolderId}`);
  return created;
}

// ── Resume on startup ────────────────────────────────────────────────────

/**
 * Called once from server/index.ts on process start. Any batch that was
 * 'running' when the old process died is requeued, and any items inside
 * it that were 'processing' reset to 'pending'. This is the only place
 * we touch the DB state machine from outside a worker call, so the worker
 * can assume a clean slate when it claims a batch.
 */
export async function resumeRunningBatches(): Promise<number> {
  const stuck = await db.select().from(scanBatches).where(eq(scanBatches.status, 'running'));
  if (stuck.length === 0) return 0;
  const stuckIds = stuck.map(b => b.id);
  await db
    .update(scanBatchItems)
    .set({ status: 'pending' })
    .where(and(inArray(scanBatchItems.batchId, stuckIds), eq(scanBatchItems.status, 'processing')));
  await db
    .update(scanBatches)
    .set({ status: 'queued' })
    .where(eq(scanBatches.status, 'running'));
  console.log(`[bulkScan] Resumed ${stuck.length} running batch(es) on startup.`);
  // Kick off the worker for each stuck batch. Intentionally fire-and-forget —
  // runBatch catches its own errors and writes them to the batch row.
  for (const batch of stuck) {
    runBatch(batch.id).catch(err =>
      console.error(`[bulkScan] resume runBatch(${batch.id}) failed:`, err),
    );
  }
  return stuck.length;
}

// ── Sheets append queue ──────────────────────────────────────────────────
//
// Per-batch buffer for auto_save Sheet writes. Replaces the per-pair
// appendCardRow call so a 64-card batch makes ~3 batched API requests
// instead of 64 individual ones. Stays well under the
// 60-write-per-minute-per-user quota that was causing late pairs in
// large batches to 429-fail and demote to review.
//
// Caller flow:
//   1. processItem hits its auto_save branch
//   2. processItem calls queue.enqueue(item.id, card) and awaits the
//      returned promise (resolves on success, rejects on flush failure)
//   3. queue accumulates rows; flushes when CHUNK_SIZE rows are buffered
//      OR FLUSH_INTERVAL_MS has elapsed since the first buffered row OR
//      runBatch calls queue.drain() at end-of-batch
//   4. flush calls appendCardRowsBatch (rate-limit-guarded + 429 retry)
//      and resolves/rejects each enqueued promise based on the API
//      result. On failure every row in the chunk is rejected with the
//      same error so processItem demotes-to-review like before.
class SheetsAppendQueue {
  private readonly userId: number;
  private buffer: { itemId: number; card: CardRowInput; resolve: () => void; reject: (e: Error) => void }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private static readonly CHUNK_SIZE = 25;
  private static readonly FLUSH_INTERVAL_MS = 3_000;

  constructor(userId: number) {
    this.userId = userId;
  }

  enqueue(itemId: number, card: CardRowInput): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.buffer.push({ itemId, card, resolve, reject });
      if (this.buffer.length >= SheetsAppendQueue.CHUNK_SIZE) {
        this.scheduleFlush(0);
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.scheduleFlush(0), SheetsAppendQueue.FLUSH_INTERVAL_MS);
      }
    });
  }

  /** Drain on end-of-batch. Resolves once all queued rows have been flushed. */
  async drain(): Promise<void> {
    this.scheduleFlush(0);
    await this.flushing;
  }

  private scheduleFlush(_delay: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Chain onto the previous flush so chunks don't overlap.
    this.flushing = this.flushing.then(() => this.flushOnce());
  }

  private async flushOnce(): Promise<void> {
    if (this.buffer.length === 0) return;
    const slice = this.buffer.splice(0, SheetsAppendQueue.CHUNK_SIZE);
    try {
      await appendCardRowsBatch(this.userId, slice.map((s) => s.card));
      for (const s of slice) s.resolve();
    } catch (err: any) {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const s of slice) s.reject(e);
    }
    // If more rows arrived (or remained), keep draining.
    if (this.buffer.length > 0) {
      this.flushing = this.flushing.then(() => this.flushOnce());
    }
  }
}

// ── Worker ───────────────────────────────────────────────────────────────

/**
 * Run one batch end-to-end. Safe to call concurrently per batch id — the
 * status check at the top causes later callers to bail if another worker
 * is already processing the same batch.
 */
export async function runBatch(batchId: number): Promise<void> {
  const [batch] = await db.select().from(scanBatches).where(eq(scanBatches.id, batchId)).limit(1);
  if (!batch) {
    console.warn(`[bulkScan] runBatch(${batchId}): batch not found`);
    return;
  }
  if (batch.status === 'completed' || batch.status === 'failed') {
    console.log(`[bulkScan] runBatch(${batchId}): already ${batch.status}, skipping`);
    return;
  }
  if (batch.status === 'running') {
    console.log(`[bulkScan] runBatch(${batchId}): another worker is already running this batch`);
    return;
  }

  await db.update(scanBatches).set({ status: 'running' }).where(eq(scanBatches.id, batchId));

  // Stage-timing telemetry: persisted to scan_batches.timings via debounced
  // writes (~1 s) so production diagnostics survive log-stream issues. The
  // recorder is fire-and-forget — every method updates an in-memory payload
  // synchronously and schedules a flush; we never await on the hot path.
  const timings = new BatchTimingsRecorder(batchId);

  try {
    let processed = 0;
    let reviews = 0;
    // Per-batch sheets append queue. Auto-save pairs hand rows to this
    // queue and await the resulting promise; the queue flushes in
    // chunks (CHUNK_SIZE or FLUSH_INTERVAL_MS) via the rate-limit-guarded
    // appendCardRowsBatch. drain() runs at end-of-batch below.
    const sheetsQueue = new SheetsAppendQueue(batch.userId);
    // Beta scan quota: track remaining headroom locally so we can stop the
    // loop cleanly the moment we run out, without making a DB round-trip
    // before every item. We re-fetch once at the top of the batch and keep
    // it in sync with the increments we issue below. Items that finish
    // before quota check (auto_saved/review/skipped from a previous run)
    // do NOT decrement remaining — they were already counted in their
    // original run via incrementScanCount.
    const initialQuota = await getScanQuota(batch.userId);
    let remaining = initialQuota.limit > 0 ? initialQuota.remaining : Number.POSITIVE_INFINITY;
    let quotaHit = false;

    // C3: Process pending items 4-wide via PQueue. processItem is dominated
    // by I/O (Drive download, Google Vision, Gemini Flash, SCP, CardDB,
    // eBay Browse, Sheets append, Drive move) so concurrency is the right
    // lever — quota headroom on each upstream API was verified before
    // settling on 4. Already-terminal items (auto_saved/review/skipped/
    // failed from a prior run) just rebuild counters and don't queue.
    //
    // Counter writes must be atomic: `processed`, `reviews`, and
    // `remaining` are read-modify-write under concurrency, and the
    // `scanBatches` UPDATE must reflect a consistent snapshot. A simple
    // Promise-chained mutex serializes those critical sections without
    // pulling a second dep.
    let counterMutex: Promise<void> = Promise.resolve();
    const withCounterLock = async <T>(fn: () => Promise<T> | T): Promise<T> => {
      const prev = counterMutex;
      let release!: () => void;
      counterMutex = new Promise<void>((res) => { release = res; });
      try {
        await prev;
        return await fn();
      } finally {
        release();
      }
    };
    const flushCounters = () =>
      db
        .update(scanBatches)
        .set({ processedCount: processed, reviewQueueCount: reviews })
        .where(eq(scanBatches.id, batchId));

    // Phase 2 PQueue. Built up-front so the streaming Phase 1 callback
    // (perf/bulk-stream-phase1) can enqueue pairs as they finish discovery
    // — first pair starts processing seconds after kickoff instead of
    // after Phase 1 completes for every file.
    //
    // Concurrency=8: PR #186 telemetry on a 74-file / 37-pair batch
    // measured Gemini at mean 17.9s / median 17.5s per pair, so 4-wide
    // Phase 2 spent ~218s in queue alone. 37 × 18s / 8 ≈ 83s — Gemini
    // imposes per-minute, not concurrent, rate limits and 8 in flight
    // is well inside that envelope. The Gemini call site has 429
    // exponential-backoff retry (1s/2s/4s, 3 attempts) wrapped in
    // server/dualSideOCR.ts so a transient burst can't fail a pair.
    const queue = new (PQueue as any)({ concurrency: 8 });

    const enqueueItem = (item: ScanBatchItem) => {
      queue.add(async () => {
        // Quota check is taken under the lock so we don't over-issue past
        // the user's remaining budget when 4 items race each other.
        const decision = await withCounterLock(() => {
          if (remaining <= 0) {
            quotaHit = true;
            return 'skip' as const;
          }
          if (Number.isFinite(remaining)) remaining = Math.max(0, remaining - 1);
          return 'go' as const;
        });
        if (decision === 'skip') {
          await db
            .update(scanBatchItems)
            .set({
              status: 'skipped',
              reviewReasons: [...(asStringArray(item.reviewReasons)), 'quota_exhausted'],
              processedAt: new Date(),
            })
            .where(eq(scanBatchItems.id, item.id));
          await withCounterLock(async () => {
            processed++;
            await flushCounters();
          });
          return;
        }
        const pairKey = `pair-${item.position}`;
        timings.recordPairUpdate(pairKey, { startedAt: Date.now() });
        const tPair = Date.now();
        try {
          const outcome = await processItem(batch, item, timings, pairKey, sheetsQueue);
          timings.recordPairUpdate(pairKey, { totalProcessMs: Date.now() - tPair });
          await incrementScanCount(batch.userId);
          await withCounterLock(async () => {
            if (outcome === 'review') reviews++;
            processed++;
            await flushCounters();
          });
        } catch (err: any) {
          console.error(`[bulkScan] processItem(${item.id}) failed:`, err);
          timings.recordPairUpdate(pairKey, {
            totalProcessMs: Date.now() - tPair,
            error: err?.message || String(err),
          });
          await db
            .update(scanBatchItems)
            .set({
              status: 'failed',
              errorMessage: err?.message || String(err),
              processedAt: new Date(),
            })
            .where(eq(scanBatchItems.id, item.id));
          await withCounterLock(async () => {
            processed++;
            // Failure didn't bill the user — refund the speculative
            // `remaining` decrement we issued before processItem ran.
            if (Number.isFinite(remaining)) remaining += 1;
            await flushCounters();
          });
        }
      });
    };

    // Load existing items (on resume) OR stream discovery into the
    // Phase 2 queue as pairs become ready.
    const existing = await db
      .select()
      .from(scanBatchItems)
      .where(eq(scanBatchItems.batchId, batchId))
      .orderBy(asc(scanBatchItems.position));

    if (existing.length > 0) {
      // Resume path: rebuild counters from terminal statuses, enqueue the
      // rest. No streaming needed because Phase 1 already ran.
      for (const item of existing) {
        if (item.status === 'auto_saved' || item.status === 'review' || item.status === 'skipped' || item.status === 'failed') {
          if (item.status === 'review') reviews++;
          if (item.status === 'auto_saved' || item.status === 'review' || item.status === 'skipped') processed++;
          continue;
        }
        enqueueItem(item);
      }
    } else {
      // Fresh batch: stream pairs into Phase 2 the moment they finish
      // Phase 1. discoverAndPlanItems' Phase 1 PQueue runs independently
      // of `queue` (4 + 4 = 8 max in flight) so the two phases overlap.
      await discoverAndPlanItems(batch, (item) => {
        timings.recordPairEnqueued(`pair-${item.position}`);
        enqueueItem(item);
      }, timings);
    }
    await queue.onIdle();
    // Flush any auto_save rows that are still buffered (last partial
    // chunk and/or rows that arrived after the final timer-based flush).
    // processItem's promises must all resolve/reject before we mark the
    // batch completed so DB row statuses are accurate.
    await sheetsQueue.drain();
    if (quotaHit) {
      console.log(`[bulkScan] Batch ${batchId} reached scan quota for user ${batch.userId}; remaining items marked skipped.`);
    }

    await db
      .update(scanBatches)
      .set({ status: 'completed', completedAt: new Date(), processedCount: processed, reviewQueueCount: reviews })
      .where(eq(scanBatches.id, batchId));
    timings.recordFinished();
    await timings.close();
    console.log(`[bulkScan] Batch ${batchId} complete: ${processed} processed, ${reviews} in review.`);
  } catch (err: any) {
    console.error(`[bulkScan] runBatch(${batchId}) fatal:`, err);
    timings.recordFinished();
    await timings.close();
    await db
      .update(scanBatches)
      .set({
        status: 'failed',
        errorMessage: err?.message || String(err),
        completedAt: new Date(),
      })
      .where(eq(scanBatches.id, batchId));
  }
}

/**
 * Discover inbox files, run orientation + classification up front so
 * pairing has the signals it needs, then persist one scan_batch_items row
 * per pair. Returns the inserted items so the caller can iterate.
 *
 * Streaming design (perf/bulk-stream-phase1): Phase 1 work runs 4-wide
 * via PQueue, and as soon as any two consecutive pages (positions
 * 2k+1 and 2k+2) have both finished Phase 1 we pair-and-insert that row
 * immediately and fire `onItemReady`. The caller (runBatch) uses that
 * callback to enqueue Phase 2 work without waiting for the rest of
 * Phase 1 — so the first pair starts processing seconds after kickoff
 * instead of after every file has been downloaded + Vision-probed.
 *
 * Design note: we pay the full orientation-probe + Vision cost during
 * discovery so the item rows can carry pre-computed OCR text + side
 * classification. That means a resumed batch skips the expensive probe
 * phase on second run.
 */
async function discoverAndPlanItems(
  batch: ScanBatch,
  onItemReady?: (item: ScanBatchItem) => void,
  timings?: BatchTimingsRecorder,
): Promise<ScanBatchItem[]> {
  if (!batch.sourceFolderId) throw new Error('Batch has no source folder');
  const tList = Date.now();
  const rawFiles = await listInboxImages(batch.userId, batch.sourceFolderId);
  const listMs = Date.now() - tList;
  console.log(`[bulkScan] batch ${batch.id}: listInboxImages → ${rawFiles.length} file(s) in ${listMs}ms`);
  timings?.recordListInboxImages(listMs, rawFiles.length);

  // Dedup against any Drive file this user has already seen in a prior
  // batch. The processor moves successful pairs to the processed folder,
  // so those drop out of the inbox listing on their own — but review /
  // skipped / failed items stay in the inbox by design (so the dealer can
  // view them during review). Without this guard, every Sync would
  // re-enqueue those same files and write duplicate rows on re-run.
  const seenRows = await db
    .select({ back: scanBatchItems.backFileId, front: scanBatchItems.frontFileId })
    .from(scanBatchItems)
    .innerJoin(scanBatches, eq(scanBatchItems.batchId, scanBatches.id))
    .where(and(
      eq(scanBatches.userId, batch.userId),
      or(isNotNull(scanBatchItems.backFileId), isNotNull(scanBatchItems.frontFileId)),
    ));
  const seenFileIds = new Set<string>();
  for (const row of seenRows) {
    if (row.back) seenFileIds.add(row.back);
    if (row.front) seenFileIds.add(row.front);
  }
  const dedupFiles = rawFiles.filter(f => !seenFileIds.has(f.id));
  const skipped = rawFiles.length - dedupFiles.length;
  if (skipped > 0) {
    console.log(`[bulkScan] Batch ${batch.id}: skipping ${skipped} previously-seen file(s) in inbox.`);
  }

  // Group Epson duplex pages by their filename prefix BEFORE pairing so
  // a multi-job inbox doesn't produce front+front / back+back pairs from
  // interleaved createdTime ordering. Returns a list with possible
  // `null` slots (padding after odd-count groups); those slots produce
  // orphan pairs and never cross a batch boundary.
  const files: (DriveImageFile | null)[] = groupFilesByDuplexBatch(dedupFiles);

  // Real-file count drives both the DB `fileCount` and the early-exit
  // guard. Padding slots don't count.
  const realFileCount = files.reduce((n, f) => n + (f ? 1 : 0), 0);
  if (realFileCount === 0) {
    await db.update(scanBatches).set({ fileCount: 0 }).where(eq(scanBatches.id, batch.id));
    return [];
  }
  await db.update(scanBatches).set({ fileCount: realFileCount }).where(eq(scanBatches.id, batch.id));

  // Phase 1: download + EXIF normalize + orient + classify every page
  // 4-wide. Each page is stored in a position-indexed slot. After every
  // store we check whether the page's pair-partner has also landed; if
  // so we pair-and-insert that row immediately and fire `onItemReady`
  // so the caller's Phase 2 queue can start processing it right away.
  // This streams pairs into Phase 2 instead of waiting for the entire
  // Phase 1 loop to finish.
  const pages: (ScanPage<DriveImageFile> | undefined)[] = new Array(files.length);
  // Slots created by groupFilesByDuplexBatch's odd-group padding. These
  // are "done but absent" — the pair logic must treat them as missing
  // (so the sibling becomes a trailing orphan) without waiting for any
  // Phase 1 work to land in them.
  const paddingSlots = new Set<number>();
  for (let i = 0; i < files.length; i++) if (files[i] === null) paddingSlots.add(i);
  const inserted: ScanBatchItem[] = [];
  // Tracks which pair indices (keyed by leftIdx) have already been emitted
  // so we can't accidentally insert the same pair row twice. Without this,
  // two completing siblings can race the slot writes (which happen outside
  // the mutex): sibling A enters the mutex, sees both slots filled because
  // sibling B's slot write landed before A acquired the lock, emits; then
  // sibling B enters the mutex, also sees both filled, and emits again —
  // producing duplicate scan_batch_items rows that flow through Phase 2
  // twice. Reserve-then-emit under the lock makes emission idempotent.
  const emittedPairs = new Set<number>();
  let pairMutex: Promise<void> = Promise.resolve();
  const withPairLock = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    const prev = pairMutex;
    let release!: () => void;
    pairMutex = new Promise<void>((res) => { release = res; });
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  };

  async function maybeEmitPair(forPosition: number): Promise<void> {
    // forPosition is 1-based. The pair's left slot is the odd position
    // immediately at or below it (1↔2, 3↔4, ...). The right slot is
    // the next position. Both must be present (or the right slot must
    // be out of range, meaning a trailing-orphan).
    const leftIdx = forPosition % 2 === 1 ? forPosition - 1 : forPosition - 2;
    const rightIdx = leftIdx + 1;
    if (emittedPairs.has(leftIdx)) return;
    // Padding slots (from odd-count duplex groups) act as "absent": the
    // partner slot is treated as a trailing orphan, never as a real page.
    if (paddingSlots.has(leftIdx)) return; // padding never anchors a pair
    const left = pages[leftIdx];
    const rightIsPadding = paddingSlots.has(rightIdx);
    const rightInRange = rightIdx < files.length && !rightIsPadding;
    const right = rightInRange ? pages[rightIdx] : null;
    if (!left) return;
    if (rightInRange && !right) return;

    // Reserve before any await so a concurrent sibling can't slip past
    // the `has` check above while we're still inside the mutex turn.
    emittedPairs.add(leftIdx);

    const pageList: ScanPage<DriveImageFile>[] = right ? [left, right] : [left];
    const [pair] = pairPages(pageList);
    const [row] = await db.insert(scanBatchItems).values({
      batchId: batch.id,
      position: Math.floor(leftIdx / 2) + 1,
      backFileId: pair.back?.file.id || null,
      backFileName: pair.back?.file.name || null,
      frontFileId: pair.front?.file.id || null,
      frontFileName: pair.front?.file.name || null,
      status: 'pending',
      reviewReasons: pair.warnings.length > 0 ? pair.warnings : null,
    }).returning();
    inserted.push(row);
    onItemReady?.(row);
  }

  // Phase 1 is dominated by I/O — Drive download + Vision OCR — so it
  // tolerates more concurrency than Phase 2 (which spends real CPU/quota
  // on Gemini + eBay + Sheets). 8 keeps us well under Vision's 1800/min
  // and Drive's per-user limits while halving the ramp-up time before the
  // first complete pair lands. With the previous concurrency=4 the first
  // pair couldn't fire until 4 cold-TLS Drive downloads + 4 Vision probes
  // had each finished a full round-trip; that floor showed up as ~45 s
  // time-to-first-pair on an 82-file dealer batch.
  const phase1Queue = new (PQueue as any)({ concurrency: 8 });
  const t0 = Date.now();
  let firstEmitLogged = false;
  const originalOnItemReady = onItemReady;
  onItemReady = (row) => {
    if (!firstEmitLogged) {
      firstEmitLogged = true;
      console.log(`[bulkScan] batch ${batch.id}: first pair ready in ${Date.now() - t0}ms`);
    }
    originalOnItemReady?.(row);
  };
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const position = i + 1;
    if (file === null) {
      // Padding slot from groupFilesByDuplexBatch — schedule a no-op
      // turn so its partner can flush as a trailing orphan via the
      // normal mutex-protected emit path.
      phase1Queue.add(async () => {
        await withPairLock(() => maybeEmitPair(position));
      });
      continue;
    }
    phase1Queue.add(async () => {
      const tDownload = Date.now();
      try {
        const rawBuf = await downloadFile(batch.userId, file.id);
        const downloadMs = Date.now() - tDownload;
        const exifNormalized = await normalizeImageOrientation(rawBuf, `batch${batch.id}#${position}`);
        const tProbe = Date.now();
        const orient = await detectOrientation(exifNormalized, `batch${batch.id}#${position}`);
        const probeMs = Date.now() - tProbe;
        const tClassify = Date.now();
        const classification = classifyCardSide(orient.ocrText);
        const sideClassifyMs = Date.now() - tClassify;
        pages[i] = { position, file, ocrText: orient.ocrText, classification };
        timings?.recordFile({
          fileId: file.id,
          name: file.name,
          downloadMs,
          probeMs,
          sideClassifyMs,
          side: classification.verdict,
        });
      } catch (err: any) {
        console.warn(`[bulkScan] discover: failed to probe page ${position} (${file.name}) — ${err?.message}`);
        pages[i] = {
          position,
          file,
          ocrText: '',
          classification: { verdict: 'unknown', confidence: 0, signals: [], debug: { bioPrefixLines: 0, copyrightHits: 0, statHeaderTokens: 0, totalWords: 0 } },
        };
        timings?.recordFile({
          fileId: file.id,
          name: file.name,
          downloadMs: Date.now() - tDownload,
          side: 'unknown',
          error: err?.message || String(err),
        });
      }
      await withPairLock(() => maybeEmitPair(position));
    });
  }
  await phase1Queue.onIdle();
  timings?.recordPhase1Complete();
  return inserted;
}

/**
 * Analyze one paired item: download both sides (with 180° rotation applied
 * as needed on the back), call the dual-side analyzer via its exported
 * function, run the confidence gate, and either append to Sheets (auto-
 * save) or persist the review snapshot.
 */
async function processItem(
  batch: ScanBatch,
  item: ScanBatchItem,
  timings?: BatchTimingsRecorder,
  pairKey?: string,
  sheetsQueue?: SheetsAppendQueue,
): Promise<'auto_save' | 'review'> {
  await db.update(scanBatchItems).set({ status: 'processing' }).where(eq(scanBatchItems.id, item.id));

  // Unpaired trailing page → send straight to review. We still download
  // the single side so the dealer can view it in the review UI.
  if (!item.backFileId || !item.frontFileId) {
    await db.update(scanBatchItems).set({
      status: 'review',
      reviewReasons: [...(asStringArray(item.reviewReasons)), 'unpaired_trailing_page'],
      processedAt: new Date(),
    }).where(eq(scanBatchItems.id, item.id));
    return 'review';
  }

  // Download both sides + normalize. We re-run EXIF normalization here
  // because the buffers in discovery were not persisted.
  const [rawBack, rawFront] = await Promise.all([
    downloadFile(batch.userId, item.backFileId),
    downloadFile(batch.userId, item.frontFileId),
  ]);
  const exifBack = await normalizeImageOrientation(rawBack, `batch${batch.id}#${item.position}/back`);
  const exifFront = await normalizeImageOrientation(rawFront, `batch${batch.id}#${item.position}/front`);

  // Invoke the existing dual-side analyzer via its exported handler. This
  // is the same mock-request pattern routes.ts:2045 uses — we reuse all of
  // dualSideOCR's orchestration (OCR batch, per-side analyzers, SCP-first,
  // CardDB enrichment, foil detection) without duplicating any of it.
  const { handleDualSideCardAnalysis } = await import('../dualSideOCR');
  // Deterministic scanId so bulk scan rows in the scan-log Sheet are
  // distinguishable from single-card "no session" rows. Without this the
  // analyzer falls back to `noscan-${Date.now()}` and bulk rows blend in
  // with abandoned single-card sessions. Greppable by `bulk-` prefix.
  const scanId = `bulk-${batch.id}-${item.id}`;
  const mockReq: any = {
    files: {
      frontImage: [buildMockFile(exifFront, item.frontFileName || 'front.jpg')],
      backImage: [buildMockFile(exifBack, item.backFileName || 'back.jpg')],
    },
    // PR C5: `scanContext: 'bulk'` tells the analyze handler to skip the
    // 1500ms cap on the embedded picker call. Bulk has no UI-blocking
    // concern and used to run its own synchronous picker call after this —
    // truncating at 1.5s would silently lose comps on the long tail
    // (telemetry: max ~3.3s in batch 8).
    body: { scanId, scanContext: 'bulk' },
    query: {},
  };

  const tGemini = Date.now();
  const analysis = await new Promise<Record<string, any>>((resolve, reject) => {
    const mockRes: any = {
      json: (payload: any) => {
        if (payload?.success && payload?.data) resolve(payload.data);
        else reject(new Error(`Dual OCR returned unsuccessful payload: ${JSON.stringify(payload)?.slice(0, 200)}`));
      },
      status: (code: number) => ({
        json: (payload: any) => reject(new Error(`Dual OCR failed (${code}): ${JSON.stringify(payload)?.slice(0, 200)}`)),
      }),
    };
    handleDualSideCardAnalysis(mockReq, mockRes).catch(reject);
  });
  if (pairKey && timings) {
    timings.recordPairUpdate(pairKey, { geminiMs: Date.now() - tGemini });
  }

  // ── 2026 Topps imprint year override ────────────────────────────────────
  // Belt-and-suspenders net for the dense-stat-table case where Gemini
  // flips to year=2025 despite "© 2026 THE TOPPS" + CMP123053 visible in
  // the OCR back text. Topps-only, no-op when year is already 2026, no-op
  // when no imprint/CMP signal is present in the OCR. See yearOverrides.ts.
  {
    const brandRaw = (analysis.brand ?? '').toString().trim();
    if (brandRaw && /^topps\b/i.test(brandRaw)) {
      const ocrBackText = (analysis as any)._backOCRText ?? '';
      const vlmYear =
        typeof analysis.year === 'number'
          ? analysis.year
          : analysis.year != null
            ? Number(analysis.year)
            : null;
      const overrideRes = applyTopps2026ImprintOverride({
        scanId: String(item.id),
        vlmYear: Number.isFinite(vlmYear as number) ? (vlmYear as number) : null,
        ocrBackText,
      });
      if (overrideRes.overridden) {
        analysis.year = 2026;
      }
    }
  }

  // ── Front/back auto-swap (PR fix/front-back-auto-swap) ───────────────────
  // The pair classifier emits `unknown` or `classifier_same_side_*` when it
  // can't tell front from back from the OCR text alone. Telemetry on batch 8
  // showed ~23% of pages classified `unknown`; pairing then falls back to
  // file-order (odd→back, even→front) which is wrong ~50% of the time. The
  // result was 6–7 cards per ~50-card batch with the persisted
  // frontFileId/backFileId reversed (e.g. Steve Balboni 1988 Topps #638
  // displaying his stat-line back as the FRONT).
  //
  // Fix: Gemini already sees both images and returns `frontImageIndex` in
  // its dual-side response. When the pair classifier was uncertain AND
  // Gemini returned a usable index, defer to Gemini and swap the persisted
  // file IDs so the canonical front is what the dealer / collection grid
  // sees. We never override a confident classifier verdict — the 77% of
  // pairs that work today must not regress.
  const priorReasons = asStringArray(item.reviewReasons);
  const classifierWasUncertain =
    priorReasons.includes('classifier_unknown') ||
    priorReasons.some((r) => r.startsWith('classifier_same_side_'));
  const gemini = (analysis as any)?._gemini;
  const geminiFrontIdx: 0 | 1 | null =
    gemini && (gemini.frontImageIndex === 0 || gemini.frontImageIndex === 1)
      ? gemini.frontImageIndex
      : null;
  let resolvedFrontFileId = item.frontFileId;
  let resolvedBackFileId = item.backFileId;
  let resolvedFrontFileName = item.frontFileName;
  let resolvedBackFileName = item.backFileName;
  let resolvedReasons: string[] = priorReasons;
  let swapApplied = false;
  if (classifierWasUncertain && geminiFrontIdx === 1) {
    // The mock-request to handleDualSideCardAnalysis passed exifFront
    // (built from item.frontFileId) as the FIRST image, so frontImageIndex
    // refers to that ordering. Index 1 → the file we labelled `frontFileId`
    // is actually the back; swap.
    console.log(
      `[bulkScan] item ${item.id}: front/back swap from Gemini frontImageIndex=1 (priorReasons=${priorReasons.join(',') || 'none'})`,
    );
    resolvedFrontFileId = item.backFileId;
    resolvedBackFileId = item.frontFileId;
    resolvedFrontFileName = item.backFileName;
    resolvedBackFileName = item.frontFileName;
    swapApplied = true;
  }
  // Drop the classifier-uncertainty review reasons when Gemini gave us a
  // confident frontImageIndex — the pair is now resolvable post-Gemini and
  // no longer needs human review for that reason. (Other review reasons,
  // like card_number_low_confidence, are unaffected.)
  if (classifierWasUncertain && geminiFrontIdx !== null) {
    resolvedReasons = priorReasons.filter(
      (r) => r !== 'classifier_unknown' && !r.startsWith('classifier_same_side_'),
    );
  }

  // CardDB corroboration: independent lookup on the analyzer's output so
  // we can feed it into the confidence gate. Gated by CARDDB_LOOKUP_ENABLED
  // (PR #162) — when off, Gemini VLM is authoritative and we treat the
  // missing CardDB signal as neutral (cardDbAvailable=false), not as
  // "actively not corroborated."
  const cardDbAvailable = isCardDbLookupEnabled();
  let cardDbCorroborated = false;
  if (!cardDbAvailable) {
    console.log(
      `[BulkScan][CardDB] Lookup disabled by CARDDB_LOOKUP_ENABLED flag — Gemini VLM is authoritative for this scan.`,
    );
  } else {
    const tCardDb = Date.now();
    try {
      if (analysis.brand && analysis.year && analysis.cardNumber) {
        const dbRes = await cardDbLookup({
          brand: String(analysis.brand),
          year: Number(analysis.year),
          cardNumber: String(analysis.cardNumber),
          collection: analysis.collection || undefined,
          serialNumber: analysis.serialNumber || undefined,
          playerLastName: analysis.playerLastName || undefined,
        });
        if (dbRes.found) {
          cardDbCorroborated = isCardDbCorroboration(analysis, {
            year: dbRes.year ?? null,
            cardNumberRaw: dbRes.cardNumber ?? null,
          });
        }
      }
    } catch (err: any) {
      console.warn(`[bulkScan] CardDB corroboration lookup failed for item ${item.id}: ${err?.message}`);
    }
    if (pairKey && timings) {
      timings.recordPairUpdate(pairKey, { cardDbMs: Date.now() - tCardDb });
    }
  }

  // PR C5: consume the analyze handler's embedded comps instead of running
  // a duplicate `pickerSearch` here. Pre-C5 bulk fired its own picker call
  // after Gemini and reconstructed the eBay URL from `buildPickerQuery`.
  // PR #189 made those two queries byte-identical; PR C5 deletes the
  // duplicate call entirely.
  //
  // The mockReq above passed `scanContext: 'bulk'`, which tells the
  // analyze handler to skip its 1500ms timeout on the embedded picker
  // call — bulk waits for the full result (telemetry: median ~510ms,
  // max ~3.3s) since it has no UI-blocking constraint.
  const embeddedComps = (analysis.comps && Array.isArray(analysis.comps.active))
    ? analysis.comps as { query: string; active: Array<{ price?: number | null }> }
    : null;
  if (embeddedComps) {
    const active = embeddedComps.active || [];
    const averageValue = active.length > 0
      ? active.reduce((sum, l) => sum + (Number(l.price) || 0), 0) / active.length
      : 0;
    // PR #250: preserve null estimatedValue when there are zero active
    // listings AND dualSideOCR flagged the result with `_noActiveListings`.
    // The Sheet column already renders `null`/empty as a blank cell
    // (googleSheets.ts safeCellValue + numeric coercion), so we propagate
    // null end-to-end instead of slamming "$0.00" onto cards we never
    // priced. With active listings present we keep the existing average.
    if (active.length === 0 && (analysis as any)._noActiveListings === true) {
      analysis.estimatedValue = null as any;
    } else {
      analysis.estimatedValue = averageValue;
    }
    analysis.ebayResults = active;
    // Outbound "View on eBay" link for the Sheet row. We deliberately do
    // NOT reuse `embeddedComps.query` (the picker query): the picker
    // substitutes subset for player upstream (extractIdentityForEbay,
    // PR #193) so subset cards come out as e.g.
    // `1987 Topps "604" "NL Leaders"` — eBay returns nothing because real
    // listings have the player name. Build the Sheet URL via
    // getEbaySearchUrl using the real player + subset as a separate
    // unquoted hint. See server/ebayService.ts:getEbaySearchUrl.
    const playerForUrl = [analysis.playerFirstName, analysis.playerLastName]
      .filter(Boolean).join(' ').trim();
    const yearForUrl = typeof analysis.year === 'number'
      ? analysis.year
      : (analysis.year ? parseInt(String(analysis.year), 10) || 0 : 0);
    const subsetForUrl = (analysis._gemini && typeof analysis._gemini.subset === 'string')
      ? analysis._gemini.subset.trim()
      : '';
    analysis.ebaySearchUrl = analysis.brand ? getEbaySearchUrl(
      playerForUrl,
      String(analysis.cardNumber || ''),
      String(analysis.brand || ''),
      yearForUrl,
      analysis.collection || '',
      '',
      !!analysis.isNumbered,
      analysis.foilType || '',
      analysis.serialNumber || '',
      analysis.variant || '',
      analysis.set || '',
      undefined,
      !!analysis.isAutographed,
      false,
      subsetForUrl,
    ) : `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(embeddedComps.query)}&_sacat=213&_sop=10`;
    console.log(
      `[bulkScan] eBay comps item ${item.id}: ${active.length} active results, avg=$${averageValue.toFixed(2)} for "${embeddedComps.query}" (embedded)`,
    );
    if (pairKey && timings) {
      // PR C5 ebayMs semantics: this is the analyze handler's
      // `_embeddedCompsMs` — the wall-clock the picker call still owed AT
      // THE END of analyze (after audit logging and scanLogger flush ran
      // in parallel). Pre-C5 ebayMs was the full sequential picker
      // duration AFTER Gemini returned. Post-C5 most of the picker time
      // overlaps with audit/log work and is hidden inside geminiMs; this
      // field captures only the trailing un-overlapped slice. Treat as a
      // lower-bound — it is NOT directly comparable to pre-C5 batches.
      const embeddedMs = typeof (analysis as any)._embeddedCompsMs === 'number'
        ? (analysis as any)._embeddedCompsMs
        : 0;
      timings.recordPairUpdate(pairKey, { ebayMs: embeddedMs });
    }
  } else {
    // Either Gemini didn't yield a usable identity (player + cardNumber +
    // year + brand) or the embedded picker errored out non-fatally.
    // Either way, no comps to persist — leave estimatedValue/ebayResults
    // unset so the analyzer's defaults stand.
    console.log(
      `[bulkScan] eBay comps skipped item ${item.id}: no embedded comps (player=${!!analysis.playerFirstName}/${!!analysis.playerLastName} brand=${!!analysis.brand} cardNumber=${!!analysis.cardNumber} year=${!!analysis.year})`,
    );
  }

  // Pairing warnings already live on the item row from discoverAndPlanItems.
  // Use `resolvedReasons` (not `item.reviewReasons`) so the confidence gate
  // sees the post-Gemini state — `classifier_unknown` is dropped above when
  // Gemini's `frontImageIndex` resolved the pair.
  const gate = evaluateConfidence({
    analysis,
    pairingWarnings: resolvedReasons,
    cardDbAvailable,
    cardDbCorroborated,
  });

  const reviewReasons = gate.reasons;
  const shouldAutoSave = gate.verdict === 'auto_save' && !batch.dryRun;

  if (shouldAutoSave) {
    const card: CardRowInput = {
      sport: analysis.sport || null,
      year: typeof analysis.year === 'number' ? analysis.year : null,
      brand: analysis.brand || null,
      collection: analysis.collection || null,
      set: analysis.set || null,
      cardNumber: analysis.cardNumber || null,
      cmpNumber: analysis.cmpNumber || null,
      // Player fallback: prefer the legacy single-name fields when set. For
      // multi-player subset cards (Team Leaders, Combos, Strikeout Leaders)
      // the top-level player slots are intentionally empty and the model
      // fills `players[]` instead — fall back to players[0] so the Sheet's
      // Player column never reads blank just because the legacy fields
      // weren't mirrored. buildRow() will still prefer the full players[]
      // array when forwarded below.
      player: (() => {
        const legacy = [analysis.playerFirstName, analysis.playerLastName]
          .filter(Boolean)
          .join(' ');
        if (legacy) return legacy;
        const arr = Array.isArray((analysis as any).players)
          ? ((analysis as any).players as Array<{ firstName?: string; lastName?: string }>)
          : [];
        if (arr.length === 0) return null;
        const first = `${(arr[0]?.firstName ?? '').toString().trim()} ${(arr[0]?.lastName ?? '').toString().trim()}`.trim();
        return first || null;
      })(),
      // Forward the multi-player array (when present) so the Sheet's Player
      // cell joins each "First Last" with " / " for vintage Topps subsets
      // (1971 N.L. Strikeout Leaders, 1968 Batting Leaders, etc.). One row
      // per card is preserved — players[] only changes the cell text.
      players: Array.isArray((analysis as any).players) && (analysis as any).players.length > 0
        ? ((analysis as any).players as Array<{ firstName: string; lastName: string; role?: string }>)
        : null,
      variation: analysis.variant || null,
      serialNumber: analysis.serialNumber || null,
      isRookieCard: !!analysis.isRookieCard,
      isAutographed: !!analysis.isAutographed,
      isNumbered: !!analysis.isNumbered,
      foilType: analysis.foilType || null,
      averagePrice: typeof analysis.estimatedValue === 'number' ? analysis.estimatedValue : null,
      frontImageUrl: null,
      backImageUrl: null,
      ebaySearchUrl: typeof analysis.ebaySearchUrl === 'string' ? analysis.ebaySearchUrl : null,
      potentialVariant: analysis.potentialVariant ?? null,
    };
    try {
      // Hand the row to the per-batch flusher and wait for ack. The
      // flusher coalesces up to CHUNK_SIZE rows into a single Sheets
      // API call, so a 64-card batch makes ~3 requests instead of 64
      // and never trips the 60-write/min/user quota. Falls back to
      // direct appendCardRow on the (single-card resume) path where
      // the queue isn't passed in.
      if (sheetsQueue) {
        await sheetsQueue.enqueue(item.id, card);
      } else {
        await appendCardRow(batch.userId, card);
      }

      // Best-effort log to user_scans. Auto-save means the confidence gate
      // passed AND the dealer never touched the row — strongest possible
      // trust signal, so we tag it as 'confirmed' with an empty diff. The
      // detected snapshot IS the final value (no edits possible on this
      // path). cardId stays null because the bulk pipeline writes to the
      // user's Google Sheet rather than the local cards table.
      const fields = analysisToScanFieldValues(analysis);
      logUserScan({
        userId: batch.userId,
        cardId: null,
        userAction: 'confirmed',
        detected: fields,
        final: fields,
        frontImage: null,
        backImage: null,
        scpMatchedTitle: null,
        cardDbCorroborated,
        analyzerVersion: 'bulk_scan_auto_save',
        // Auto-save path: the analyzer payload IS the final value (no
        // dealer edit possible here), so the snapshot equals the saved
        // row. Stored anyway so /admin/scans renders consistently.
        geminiSnapshot: analysis,
        fieldsChangedOverride: [],
      }).catch(() => {});

      // Move both files to processed folder.
      if (batch.processedFolderId && batch.sourceFolderId) {
        await Promise.all([
          moveFile(batch.userId, item.backFileId, batch.sourceFolderId, batch.processedFolderId).catch(err =>
            console.warn(`[bulkScan] move back file failed for item ${item.id}: ${err?.message}`),
          ),
          moveFile(batch.userId, item.frontFileId, batch.sourceFolderId, batch.processedFolderId).catch(err =>
            console.warn(`[bulkScan] move front file failed for item ${item.id}: ${err?.message}`),
          ),
        ]);
      }
    } catch (err: any) {
      // Sheet append failed — demote to review so the dealer doesn't lose data.
      console.error(`[bulkScan] appendCardRow failed for item ${item.id}, demoting to review:`, err);
      await db.update(scanBatchItems).set({
        status: 'review',
        confidenceScore: gate.confidenceScore.toString(),
        analysisResult: analysis,
        reviewReasons: [...reviewReasons, `sheet_append_failed:${err?.message || 'unknown'}`],
        errorMessage: err?.message || String(err),
        processedAt: new Date(),
        ...(swapApplied ? {
          frontFileId: resolvedFrontFileId,
          backFileId: resolvedBackFileId,
          frontFileName: resolvedFrontFileName,
          backFileName: resolvedBackFileName,
        } : {}),
      }).where(eq(scanBatchItems.id, item.id));
      return 'review';
    }
    await db.update(scanBatchItems).set({
      status: 'auto_saved',
      confidenceScore: gate.confidenceScore.toString(),
      analysisResult: analysis,
      reviewReasons: null,
      processedAt: new Date(),
      ...(swapApplied ? {
        frontFileId: resolvedFrontFileId,
        backFileId: resolvedBackFileId,
        frontFileName: resolvedFrontFileName,
        backFileName: resolvedBackFileName,
      } : {}),
    }).where(eq(scanBatchItems.id, item.id));
    return 'auto_save';
  }

  // Review path (covers dry-run too — we never write to Sheets in dry-run).
  // When the front/back swap fired (classifier was uncertain + Gemini
  // returned a confident frontImageIndex), persist the resolved file IDs
  // to the row so the review UI / collection grid shows the correct front.
  await db.update(scanBatchItems).set({
    status: 'review',
    confidenceScore: gate.confidenceScore.toString(),
    analysisResult: analysis,
    reviewReasons,
    processedAt: new Date(),
    ...(swapApplied ? {
      frontFileId: resolvedFrontFileId,
      backFileId: resolvedBackFileId,
      frontFileName: resolvedFrontFileName,
      backFileName: resolvedBackFileName,
    } : {}),
  }).where(eq(scanBatchItems.id, item.id));
  return 'review';
}

// ── Helpers ──────────────────────────────────────────────────────────────

interface MockMulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

function buildMockFile(buffer: Buffer, name: string): MockMulterFile {
  return {
    fieldname: 'image',
    originalname: name,
    encoding: '7bit',
    mimetype: /\.png$/i.test(name) ? 'image/png' : 'image/jpeg',
    size: buffer.length,
    buffer,
  };
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}
