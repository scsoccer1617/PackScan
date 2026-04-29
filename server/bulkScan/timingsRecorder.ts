// Per-batch stage-timing recorder for the bulk-scan worker.
//
// Why this exists: prod Replit log streams have proven unreliable for the
// bulk-scan worker (PR #185's `[bulkScan] first pair ready in Tms` lines
// don't appear in the user's prod log view), so the same numbers need to
// land in a place we can fetch on demand. We persist them on
// `scan_batches.timings` (JSONB) and expose them through an admin-only
// HTTP endpoint.
//
// Hot-path budget: writes must NOT block the pipeline. Every recorder
// method updates an in-memory accumulator synchronously and schedules a
// debounced UPDATE; callers `await` nothing here. The debounce window is
// 1 s — diagnostic data, not critical state, so losing the last second
// on process death is acceptable.

import { eq } from 'drizzle-orm';
import { db } from '@db';
import { scanBatches, type BatchTimings } from '@shared/schema';

const FLUSH_DEBOUNCE_MS = 1000;

type FileEntry = NonNullable<BatchTimings['files']>[number];
type PairEntry = NonNullable<BatchTimings['pairs']>[number];

export class BatchTimingsRecorder {
  readonly batchId: number;
  private payload: BatchTimings;
  private filesByFileId = new Map<string, FileEntry>();
  private pairsByKey = new Map<string, PairEntry>();
  private flushTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private dirty = false;
  private closed = false;

  constructor(batchId: number, startedAt: number = Date.now()) {
    this.batchId = batchId;
    this.payload = {
      startedAt,
      firstPairEmittedAt: null,
      phase1CompletedAt: null,
      finishedAt: null,
      listInboxImagesMs: null,
      inboxFileCount: null,
      files: [],
      pairs: [],
    };
    this.dirty = true;
    this.scheduleFlush();
  }

  // ── Phase 1 setup ──────────────────────────────────────────────────────

  recordListInboxImages(durationMs: number, fileCount: number) {
    this.payload.listInboxImagesMs = durationMs;
    this.payload.inboxFileCount = fileCount;
    this.touch();
  }

  // ── Per-file Phase 1 ───────────────────────────────────────────────────

  recordFile(entry: FileEntry) {
    const existing = this.filesByFileId.get(entry.fileId);
    if (existing) {
      Object.assign(existing, entry);
    } else {
      this.filesByFileId.set(entry.fileId, { ...entry });
    }
    this.payload.files = Array.from(this.filesByFileId.values());
    this.touch();
  }

  recordPhase1Complete(at: number = Date.now()) {
    this.payload.phase1CompletedAt = at;
    this.touch();
  }

  // ── Per-pair Phase 2 ──────────────────────────────────────────────────

  recordPairEnqueued(pairKey: string, at: number = Date.now()) {
    if (!this.payload.firstPairEmittedAt) {
      this.payload.firstPairEmittedAt = at;
    }
    const existing = this.pairsByKey.get(pairKey);
    if (existing) {
      existing.enqueuedAt = existing.enqueuedAt ?? at;
    } else {
      this.pairsByKey.set(pairKey, { pairKey, enqueuedAt: at });
    }
    this.payload.pairs = Array.from(this.pairsByKey.values());
    this.touch();
  }

  recordPairUpdate(pairKey: string, patch: Partial<PairEntry>) {
    const existing = this.pairsByKey.get(pairKey);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      this.pairsByKey.set(pairKey, {
        pairKey,
        enqueuedAt: Date.now(),
        ...patch,
      });
    }
    this.payload.pairs = Array.from(this.pairsByKey.values());
    this.touch();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  recordFinished(at: number = Date.now()) {
    this.payload.finishedAt = at;
    this.touch();
  }

  /** Force-flush any pending writes and stop the timer. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushNow();
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private touch() {
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.closed) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, FLUSH_DEBOUNCE_MS);
    // Don't keep the event loop alive on this timer alone.
    if (typeof (this.flushTimer as any).unref === 'function') {
      (this.flushTimer as any).unref();
    }
  }

  private async flushNow(): Promise<void> {
    // Serialize flushes so we never have two UPDATE statements in flight
    // racing the most-recent payload.
    this.inFlight = this.inFlight.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const snapshot: BatchTimings = JSON.parse(JSON.stringify(this.payload));
      try {
        await db
          .update(scanBatches)
          .set({ timings: snapshot })
          .where(eq(scanBatches.id, this.batchId));
      } catch (err: any) {
        // Re-mark dirty so the next tick retries. Log once — repeated
        // failures will spam logs only at FLUSH_DEBOUNCE_MS cadence.
        console.warn(
          `[bulkScan/timings] flush(${this.batchId}) failed: ${err?.message}`,
        );
        this.dirty = true;
      }
    });
    return this.inFlight;
  }
}

/** Convenience: time an awaitable and return [result, durationMs]. */
export async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = Date.now();
  const v = await fn();
  return [v, Date.now() - t0];
}
