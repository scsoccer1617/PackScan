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
import { getFolderName } from '../bulkScan/driveClient';
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
        ebaySearchUrl: null,
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
