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
import { detectOrientation, applyRotation } from './orientation';
import { pairPages, type ScanPage, type PairedScan } from './pairing';
import { evaluateConfidence, isCardDbCorroboration } from './confidenceGate';
import { normalizeImageOrientation } from '../dualSideOCR';
import { lookupCard as cardDbLookup } from '../cardDatabaseService';
import { appendCardRow } from '../googleSheets';

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

  try {
    // Load existing items (on resume) OR list the inbox and create them.
    let items = await db
      .select()
      .from(scanBatchItems)
      .where(eq(scanBatchItems.batchId, batchId))
      .orderBy(asc(scanBatchItems.position));

    if (items.length === 0) {
      items = await discoverAndPlanItems(batch);
    }

    let processed = 0;
    let reviews = 0;
    for (const item of items) {
      if (item.status === 'auto_saved' || item.status === 'review' || item.status === 'skipped' || item.status === 'failed') {
        // Already handled — skip. Counters get rebuilt below.
        if (item.status === 'review') reviews++;
        if (item.status === 'auto_saved' || item.status === 'review' || item.status === 'skipped') processed++;
        continue;
      }
      try {
        const outcome = await processItem(batch, item);
        if (outcome === 'review') reviews++;
        processed++;
      } catch (err: any) {
        console.error(`[bulkScan] processItem(${item.id}) failed:`, err);
        await db
          .update(scanBatchItems)
          .set({
            status: 'failed',
            errorMessage: err?.message || String(err),
            processedAt: new Date(),
          })
          .where(eq(scanBatchItems.id, item.id));
        processed++;
      }
      // Update running counters so the UI can poll progress.
      await db
        .update(scanBatches)
        .set({ processedCount: processed, reviewQueueCount: reviews })
        .where(eq(scanBatches.id, batchId));
    }

    await db
      .update(scanBatches)
      .set({ status: 'completed', completedAt: new Date(), processedCount: processed, reviewQueueCount: reviews })
      .where(eq(scanBatches.id, batchId));
    console.log(`[bulkScan] Batch ${batchId} complete: ${processed} processed, ${reviews} in review.`);
  } catch (err: any) {
    console.error(`[bulkScan] runBatch(${batchId}) fatal:`, err);
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
 * Design note: we pay the full orientation-probe + Vision cost during
 * discovery so the item rows can carry pre-computed OCR text + side
 * classification. That means a resumed batch skips the expensive probe
 * phase on second run.
 */
async function discoverAndPlanItems(batch: ScanBatch): Promise<ScanBatchItem[]> {
  if (!batch.sourceFolderId) throw new Error('Batch has no source folder');
  const rawFiles = await listInboxImages(batch.userId, batch.sourceFolderId);

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
  const files = rawFiles.filter(f => !seenFileIds.has(f.id));
  const skipped = rawFiles.length - files.length;
  if (skipped > 0) {
    console.log(`[bulkScan] Batch ${batch.id}: skipping ${skipped} previously-seen file(s) in inbox.`);
  }

  if (files.length === 0) {
    await db.update(scanBatches).set({ fileCount: 0 }).where(eq(scanBatches.id, batch.id));
    return [];
  }
  await db.update(scanBatches).set({ fileCount: files.length }).where(eq(scanBatches.id, batch.id));

  // Download + orient + classify every page up front so the pairing module
  // has full signals. We keep the raw buffers out of the DB — only file ids
  // persist, and the worker re-downloads at analyze time. The orientation
  // probe text is NOT reused for the dual analyzer because that analyzer
  // has its own Vision + warming logic; probing again is cheap in the
  // reduced-concurrency serial loop.
  const pages: ScanPage<DriveImageFile>[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const position = i + 1;
    try {
      const rawBuf = await downloadFile(batch.userId, file.id);
      // Normalize EXIF first; then probe 0°/180° for reading orientation.
      const exifNormalized = await normalizeImageOrientation(rawBuf, `batch${batch.id}#${position}`);
      const orient = await detectOrientation(exifNormalized, `batch${batch.id}#${position}`);
      const classification = classifyCardSide(orient.ocrText);
      pages.push({ position, file, ocrText: orient.ocrText, classification });
    } catch (err: any) {
      console.warn(`[bulkScan] discover: failed to probe page ${position} (${file.name}) — ${err?.message}`);
      pages.push({
        position,
        file,
        ocrText: '',
        classification: { verdict: 'unknown', confidence: 0, signals: [], debug: { bioPrefixLines: 0, copyrightHits: 0, statHeaderTokens: 0, totalWords: 0 } },
      });
    }
  }

  const paired = pairPages(pages);
  const inserted: ScanBatchItem[] = [];
  for (const pair of paired) {
    const [row] = await db.insert(scanBatchItems).values({
      batchId: batch.id,
      position: pair.position,
      backFileId: pair.back?.file.id || null,
      backFileName: pair.back?.file.name || null,
      frontFileId: pair.front?.file.id || null,
      frontFileName: pair.front?.file.name || null,
      status: 'pending',
      reviewReasons: pair.warnings.length > 0 ? pair.warnings : null,
    }).returning();
    inserted.push(row);
  }
  return inserted;
}

/**
 * Analyze one paired item: download both sides (with 180° rotation applied
 * as needed on the back), call the dual-side analyzer via its exported
 * function, run the confidence gate, and either append to Sheets (auto-
 * save) or persist the review snapshot.
 */
async function processItem(batch: ScanBatch, item: ScanBatchItem): Promise<'auto_save' | 'review'> {
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

  // Probe back-side orientation (front is assumed right-side-up from the
  // duplex scanner; a future PR can probe the front too at 1× cost).
  //
  // Scanner-agnostic: the pipeline only assumes multi-page JPEG/PDF output
  // dropped into a Drive folder — any duplex ADF produces this shape.
  const orient = await detectOrientation(exifBack, `batch${batch.id}#${item.position}/back`);
  const correctedBack = await applyRotation(exifBack, orient.rotationNeeded);

  // Invoke the existing dual-side analyzer via its exported handler. This
  // is the same mock-request pattern routes.ts:2045 uses — we reuse all of
  // dualSideOCR's orchestration (OCR batch, per-side analyzers, SCP-first,
  // CardDB enrichment, foil detection) without duplicating any of it.
  const { handleDualSideCardAnalysis } = await import('../dualSideOCR');
  const mockReq: any = {
    files: {
      frontImage: [buildMockFile(exifFront, item.frontFileName || 'front.jpg')],
      backImage: [buildMockFile(correctedBack, item.backFileName || 'back.jpg')],
    },
    body: {},
    query: {},
  };

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

  // CardDB corroboration: independent lookup on the analyzer's output so
  // we can feed it into the confidence gate. `cardDbLookup` runs fast
  // against the local DB and is idempotent; running it here twice per
  // scan (once inside the analyzer, once here) is fine.
  let cardDbCorroborated = false;
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

  // Pairing warnings already live on the item row from discoverAndPlanItems.
  const priorWarnings = asStringArray(item.reviewReasons);
  const gate = evaluateConfidence({
    analysis,
    pairingWarnings: priorWarnings,
    cardDbCorroborated,
  });

  const reviewReasons = gate.reasons;
  const shouldAutoSave = gate.verdict === 'auto_save' && !batch.dryRun;

  if (shouldAutoSave) {
    try {
      await appendCardRow(batch.userId, {
        sport: analysis.sport || null,
        year: typeof analysis.year === 'number' ? analysis.year : null,
        brand: analysis.brand || null,
        collection: analysis.collection || null,
        set: analysis.set || null,
        cardNumber: analysis.cardNumber || null,
        cmpNumber: analysis.cmpNumber || null,
        player: [analysis.playerFirstName, analysis.playerLastName].filter(Boolean).join(' ') || null,
        variation: analysis.variant || null,
        serialNumber: analysis.serialNumber || null,
        isRookieCard: !!analysis.isRookieCard,
        isAutographed: !!analysis.isAutographed,
        isNumbered: !!analysis.isNumbered,
        foilType: analysis.foilType || null,
        averagePrice: typeof analysis.estimatedValue === 'number' ? analysis.estimatedValue : null,
        frontImageUrl: null,
        backImageUrl: null,
        ebaySearchUrl: null,
      });
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
      }).where(eq(scanBatchItems.id, item.id));
      return 'review';
    }
    await db.update(scanBatchItems).set({
      status: 'auto_saved',
      confidenceScore: gate.confidenceScore.toString(),
      analysisResult: analysis,
      reviewReasons: null,
      processedAt: new Date(),
    }).where(eq(scanBatchItems.id, item.id));
    return 'auto_save';
  }

  // Review path (covers dry-run too — we never write to Sheets in dry-run).
  await db.update(scanBatchItems).set({
    status: 'review',
    confidenceScore: gate.confidenceScore.toString(),
    analysisResult: analysis,
    reviewReasons,
    processedAt: new Date(),
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
