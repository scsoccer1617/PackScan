// Express routes for the bulk-scan pipeline.
//
// All routes require an authenticated user. The processor is user-scoped
// end-to-end (every DB row, every Drive call) so the dealer only sees
// their own batches even when the app becomes multi-tenant.
//
// Endpoints:
//   POST   /api/bulk-scan/sync             Kick off a new batch for this user.
//   GET    /api/bulk-scan/batches          List recent batches with summary.
//   GET    /api/bulk-scan/batches/:id      Full batch detail + review items.
//   POST   /api/bulk-scan/review/:itemId/save   Save a reviewed item to sheet.
//   POST   /api/bulk-scan/review/:itemId/skip   Skip a reviewed item.
//   GET    /api/bulk-scan/folders          Get the user's Drive folder config.
//   PUT    /api/bulk-scan/folders          Update the user's Drive folder config.
//
// The UI layer (PR B) will poll GET /batches/:id for live progress.

import type { Express, Request, Response } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@db';
import { scanBatches, scanBatchItems } from '@shared/schema';
import { requireAuth } from '../auth';
import {
  createBatch,
  runBatch,
  getOrInitFolders,
  setUserFolders,
} from '../bulkScan/processor';
import { getFolderName, fetchThumbnail, listInboxAllFiles } from '../bulkScan/driveClient';
import { appendCardRow } from '../googleSheets';

export function registerBulkScanRoutes(app: Express): void {
  // ── Sync ────────────────────────────────────────────────────────────────
  app.post('/api/bulk-scan/sync', requireAuth, async (req: Request, res: Response) => {
    const userId = (req.user as any)?.id as number | undefined;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const body = (req.body || {}) as { dryRun?: boolean; inboxFolderId?: string; processedFolderId?: string };
    try {
      const batch = await createBatch({
        userId,
        dryRun: !!body.dryRun,
        inboxFolderOverride: body.inboxFolderId,
        processedFolderOverride: body.processedFolderId,
      });
      // Fire-and-forget worker. The caller polls /batches/:id for progress.
      runBatch(batch.id).catch(err =>
        console.error(`[bulkScan/route] runBatch(${batch.id}) failed:`, err),
      );
      return res.json({ batch });
    } catch (err: any) {
      console.error('[bulkScan/route] /sync failed:', err);
      return res.status(500).json({ error: err?.message || 'sync_failed' });
    }
  });

  // ── List batches ────────────────────────────────────────────────────────
  app.get('/api/bulk-scan/batches', requireAuth, async (req: Request, res: Response) => {
    const userId = (req.user as any)?.id as number | undefined;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const rows = await db
      .select()
      .from(scanBatches)
      .where(eq(scanBatches.userId, userId))
      .orderBy(desc(scanBatches.createdAt))
      .limit(50);
    return res.json({ batches: rows });
  });

  // ── Batch detail ────────────────────────────────────────────────────────
  app.get('/api/bulk-scan/batches/:id', requireAuth, async (req: Request, res: Response) => {
    const userId = (req.user as any)?.id as number | undefined;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const batchId = parseInt(req.params.id, 10);
    if (!Number.isFinite(batchId)) return res.status(400).json({ error: 'Invalid batch id' });
    const [batch] = await db
      .select()
      .from(scanBatches)
      .where(and(eq(scanBatches.id, batchId), eq(scanBatches.userId, userId)))
      .limit(1);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const items = await db
      .select()
      .from(scanBatchItems)
      .where(eq(scanBatchItems.batchId, batchId))
      .orderBy(scanBatchItems.position);
    return res.json({ batch, items });
  });

  // ── Delete a batch ──────────────────────────────────────────────────────
  // Wipes the batch row and (via FK cascade) every scan_batch_items row
  // hanging off it. Used to clear out test/dry-run batches and stale
  // history from the UI without touching Drive or the user's sheet.
  //
  // Important caveats the UI surfaces:
  // - We block deletion while status='running' so the worker doesn't try
  //   to update rows that just disappeared underneath it.
  // - Deleting the batch also drops the scan_batch_items rows, which
  //   means any file ids that were tracked here fall out of the
  //   seenFileIds dedup set used by discoverAndPlanItems(). If those
  //   files are still sitting in the Drive inbox they will be picked
  //   up by the next sync as if brand new — same behavior as the
  //   per-item Reprocess endpoint, just at batch granularity.
  // - Auto-saved items already wrote a row to the user's Google Sheet.
  //   Deleting the batch does NOT remove those sheet rows. If the user
  //   then moves the auto-saved files back into the inbox, the next
  //   sync would re-process them and append duplicates. The UI warns
  //   about this when the batch contains any auto_saved items.
  app.delete('/api/bulk-scan/batches/:id', requireAuth, async (req: Request, res: Response) => {
    const userId = (req.user as any)?.id as number | undefined;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const batchId = parseInt(req.params.id, 10);
    if (!Number.isFinite(batchId)) return res.status(400).json({ error: 'Invalid batch id' });
    const [batch] = await db
      .select()
      .from(scanBatches)
      .where(and(eq(scanBatches.id, batchId), eq(scanBatches.userId, userId)))
      .limit(1);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    if (batch.status === 'running') {
      return res.status(409).json({
        error: 'batch_running',
        message:
          "This batch is still running. Wait for it to finish before deleting.",
      });
    }
    // Count auto_saved items so we can include the number in the log
    // line — useful when reconciling sheet history with Holo activity.
    const autoSaved = await db
      .select({ id: scanBatchItems.id })
      .from(scanBatchItems)
      .where(and(eq(scanBatchItems.batchId, batchId), eq(scanBatchItems.status, 'auto_saved')));
    // FK on scan_batch_items.batchId is ON DELETE CASCADE, so dropping
    // the parent row also drops the children in one statement.
    await db.delete(scanBatches).where(eq(scanBatches.id, batchId));
    console.log(
      `[bulkScan/route] /batches/${batchId} DELETE user=${userId} ` +
        `status=${batch.status} fileCount=${batch.fileCount} ` +
        `autoSavedItems=${autoSaved.length} dryRun=${batch.dryRun}`,
    );
    return res.json({ ok: true });
  });

  // ── Review: save a reviewed item ────────────────────────────────────────
  // Accepts the (potentially edited) card form values from the review UI
  // and appends them to the user's active sheet. Rolls the item from
  // 'review' to 'auto_saved' to close the loop.
  app.post('/api/bulk-scan/review/:itemId/save', requireAuth, async (req: Request, res: Response) => {
    const userId = (req.user as any)?.id as number | undefined;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const itemId = parseInt(req.params.itemId, 10);
    if (!Number.isFinite(itemId)) return res.status(400).json({ error: 'Invalid item id' });
    const [item] = await db
      .select()
      .from(scanBatchItems)
      .where(eq(scanBatchItems.id, itemId))
      .limit(1);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // Ownership check: the batch belongs to this user.
    const [batch] = await db
      .select()
      .from(scanBatches)
      .where(and(eq(scanBatches.id, item.batchId), eq(scanBatches.userId, userId)))
      .limit(1);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });

    // The client may send an edited version of the analyzer result; fall
    // back to the stored snapshot if none provided.
    const incoming = (req.body || {}) as Record<string, any>;
    const snapshot = (item.analysisResult || {}) as Record<string, any>;
    const merged = { ...snapshot, ...incoming };

    try {
      await appendCardRow(userId, {
        sport: merged.sport || null,
        year: typeof merged.year === 'number' ? merged.year : null,
        brand: merged.brand || null,
        collection: merged.collection || null,
        set: merged.set || null,
        cardNumber: merged.cardNumber || null,
        cmpNumber: merged.cmpNumber || null,
        player: [merged.playerFirstName, merged.playerLastName].filter(Boolean).join(' ') || null,
        variation: merged.variant || null,
        serialNumber: merged.serialNumber || null,
        isRookieCard: !!merged.isRookieCard,
        isAutographed: !!merged.isAutographed,
        isNumbered: !!merged.isNumbered,
        foilType: merged.foilType || null,
        averagePrice: typeof merged.estimatedValue === 'number' ? merged.estimatedValue : null,
        frontImageUrl: null,
        backImageUrl: null,
        ebaySearchUrl: typeof merged.ebaySearchUrl === 'string' ? merged.ebaySearchUrl : null,
      });
    } catch (err: any) {
      console.error(`[bulkScan/route] /review/:itemId/save append failed:`, err);
      return res.status(500).json({ error: err?.message || 'sheet_append_failed' });
    }

    await db
      .update(scanBatchItems)
      .set({
        status: 'auto_saved',
        analysisResult: merged,
        reviewReasons: null,
        processedAt: new Date(),
      })
      .where(eq(scanBatchItems.id, itemId));

    // Recompute the batch's review queue counter.
    const remaining = await db
      .select({ id: scanBatchItems.id })
      .from(scanBatchItems)
      .where(and(eq(scanBatchItems.batchId, item.batchId), eq(scanBatchItems.status, 'review')));
    await db
      .update(scanBatches)
      .set({ reviewQueueCount: remaining.length })
      .where(eq(scanBatches.id, item.batchId));

    return res.json({ ok: true });
  });

  // ── Review: skip a reviewed item ────────────────────────────────────────
  app.post('/api/bulk-scan/review/:itemId/skip', requireAuth, async (req: Request, res: Response) => {
    const userId = (req.user as any)?.id as number | undefined;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const itemId = parseInt(req.params.itemId, 10);
    if (!Number.isFinite(itemId)) return res.status(400).json({ error: 'Invalid item id' });
    const [item] = await db
      .select()
      .from(scanBatchItems)
      .where(eq(scanBatchItems.id, itemId))
      .limit(1);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const [batch] = await db
      .select()
      .from(scanBatches)
      .where(and(eq(scanBatches.id, item.batchId), eq(scanBatches.userId, userId)))
      .limit(1);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });

    await db
      .update(scanBatchItems)
      .set({ status: 'skipped', processedAt: new Date() })
      .where(eq(scanBatchItems.id, itemId));

    const remaining = await db
      .select({ id: scanBatchItems.id })
      .from(scanBatchItems)
      .where(and(eq(scanBatchItems.batchId, item.batchId), eq(scanBatchItems.status, 'review')));
    await db
      .update(scanBatches)
      .set({ reviewQueueCount: remaining.length })
      .where(eq(scanBatches.id, item.batchId));

    return res.json({ ok: true });
  });

  // ── Item image (Drive thumbnail proxy) ─────────────────────────────────
  // The review queue needs to render the front and back of each card so a
  // dealer can disambiguate at a glance. Browsers can't hit Drive's
  // thumbnailLink directly (it requires an OAuth Bearer token), so we
  // proxy. Cached aggressively in the response headers because Drive file
  // ids are immutable per file content.
  app.get('/api/bulk-scan/items/:itemId/image/:side', requireAuth, async (req: Request, res: Response) => {
    const userId = (req.user as any)?.id as number | undefined;
    if (!userId) return res.status(401).end();
    const itemId = parseInt(req.params.itemId, 10);
    const side = req.params.side === 'front' ? 'front' : 'back';
    if (!Number.isFinite(itemId)) return res.status(400).end();
    const [item] = await db
      .select()
      .from(scanBatchItems)
      .where(eq(scanBatchItems.id, itemId))
      .limit(1);
    if (!item) return res.status(404).end();
    // Ownership check: only the batch owner can fetch the image.
    const [batch] = await db
      .select({ id: scanBatches.id })
      .from(scanBatches)
      .where(and(eq(scanBatches.id, item.batchId), eq(scanBatches.userId, userId)))
      .limit(1);
    if (!batch) return res.status(404).end();
    const fileId = side === 'front' ? item.frontFileId : item.backFileId;
    if (!fileId) {
      console.warn(`[bulkScan/route] /image item=${itemId} side=${side} has no fileId`);
      // Don't let browsers cache failures — they stick around for the
      // full Cache-Control TTL we set on success and prevent recovery
      // after a fix.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).end();
    }
    const thumb = await fetchThumbnail(userId, fileId);
    if (!thumb) {
      console.warn(`[bulkScan/route] /image item=${itemId} side=${side} fileId=${fileId} — fetchThumbnail returned null`);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).end();
    }
    res.setHeader('Content-Type', thumb.contentType);
    // Drive file bytes are stable until the file is edited (which never
    // happens for our scans), so a 1h browser cache is safe and saves us
    // 50+ Drive API calls per review session.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(thumb.bytes);
  });

  // ── Inbox diagnostic ────────────────────────────────────────────────
  // After a sync, files that *aren't* in the processed folder fall into
  // a few buckets and the dealer has no way to tell them apart from the
  // batch detail page. This endpoint lists every file in the inbox and
  // cross-references it against scan_batch_items so each file gets a
  // disposition: not-an-image, queued in this batch, sent to review,
  // skipped, failed, or auto-saved (and the move-to-processed presumably
  // failed). Read-only, so safe to call any time.
  app.get('/api/bulk-scan/inbox-diagnostic', requireAuth, async (req: Request, res: Response) => {
    const userId = (req.user as any)?.id as number | undefined;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const folders = await getOrInitFolders(userId);
    if (!folders?.inboxFolderId) {
      return res.status(400).json({ error: 'No inbox folder configured' });
    }
    const inboxFolderId = folders.inboxFolderId;

    // Pull every file in the inbox (no mimeType filter — we want to see
    // HEIC/PDF/TIFF rejects too).
    let allFiles;
    try {
      allFiles = await listInboxAllFiles(userId, inboxFolderId);
    } catch (err: any) {
      console.error('[bulkScan/route] /inbox-diagnostic listInboxAllFiles failed:', err);
      return res.status(500).json({ error: err?.message || 'drive_list_failed' });
    }

    // Pull every batch item this user has ever produced so we can reverse-
    // lookup any inbox file id. Keyed by Drive file id (a single item row
    // can claim two file ids, one per side). We also pull analysisResult
    // so we can surface the OCR-extracted fields and the SCP probe outcome
    // (query, status, reason, top candidates) for each file — this lets the
    // dealer see *why* OCR / SCP didn't lock onto a clean match without
    // having to dig through server logs.
    const itemRows = await db
      .select({
        id: scanBatchItems.id,
        batchId: scanBatchItems.batchId,
        status: scanBatchItems.status,
        reviewReasons: scanBatchItems.reviewReasons,
        errorMessage: scanBatchItems.errorMessage,
        backFileId: scanBatchItems.backFileId,
        frontFileId: scanBatchItems.frontFileId,
        analysisResult: scanBatchItems.analysisResult,
      })
      .from(scanBatchItems)
      .innerJoin(scanBatches, eq(scanBatchItems.batchId, scanBatches.id))
      .where(eq(scanBatches.userId, userId));
    const itemByFileId = new Map<string, typeof itemRows[number]>();
    for (const it of itemRows) {
      if (it.backFileId) itemByFileId.set(it.backFileId, it);
      if (it.frontFileId) itemByFileId.set(it.frontFileId, it);
    }

    const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png']);
    type Disposition =
      | 'auto_saved_but_not_moved' // happy path failed at the move step
      | 'review' // shows up in review queue
      | 'skipped' // user dismissed in review
      | 'failed' // analyzer error
      | 'pending_or_processing' // worker still running / stuck
      | 'wrong_mimetype' // listInboxImages excluded it
      | 'unknown'; // not in any item row — weird

    // Surfaced subset of analysisResult. Keep this hand-picked so we don't
    // accidentally leak internal scratch flags or balloon the response — the
    // analysisResult jsonb has 30+ fields, most of which are noise to a
    // dealer trying to understand a single failed scan.
    type ItemDetail = {
      ocr: {
        playerName: string | null;
        year: number | null;
        brand: string | null;
        cardNumber: string | null;
        collection: string | null;
        set: string | null;
        foilType: string | null;
        // Tripped gate flags — these are the actual reasons the
        // confidence gate sent the card to review. Mirrored from
        // analysisResult so the UI doesn't need to know about each
        // _* flag individually.
        ambiguityFlags: string[];
      };
      scp: {
        status: 'hit' | 'miss' | 'threw' | 'skipped' | 'unknown';
        reason: string | null;
        matchScore: number | null;
        query: Record<string, string | number | null> | null;
        topCandidates: Array<{ productName: string; consoleName: string; score: number }>;
      };
      ocrText: { front: string | null; back: string | null };
    };
    const buildItemDetail = (analysis: any): ItemDetail | null => {
      if (!analysis || typeof analysis !== 'object') return null;
      const ambiguityFlags: string[] = [];
      if (analysis._cardNumberLowConfidence) ambiguityFlags.push('card_number_low_confidence');
      if (analysis._variationAmbiguous) ambiguityFlags.push('variation_ambiguous');
      if (analysis._collectionAmbiguous) ambiguityFlags.push('collection_ambiguous');
      if (analysis._yearFromBackOnly) ambiguityFlags.push('year_from_back_only');
      if (analysis._yearFromCopyright) ambiguityFlags.push('year_from_copyright');
      if (analysis._yearFromBareFallback) ambiguityFlags.push('year_from_bare_fallback');
      const playerFirst = (analysis.playerFirstName || '').toString().trim();
      const playerLast = (analysis.playerLastName || '').toString().trim();
      const playerName = [playerFirst, playerLast].filter(Boolean).join(' ') || null;
      const scpStatus =
        analysis._scpStatus === 'hit' ||
        analysis._scpStatus === 'miss' ||
        analysis._scpStatus === 'threw' ||
        analysis._scpStatus === 'skipped'
          ? analysis._scpStatus
          : analysis._scpHit === true
            ? 'hit'
            : analysis._scpQuery
              ? 'miss'
              : 'unknown';
      return {
        ocr: {
          playerName,
          year: typeof analysis.year === 'number' ? analysis.year : null,
          brand: analysis.brand || null,
          cardNumber: analysis.cardNumber || null,
          collection: analysis.collection || null,
          set: analysis.set || null,
          foilType: analysis.foilType || null,
          ambiguityFlags,
        },
        scp: {
          status: scpStatus,
          reason: typeof analysis._scpReason === 'string' ? analysis._scpReason : null,
          matchScore: typeof analysis._scpMatchScore === 'number' ? analysis._scpMatchScore : null,
          query: analysis._scpQuery && typeof analysis._scpQuery === 'object' ? analysis._scpQuery : null,
          topCandidates: Array.isArray(analysis._scpTopCandidates) ? analysis._scpTopCandidates : [],
        },
        ocrText: {
          front: typeof analysis._frontOCRText === 'string' ? analysis._frontOCRText : null,
          back: typeof analysis._backOCRText === 'string' ? analysis._backOCRText : null,
        },
      };
    };

    const report = allFiles.map((f) => {
      const item = itemByFileId.get(f.id);
      let disposition: Disposition;
      let reason: string | null = null;
      if (!item) {
        if (!ALLOWED_MIME.has(f.mimeType)) {
          disposition = 'wrong_mimetype';
          reason = `mimeType '${f.mimeType}' not in jpeg/jpg/png — file is silently skipped during sync.`;
        } else {
          disposition = 'unknown';
          reason = 'File is jpeg/png but no batch item references it. Did sync run since this file was added?';
        }
      } else {
        switch (item.status) {
          case 'auto_saved':
            disposition = 'auto_saved_but_not_moved';
            reason =
              'Card was saved to your sheet, but the move to the processed folder failed. Check server logs around this batch for "move back/front file failed".';
            break;
          case 'review':
            disposition = 'review';
            reason = `In review queue. Reasons: ${
              Array.isArray(item.reviewReasons) && item.reviewReasons.length
                ? (item.reviewReasons as unknown[]).join(', ')
                : 'none recorded'
            }`;
            break;
          case 'skipped':
            disposition = 'skipped';
            reason = 'You skipped this card in the review queue. Move or delete the file to clean up the inbox.';
            break;
          case 'failed':
            disposition = 'failed';
            reason = `Analyzer threw: ${item.errorMessage || 'no error message recorded'}`;
            break;
          case 'pending':
          case 'processing':
          default:
            disposition = 'pending_or_processing';
            reason = `Item status is '${item.status}' — either the worker is still running or the batch was interrupted. Try a new sync.`;
            break;
        }
      }
      return {
        fileId: f.id,
        name: f.name,
        mimeType: f.mimeType,
        size: f.size,
        createdTime: f.createdTime,
        disposition,
        reason,
        itemId: item?.id ?? null,
        batchId: item?.batchId ?? null,
        // Full OCR/SCP detail when we have an item row — null otherwise
        // (wrong_mimetype / unknown files never made it through the
        // analyzer so there's nothing to show).
        detail: item ? buildItemDetail((item as any).analysisResult) : null,
      };
    });

    return res.json({
      inboxFolderId,
      totalFiles: allFiles.length,
      files: report,
    });
  });

  // ── Folders config ──────────────────────────────────────────────────────
  app.get('/api/bulk-scan/folders', requireAuth, async (req: Request, res: Response) => {
    const userId = (req.user as any)?.id as number | undefined;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const row = await getOrInitFolders(userId);
    console.log(`[bulkScan] GET /folders user=${userId} row=${row ? JSON.stringify({ id: row.id, inbox: row.inboxFolderId, processed: row.processedFolderId }) : 'null'}`);
    if (!row) {
      return res.json({
        folders: { userId, inboxFolderId: null, processedFolderId: null },
        names: { inbox: null, processed: null },
      });
    }
    const [inboxName, processedName] = await Promise.all([
      row.inboxFolderId ? getFolderName(userId, row.inboxFolderId) : Promise.resolve(null),
      row.processedFolderId ? getFolderName(userId, row.processedFolderId) : Promise.resolve(null),
    ]);
    return res.json({ folders: row, names: { inbox: inboxName, processed: processedName } });
  });

  app.put('/api/bulk-scan/folders', requireAuth, async (req: Request, res: Response) => {
    const userId = (req.user as any)?.id as number | undefined;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const body = (req.body || {}) as { inboxFolderId?: string | null; processedFolderId?: string | null };
    console.log(`[bulkScan] PUT /folders user=${userId} body=${JSON.stringify(body)}`);
    try {
      const updated = await setUserFolders(userId, {
        inboxFolderId: typeof body.inboxFolderId === 'string' ? body.inboxFolderId : body.inboxFolderId ?? null,
        processedFolderId: typeof body.processedFolderId === 'string' ? body.processedFolderId : body.processedFolderId ?? null,
      });
      // Resolve folder names so the /bulk-scan page can display them without
      // a second roundtrip. getFolderName swallows its own errors and returns
      // null on failure (folder deleted / no access), so this can't throw.
      const [inboxName, processedName] = await Promise.all([
        updated.inboxFolderId ? getFolderName(userId, updated.inboxFolderId) : Promise.resolve(null),
        updated.processedFolderId ? getFolderName(userId, updated.processedFolderId) : Promise.resolve(null),
      ]);
      return res.json({ folders: updated, names: { inbox: inboxName, processed: processedName } });
    } catch (err: any) {
      console.error('[bulkScan/route] PUT /folders failed:', err);
      return res.status(500).json({ error: err?.message || 'save_failed' });
    }
  });
}
