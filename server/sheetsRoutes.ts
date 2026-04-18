import type { Express } from 'express';
import { z } from 'zod';
import { requireAuth } from './auth';
import {
  listUserSheets, getActiveSheet, createNewSheet, setActiveSheet,
  renameSheet, unlinkSheet, appendCardRow, NotConnectedError,
} from './googleSheets';
import { getEbaySearchUrl } from './ebayService';

export function registerSheetRoutes(app: Express) {
  app.get('/api/sheets', requireAuth, async (req, res) => {
    const userId = (req.user as any).id as number;
    try {
      const list = await listUserSheets(userId);
      const active = await getActiveSheet(userId);
      res.json({ sheets: list, activeSheetId: active?.id ?? null });
    } catch (err: any) {
      console.error('[sheets] list:', err);
      res.status(500).json({ error: 'Failed to list sheets' });
    }
  });

  app.post('/api/sheets', requireAuth, async (req, res) => {
    const userId = (req.user as any).id as number;
    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required' });
    try {
      const created = await createNewSheet(userId, title);
      res.json({ sheet: created });
    } catch (err: any) {
      if (err instanceof NotConnectedError) return res.status(409).json({ error: 'Connect Google to create sheets.', code: 'GOOGLE_NOT_CONNECTED' });
      console.error('[sheets] create:', err);
      res.status(500).json({ error: err.message || 'Failed to create sheet' });
    }
  });

  app.post('/api/sheets/:id/active', requireAuth, async (req, res) => {
    const userId = (req.user as any).id as number;
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid sheet id' });
    const updated = await setActiveSheet(userId, id);
    if (!updated) return res.status(404).json({ error: 'Sheet not found' });
    res.json({ sheet: updated });
  });

  app.patch('/api/sheets/:id', requireAuth, async (req, res) => {
    const userId = (req.user as any).id as number;
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid sheet id' });
    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required' });
    try {
      const updated = await renameSheet(userId, id, title);
      if (!updated) return res.status(404).json({ error: 'Sheet not found' });
      res.json({ sheet: updated });
    } catch (err: any) {
      if (err instanceof NotConnectedError) return res.status(409).json({ error: 'Connect Google to rename sheets.', code: 'GOOGLE_NOT_CONNECTED' });
      console.error('[sheets] rename:', err);
      res.status(500).json({ error: err.message || 'Failed to rename sheet' });
    }
  });

  app.delete('/api/sheets/:id', requireAuth, async (req, res) => {
    const userId = (req.user as any).id as number;
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid sheet id' });
    const ok = await unlinkSheet(userId, id);
    if (!ok) return res.status(404).json({ error: 'Sheet not found' });
    res.json({ ok: true });
  });

  // Append a card row.
  const appendSchema = z.object({
    sheetId: z.number().optional(),
    card: z.object({
      year: z.union([z.number(), z.string()]).optional().nullable(),
      brand: z.string().optional().nullable(),
      collection: z.string().optional().nullable(),
      set: z.string().optional().nullable(),
      cardNumber: z.string().optional().nullable(),
      player: z.string().optional().nullable(),
      playerFirstName: z.string().optional().nullable(),
      playerLastName: z.string().optional().nullable(),
      variation: z.string().optional().nullable(),
      variant: z.string().optional().nullable(),
      serialNumber: z.string().optional().nullable(),
      isRookieCard: z.boolean().optional().nullable(),
      isAutographed: z.boolean().optional().nullable(),
      isNumbered: z.boolean().optional().nullable(),
      foilType: z.string().optional().nullable(),
      averagePrice: z.union([z.number(), z.string()]).optional().nullable(),
      frontImageUrl: z.string().optional().nullable(),
      backImageUrl: z.string().optional().nullable(),
      ebaySearchUrl: z.string().optional().nullable(),
    }),
  });

  app.post('/api/sheets/append', requireAuth, async (req, res) => {
    const userId = (req.user as any).id as number;
    try {
      const parsed = appendSchema.parse(req.body);
      const c = parsed.card;
      const player = c.player
        || [c.playerFirstName, c.playerLastName].filter(Boolean).join(' ').trim()
        || '';
      const variation = c.variation || c.variant || '';
      // Build absolute URLs for image links so they work outside the app.
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const absolutize = (u?: string | null) => {
        if (!u) return '';
        if (/^https?:\/\//i.test(u)) return u;
        return baseUrl + (u.startsWith('/') ? u : '/' + u);
      };
      // If no eBay URL provided, build one from the card data.
      const yr = typeof c.year === 'number' ? c.year : (c.year ? parseInt(String(c.year), 10) || 0 : 0);
      const ebayUrl = c.ebaySearchUrl || (c.brand ? getEbaySearchUrl(
        player, c.cardNumber || '', c.brand || '', yr, c.collection || '', '',
        !!c.isNumbered, c.foilType || '', c.serialNumber || '',
      ) : '');
      const result = await appendCardRow(userId, {
        year: c.year ?? null,
        brand: c.brand ?? null,
        collection: c.collection ?? null,
        set: c.set ?? null,
        cardNumber: c.cardNumber ?? null,
        player,
        variation,
        serialNumber: c.serialNumber ?? null,
        isRookieCard: c.isRookieCard ?? false,
        isAutographed: c.isAutographed ?? false,
        isNumbered: c.isNumbered ?? false,
        foilType: c.foilType ?? null,
        averagePrice: c.averagePrice ?? null,
        frontImageUrl: absolutize(c.frontImageUrl),
        backImageUrl: absolutize(c.backImageUrl),
        ebaySearchUrl: ebayUrl,
      }, parsed.sheetId);
      res.json({ ok: true, sheet: result.sheet, sheetUrl: result.sheetUrl });
    } catch (err: any) {
      if (err instanceof NotConnectedError) {
        return res.status(409).json({ error: 'Connect Google first.', code: 'GOOGLE_NOT_CONNECTED' });
      }
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.errors[0]?.message || 'Invalid input' });
      }
      console.error('[sheets] append:', err);
      res.status(500).json({ error: err.message || 'Failed to append row' });
    }
  });
}
