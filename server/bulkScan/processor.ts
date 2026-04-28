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
import { pairPages, type ScanPage, type PairedScan } from './pairing';
import { evaluateConfidence, isCardDbCorroboration } from './confidenceGate';
import { normalizeImageOrientation } from '../dualSideOCR';
import { lookupCard as cardDbLookup } from '../cardDatabaseService';
import { isCardDbLookupEnabled } from '../featureFlags';
import { appendCardRow } from '../googleSheets';
import { getEbaySearchUrl } from '../ebayService';
import { pickerSearch, buildPickerQuery } from '../ebayPickerSearch';
import { getScanQuota, incrementScanCount } from '../scanQuota';
import { logUserScan, type ScanFieldValues } from '../userScans';

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
    for (const item of items) {
      if (item.status === 'auto_saved' || item.status === 'review' || item.status === 'skipped' || item.status === 'failed') {
        // Already handled — skip. Counters get rebuilt below.
        if (item.status === 'review') reviews++;
        if (item.status === 'auto_saved' || item.status === 'review' || item.status === 'skipped') processed++;
        continue;
      }
      // Quota check before doing any work for this item. Once we hit zero
      // we mark every remaining pending item as skipped with reason
      // 'quota_exhausted' so the UI can render a clear "X of Y skipped —
      // upgrade to continue" banner instead of failing items individually.
      if (remaining <= 0) {
        quotaHit = true;
        await db
          .update(scanBatchItems)
          .set({
            status: 'skipped',
            reviewReasons: [...(asStringArray(item.reviewReasons)), 'quota_exhausted'],
            processedAt: new Date(),
          })
          .where(eq(scanBatchItems.id, item.id));
        processed++;
        await db
          .update(scanBatches)
          .set({ processedCount: processed, reviewQueueCount: reviews })
          .where(eq(scanBatches.id, batchId));
        continue;
      }
      try {
        const outcome = await processItem(batch, item);
        if (outcome === 'review') reviews++;
        processed++;
        // Increment quota only after a real processItem run — the early-skip
        // branch above does not touch the user's count.
        await incrementScanCount(batch.userId);
        if (Number.isFinite(remaining)) remaining = Math.max(0, remaining - 1);
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
        // Failures don't count against quota — the user didn't get a card.
      }
      // Update running counters so the UI can poll progress.
      await db
        .update(scanBatches)
        .set({ processedCount: processed, reviewQueueCount: reviews })
        .where(eq(scanBatches.id, batchId));
    }
    if (quotaHit) {
      console.log(`[bulkScan] Batch ${batchId} reached scan quota for user ${batch.userId}; remaining items marked skipped.`);
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
  // *** Diagnostic-only as of fix/bulk-scan-back-rotation. ***
  // We previously physically rotated the back buffer based on this
  // probe before handing it to the analyzer. That broke OCR on cards
  // where both 0° and 180° read similarly well to Google Vision but the
  // analyzer's downstream heuristics are orientation-sensitive (e.g.
  // 1987 Topps Joel Davis #299: rotated 180°, the analyzer pulled the
  // player name from a trivia paragraph ("Cliff Chambers... Bert
  // Blyleven") and the card # "25" from "Topps card was #25" instead of
  // the actual "299" in the corner). Single-Scan never pre-rotated and
  // worked correctly, so we now match that behavior: feed the
  // EXIF-normalized back to the analyzer as-is. The probe still runs so
  // we can spot-check whether a future scanner produces backs the
  // analyzer can't read at the buffer's native orientation — in which
  // case we'd reintroduce a *narrow* rotation rule (much higher
  // confidence threshold than the +5 / 1.5× rule we used to apply).
  //
  // Scanner-agnostic: the pipeline only assumes multi-page JPEG/PDF output
  // dropped into a Drive folder — any duplex ADF produces this shape.
  const orient = await detectOrientation(exifBack, `batch${batch.id}#${item.position}/back`);

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
    body: { scanId },
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

  // Stamp the (diagnostic-only) probe decision onto analysisResult so
  // the inbox-diagnostic UI can surface what the orientation probe
  // would have done. If we ever see misclassifications correlate with
  // probeRotation=180 we know to revisit the rule, and conversely if
  // we see a card whose OCR is empty/garbage and the probe says 180°
  // would have helped, that's a signal to reintroduce a narrow flip.
  (analysis as Record<string, any>)._backRotationProbe = {
    rotationNeeded: orient.rotationNeeded,
    confidence: orient.confidence,
    originalWords: orient.debug.originalWords,
    rotatedWords: orient.debug.rotatedWords,
    applied: false,
  };

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
  }

  // eBay value lookup via PR #165's pickerSearch — the same engine that
  // backs /api/ebay/comps and powers single-card's result-screen Price tab
  // and persistent "Avg" hero. Keyed off Gemini's normalized `parallel`
  // value (null when Gemini detected no parallel post-PR #168). Active
  // listings only — Browse API doesn't expose Sold under our current
  // eBay scope. Header label "Avg" matches single-card.
  if (
    analysis.playerFirstName &&
    analysis.playerLastName &&
    analysis.brand &&
    analysis.year
  ) {
    try {
      const playerName = `${analysis.playerFirstName} ${analysis.playerLastName}`;
      const query = buildPickerQuery({
        year: analysis.year,
        brand: analysis.brand,
        set: analysis.set || analysis.collection || null,
        cardNumber: analysis.cardNumber || null,
        player: playerName,
        parallel: analysis.variant || null,
      });
      const result = await pickerSearch(query, { limit: 10 });
      const active = result.active || [];
      const averageValue = active.length > 0
        ? active.reduce((sum, l) => sum + (l.price || 0), 0) / active.length
        : 0;
      analysis.estimatedValue = averageValue;
      analysis.ebayResults = active;
      // Keep the human-clickable search URL pointed at the same query so
      // dealers can drill in from the Sheet. getEbaySearchUrl predates the
      // picker engine but still produces a valid eBay search URL.
      analysis.ebaySearchUrl = getEbaySearchUrl(
        playerName,
        analysis.cardNumber || '',
        analysis.brand,
        analysis.year,
        analysis.collection || '',
        analysis.condition || '',
        analysis.isNumbered || false,
        analysis.foilType || undefined,
        analysis.serialNumber || undefined,
        analysis.variant || undefined,
        analysis.set || undefined,
        undefined,
        analysis.isAutographed || false,
      );
      console.log(
        `[bulkScan] eBay comps item ${item.id}: ${active.length} active results, avg=$${averageValue.toFixed(2)} for "${query}"`,
      );
    } catch (err: any) {
      console.warn(`[bulkScan] eBay comps lookup failed for item ${item.id}: ${err?.message}`);
      // Leave estimatedValue at whatever the analyzer set (typically 0). We
      // still let the row save — a missing price is recoverable; a missing
      // card row is not.
    }
  } else {
    console.log(
      `[bulkScan] eBay comps skipped item ${item.id}: insufficient card data (player=${!!analysis.playerFirstName}/${!!analysis.playerLastName} brand=${!!analysis.brand} year=${!!analysis.year})`,
    );
  }

  // Pairing warnings already live on the item row from discoverAndPlanItems.
  const priorWarnings = asStringArray(item.reviewReasons);
  const gate = evaluateConfidence({
    analysis,
    pairingWarnings: priorWarnings,
    cardDbAvailable,
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
        ebaySearchUrl: typeof analysis.ebaySearchUrl === 'string' ? analysis.ebaySearchUrl : null,
      });

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
