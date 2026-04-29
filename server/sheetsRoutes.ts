import type { Express } from 'express';
import { z } from 'zod';
import { requireAuth } from './auth';
import {
  listUserSheets, getActiveSheet, createNewSheet, setActiveSheet,
  renameSheet, unlinkSheet, appendCardRow, countRowsForSheet, NotConnectedError,
} from './googleSheets';
import { getEbaySearchUrl } from './ebayService';
import { storage } from './storage';
import { logUserScan, updateUserScan, type ScanFieldValues } from './userScans';
import type { UserScanAction } from '@shared/schema';

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

  // Count the data rows in a specific sheet — used by the MySheets page to
  // show an accurate "N cards" label for the active sheet. The legacy
  // /api/collection/summary value reflects the local cards table which is
  // no longer the source of truth now that every add writes to Google
  // Sheets, so this endpoint reads from the spreadsheet directly.
  app.get('/api/sheets/:id/count', requireAuth, async (req, res) => {
    const userId = (req.user as any).id as number;
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid sheet id' });
    try {
      const count = await countRowsForSheet(userId, id);
      res.json({ count });
    } catch (err: any) {
      if (err instanceof NotConnectedError) {
        return res.status(409).json({ error: 'Connect Google first.', code: 'GOOGLE_NOT_CONNECTED' });
      }
      console.error('[sheets] count:', err);
      res.status(500).json({ error: err.message || 'Failed to count rows' });
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
  // Optional `_scanTracking` blob carried alongside the card payload. The
  // client sets this when the user used 👍 / 👎 on the scan-result screen so
  // we can log the save into `user_scans` with the right userAction tag and
  // the original detected-fields snapshot for diffing. None of this affects
  // the actual sheet write — it's purely for the per-save audit log.
  const scanFieldValuesSchema = z.object({
    sport: z.string().optional().nullable(),
    playerFirstName: z.string().optional().nullable(),
    playerLastName: z.string().optional().nullable(),
    brand: z.string().optional().nullable(),
    collection: z.string().optional().nullable(),
    set: z.string().optional().nullable(),
    cardNumber: z.string().optional().nullable(),
    year: z.union([z.number(), z.string()]).optional().nullable(),
    variant: z.string().optional().nullable(),
    team: z.string().optional().nullable(),
    cmpNumber: z.string().optional().nullable(),
    serialNumber: z.string().optional().nullable(),
    foilType: z.string().optional().nullable(),
    isRookie: z.boolean().optional().nullable(),
    isAuto: z.boolean().optional().nullable(),
    isNumbered: z.boolean().optional().nullable(),
    isFoil: z.boolean().optional().nullable(),
  }).partial();

  const scanTrackingSchema = z.object({
    userAction: z.enum(['confirmed', 'declined_edited', 'saved_no_feedback']),
    detected: scanFieldValuesSchema.optional(),
    scpScore: z.number().optional().nullable(),
    scpMatchedTitle: z.string().optional().nullable(),
    cardDbCorroborated: z.boolean().optional().nullable(),
    analyzerVersion: z.string().optional().nullable(),
    // Audit-row id from the analyze response. When present we UPDATE the
    // analyzed_no_save row in user_scans instead of inserting a new one,
    // so a single scan produces a single ledger row.
    _userScanId: z.union([z.number().int().positive(), z.string().min(1)]).optional().nullable(),
  });

  const appendSchema = z.object({
    sheetId: z.number().optional(),
    card: z.object({
      sport: z.string().optional().nullable(),
      year: z.union([z.number(), z.string()]).optional().nullable(),
      brand: z.string().optional().nullable(),
      collection: z.string().optional().nullable(),
      set: z.string().optional().nullable(),
      cardNumber: z.string().optional().nullable(),
      cmpNumber: z.string().optional().nullable(),
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
      subset: z.string().optional().nullable(),
      averagePrice: z.union([z.number(), z.string()]).optional().nullable(),
      frontImageUrl: z.string().optional().nullable(),
      backImageUrl: z.string().optional().nullable(),
      ebaySearchUrl: z.string().optional().nullable(),
      _scanTracking: scanTrackingSchema.optional(),
    }),
  });

  // The client may hand us captured photos as raw "data:image/...;base64,..."
  // URIs. Persist them to /uploads so we can write a real, openable link into
  // the spreadsheet (and avoid the 50,000 char-per-cell ceiling).
  async function persistDataUriIfNeeded(
    value: string | null | undefined,
    label: 'front' | 'back',
  ): Promise<string | null | undefined> {
    if (!value || !value.startsWith('data:')) return value;
    try {
      const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,/i.exec(value);
      const ext = (m?.[1] || 'jpg').toLowerCase().replace('jpeg', 'jpg');
      const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${label}.${ext}`;
      return await storage.saveImage(value, filename);
    } catch (err) {
      console.error(`[sheets] failed to persist ${label} image:`, err);
      return null;
    }
  }

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
      // Always rebuild the Sheet's eBay URL server-side from the canonical
      // card fields. Do NOT prefer `c.ebaySearchUrl` from the client — the
      // client-side picker URL substitutes subset for player (PR #193) and
      // would poison the Sheet path with rows like
      // `1987 Topps "604" "NL Leaders"` instead of the actual player.
      const yr = typeof c.year === 'number' ? c.year : (c.year ? parseInt(String(c.year), 10) || 0 : 0);
      const ebayUrl = c.brand ? getEbaySearchUrl(
        player, c.cardNumber || '', c.brand || '', yr, c.collection || '', '',
        !!c.isNumbered, c.foilType || '', c.serialNumber || '',
        (c as any).variant || '', c.set || '',
        undefined, // gradeKeyword — sheet link is always raw asking
        !!(c as any).isAutographed,
        false, // excludeGraded — keep sheet links broad; tile links are tier-specific
        c.subset || '',
      ) : (c.ebaySearchUrl || '');
      const frontStored = await persistDataUriIfNeeded(c.frontImageUrl, 'front');
      const backStored = await persistDataUriIfNeeded(c.backImageUrl, 'back');
      const result = await appendCardRow(userId, {
        sport: c.sport ?? null,
        year: c.year ?? null,
        brand: c.brand ?? null,
        collection: c.collection ?? null,
        set: c.set ?? null,
        cardNumber: c.cardNumber ?? null,
        cmpNumber: c.cmpNumber ?? null,
        player,
        variation,
        serialNumber: c.serialNumber ?? null,
        isRookieCard: c.isRookieCard ?? false,
        isAutographed: c.isAutographed ?? false,
        isNumbered: c.isNumbered ?? false,
        foilType: c.foilType ?? null,
        averagePrice: c.averagePrice ?? null,
        frontImageUrl: absolutize(frontStored),
        backImageUrl: absolutize(backStored),
        ebaySearchUrl: ebayUrl,
      }, parsed.sheetId);

      // Best-effort log to user_scans. The sheet write is the user's primary
      // success signal — never block on or fail it because of audit logging.
      // We don't have a `cards.id` here (this path writes to the user's
      // Google Sheet, not the local DB), so cardId stays null. The detected
      // snapshot is whatever the client captured at scan-result render time;
      // when it's missing (older client) we fall back to using `final` as
      // both detected and final, which yields fieldsChanged=[] but still
      // captures the row for review.
      const tracking = c._scanTracking;
      const toYearNum = (y: number | string | null | undefined): number | null => {
        if (y === null || y === undefined || y === '') return null;
        if (typeof y === 'number') return Number.isFinite(y) ? y : null;
        const n = Number.parseInt(String(y), 10);
        return Number.isFinite(n) ? n : null;
      };
      const yrNum = toYearNum(c.year ?? null);
      const detectedSnapshot: ScanFieldValues | undefined = tracking?.detected
        ? { ...tracking.detected, year: toYearNum(tracking.detected.year ?? null) }
        : undefined;
      const finalValues: ScanFieldValues = {
        sport: c.sport ?? null,
        playerFirstName: c.playerFirstName ?? null,
        playerLastName: c.playerLastName ?? null,
        brand: c.brand ?? null,
        collection: c.collection ?? null,
        set: c.set ?? null,
        cardNumber: c.cardNumber ?? null,
        year: yrNum,
        variant: (c.variant ?? c.variation) ?? null,
        team: null,
        cmpNumber: c.cmpNumber ?? null,
        serialNumber: c.serialNumber ?? null,
        foilType: c.foilType ?? null,
        isRookie: c.isRookieCard ?? null,
        isAuto: c.isAutographed ?? null,
        isNumbered: c.isNumbered ?? null,
        isFoil: null,
      };
      const action: UserScanAction = tracking?.userAction ?? 'saved_no_feedback';
      const logParams = {
        userId,
        cardId: null,
        userAction: action,
        detected: detectedSnapshot ?? finalValues,
        final: finalValues,
        frontImage: absolutize(frontStored) || null,
        backImage: absolutize(backStored) || null,
        scpScore: tracking?.scpScore ?? null,
        scpMatchedTitle: tracking?.scpMatchedTitle ?? null,
        cardDbCorroborated: tracking?.cardDbCorroborated ?? null,
        analyzerVersion: tracking?.analyzerVersion ?? null,
        // Forward the original detected blob the client tracked at
        // scan-result render time. updateUserScan never overwrites an
        // existing geminiSnapshot, so this only matters for the fresh-
        // insert fallback path (older clients without _userScanId, or
        // when the analyze-time row went missing).
        geminiSnapshot: detectedSnapshot ?? null,
        // 👍 means "all fields verified" — record empty diff regardless of
        // string-coercion noise between detected and final.
        fieldsChangedOverride: action === 'confirmed' ? [] : undefined,
      };
      // Promote the analyze-time row when the client passed back the audit
      // id from the analyze response. Falls back to a fresh insert when the
      // id is missing (older clients) or the row no longer exists (logging
      // failed at analyze time, or the analyzed_no_save row was somehow
      // pruned). Either way we end up with one row representing the save.
      const userScanId = (tracking as any)?._userScanId;
      const hasNumericRef = typeof userScanId === 'number' && userScanId > 0;
      const hasStringRef = typeof userScanId === 'string' && userScanId.length > 0;
      if (hasNumericRef || hasStringRef) {
        updateUserScan(userScanId as number | string, logParams).then((updated) => {
          if (!updated) {
            // Stale id — row missing. Fall through to a clean insert so the
            // save still gets recorded.
            logUserScan(logParams).catch(() => {});
          }
        }).catch(() => {});
      } else {
        logUserScan(logParams).catch(() => {});
      }

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
