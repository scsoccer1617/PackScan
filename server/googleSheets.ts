import { google, sheets_v4, drive_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db';
import { users, userSheets, type User, type UserSheet } from '../shared/schema';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

// Column order mirrors the on-screen "Card Information" panel so the sheet
// reads the same way the app does. Keep buildRow() in lock-step.
export const SHEET_HEADERS = [
  'Date scanned', 'Sport', 'Player', 'Year', 'Brand', 'Card #', 'CMP code',
  'Set', 'Collection', 'Parallel', 'Serial #', 'Variant',
  'Rookie', 'Auto', 'Numbered',
  'Average eBay price', 'Front image link', 'Back image link', 'eBay search URL',
];

export class NotConnectedError extends Error {
  constructor() { super('User has not connected a Google account.'); }
}

async function getOAuthClient(userId: number): Promise<{ oauth: OAuth2Client; user: User }> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth is not configured on this server.');
  }
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw new Error('User not found');
  if (!u.googleAccessToken && !u.googleRefreshToken) throw new NotConnectedError();
  const oauth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth.setCredentials({
    access_token: u.googleAccessToken || undefined,
    refresh_token: u.googleRefreshToken || undefined,
    expiry_date: u.googleTokenExpiresAt ? new Date(u.googleTokenExpiresAt).getTime() : undefined,
  });
  // Persist refreshed tokens automatically.
  oauth.on('tokens', async (tokens) => {
    try {
      const update: any = {};
      if (tokens.access_token) update.googleAccessToken = tokens.access_token;
      if (tokens.refresh_token) update.googleRefreshToken = tokens.refresh_token;
      if (tokens.expiry_date) update.googleTokenExpiresAt = new Date(tokens.expiry_date);
      if (Object.keys(update).length) await db.update(users).set(update).where(eq(users.id, userId));
    } catch (err) {
      console.error('[googleSheets] failed to persist refreshed tokens:', err);
    }
  });
  return { oauth, user: u };
}

function sheetsFor(oauth: OAuth2Client) { return google.sheets({ version: 'v4', auth: oauth }); }
function driveFor(oauth: OAuth2Client) { return google.drive({ version: 'v3', auth: oauth }); }

async function createSheetWithHeader(
  oauth: OAuth2Client,
  title: string,
): Promise<{ spreadsheetId: string; title: string }> {
  const sheets = sheetsFor(oauth);
  const create = await sheets.spreadsheets.create({
    requestBody: { properties: { title } },
    fields: 'spreadsheetId,properties.title,sheets.properties.sheetId',
  });
  const spreadsheetId = create.data.spreadsheetId!;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'A1',
    valueInputOption: 'RAW',
    requestBody: { values: [SHEET_HEADERS] },
  });
  // Header is intentionally left unformatted (no bold, no freeze) per user
  // preference — they want a plain sheet they can style however they like.
  const sheetId = create.data.sheets?.[0]?.properties?.sheetId ?? 0;
  await applyPriceColumnCurrencyFormat(oauth, spreadsheetId, sheetId);
  return { spreadsheetId, title: create.data.properties?.title || title };
}

// Index of the "Average eBay price" column in SHEET_HEADERS — kept as a
// derived constant so reordering SHEET_HEADERS automatically moves the
// formatting target.
const PRICE_COLUMN_INDEX = SHEET_HEADERS.indexOf('Average eBay price');

// Apply a USD currency number format to the price column starting at row 2
// (row index 1, skipping the header). Idempotent — calling it repeatedly on
// the same sheet just re-asserts the same format. Best-effort: any failure
// is logged and swallowed so a transient Sheets error never blocks a sync.
async function applyPriceColumnCurrencyFormat(
  oauth: OAuth2Client,
  spreadsheetId: string,
  sheetId: number,
) {
  if (PRICE_COLUMN_INDEX < 0) return;
  const sheets = sheetsFor(oauth);
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 1,
                startColumnIndex: PRICE_COLUMN_INDEX,
                endColumnIndex: PRICE_COLUMN_INDEX + 1,
              },
              cell: {
                userEnteredFormat: {
                  numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' },
                },
              },
              fields: 'userEnteredFormat.numberFormat',
            },
          },
        ],
      },
    });
  } catch (err) {
    console.error('[googleSheets] applyPriceColumnCurrencyFormat failed:', err);
  }
}

// Resolve the gid (sheetId) of the first tab in a spreadsheet. Needed for
// batchUpdate range requests because the userSheets row only stores the
// spreadsheet id, not the per-tab numeric sheetId. Cached per spreadsheet
// for the process lifetime — gid never changes for the first tab.
const firstTabSheetIdCache = new Map<string, number>();
async function getFirstTabSheetId(
  oauth: OAuth2Client,
  spreadsheetId: string,
): Promise<number | null> {
  const cached = firstTabSheetIdCache.get(spreadsheetId);
  if (cached != null) return cached;
  try {
    const sheets = sheetsFor(oauth);
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties.sheetId',
    });
    const id = meta.data.sheets?.[0]?.properties?.sheetId;
    if (id == null) return null;
    firstTabSheetIdCache.set(spreadsheetId, id);
    return id;
  } catch (err) {
    console.error('[googleSheets] getFirstTabSheetId failed:', err);
    return null;
  }
}

// Idempotently ensure row 1 of an existing sheet matches SHEET_HEADERS. Run
// before every append so legacy sheets created under an older column order
// re-align to the current layout (otherwise data rows would land in the
// wrong columns after we change the header).
async function syncHeaderRow(oauth: OAuth2Client, spreadsheetId: string) {
  const sheets = sheetsFor(oauth);
  try {
    const got = await sheets.spreadsheets.values.get({ spreadsheetId, range: '1:1' });
    const current = (got.data.values?.[0] || []) as string[];
    const matches =
      current.length === SHEET_HEADERS.length &&
      SHEET_HEADERS.every((h, i) => current[i] === h);
    if (matches) return;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'A1',
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS] },
    });
  } catch (err) {
    console.error('[googleSheets] syncHeaderRow failed:', err);
  }
}

export async function ensureDefaultSheetForUser(userId: number) {
  try {
    const existing = await db.select().from(userSheets).where(eq(userSheets.userId, userId)).limit(1);
    if (existing.length > 0) return existing[0];
    const { oauth } = await getOAuthClient(userId);
    const { spreadsheetId, title } = await createSheetWithHeader(oauth, 'PackScan Collection');
    const [created] = await db.insert(userSheets).values({
      userId, googleSheetId: spreadsheetId, title, isDefault: true,
    }).returning();
    return created;
  } catch (err: any) {
    if (err instanceof NotConnectedError) return null;
    console.error('[googleSheets] ensureDefaultSheetForUser:', err?.message || err);
    return null;
  }
}

export async function listUserSheets(userId: number): Promise<UserSheet[]> {
  return await db.select().from(userSheets).where(eq(userSheets.userId, userId)).orderBy(desc(userSheets.isDefault), desc(userSheets.createdAt));
}

export async function getActiveSheet(userId: number): Promise<UserSheet | null> {
  const rows = await db.select().from(userSheets).where(and(eq(userSheets.userId, userId), eq(userSheets.isDefault, true))).limit(1);
  if (rows[0]) return rows[0];
  const any = await db.select().from(userSheets).where(eq(userSheets.userId, userId)).limit(1);
  return any[0] || null;
}

export async function createNewSheet(userId: number, title: string): Promise<UserSheet> {
  const cleanTitle = title.trim() || 'PackScan Sheet';
  const { oauth } = await getOAuthClient(userId);
  const { spreadsheetId, title: actualTitle } = await createSheetWithHeader(oauth, cleanTitle);
  const existing = await db.select().from(userSheets).where(eq(userSheets.userId, userId));
  const isFirst = existing.length === 0;
  const [created] = await db.insert(userSheets).values({
    userId, googleSheetId: spreadsheetId, title: actualTitle, isDefault: isFirst,
  }).returning();
  return created;
}

export async function setActiveSheet(userId: number, sheetRowId: number): Promise<UserSheet | null> {
  const [target] = await db.select().from(userSheets).where(and(eq(userSheets.id, sheetRowId), eq(userSheets.userId, userId))).limit(1);
  if (!target) return null;
  await db.update(userSheets).set({ isDefault: false }).where(eq(userSheets.userId, userId));
  await db.update(userSheets).set({ isDefault: true }).where(eq(userSheets.id, sheetRowId));
  const [reread] = await db.select().from(userSheets).where(eq(userSheets.id, sheetRowId)).limit(1);
  return reread;
}

export async function renameSheet(userId: number, sheetRowId: number, newTitle: string): Promise<UserSheet | null> {
  const cleanTitle = newTitle.trim();
  if (!cleanTitle) return null;
  const [target] = await db.select().from(userSheets).where(and(eq(userSheets.id, sheetRowId), eq(userSheets.userId, userId))).limit(1);
  if (!target) return null;
  try {
    const { oauth } = await getOAuthClient(userId);
    const drive = driveFor(oauth);
    await drive.files.update({ fileId: target.googleSheetId, requestBody: { name: cleanTitle } });
  } catch (err) {
    console.error('[googleSheets] rename via Drive failed:', err);
  }
  await db.update(userSheets).set({ title: cleanTitle }).where(eq(userSheets.id, sheetRowId));
  const [reread] = await db.select().from(userSheets).where(eq(userSheets.id, sheetRowId)).limit(1);
  return reread;
}

export async function unlinkSheet(userId: number, sheetRowId: number): Promise<boolean> {
  const [target] = await db.select().from(userSheets).where(and(eq(userSheets.id, sheetRowId), eq(userSheets.userId, userId))).limit(1);
  if (!target) return false;
  const wasDefault = target.isDefault;
  await db.delete(userSheets).where(eq(userSheets.id, sheetRowId));
  if (wasDefault) {
    const [next] = await db.select().from(userSheets).where(eq(userSheets.userId, userId)).orderBy(desc(userSheets.createdAt)).limit(1);
    if (next) await db.update(userSheets).set({ isDefault: true }).where(eq(userSheets.id, next.id));
  }
  return true;
}

export interface CardRowInput {
  sport?: string | null;
  year?: number | string | null;
  brand?: string | null;
  collection?: string | null;
  set?: string | null;
  cardNumber?: string | null;
  cmpNumber?: string | null;
  player?: string | null;
  variation?: string | null;
  serialNumber?: string | null;
  isRookieCard?: boolean | null;
  isAutographed?: boolean | null;
  isNumbered?: boolean | null;
  foilType?: string | null;
  averagePrice?: number | string | null;
  frontImageUrl?: string | null;
  backImageUrl?: string | null;
  ebaySearchUrl?: string | null;
}

function fmtBool(b: boolean | null | undefined) { return b ? 'Yes' : 'No'; }

// Sheets caps individual cells at 50,000 characters. Defensive guard so that
// a stray base64 "data:" URI from the client (or any pasted huge string) can
// never blow up an append call. Hosted http(s) URLs and short text pass
// through unchanged.
function safeCellValue(value: string | null | undefined): string {
  if (!value) return '';
  if (value.length <= 49000) return value;
  if (/^data:/i.test(value)) return '';
  return value.slice(0, 49000);
}

export function buildRow(input: CardRowInput): (string | number)[] {
  const dateScanned = new Date().toISOString().slice(0, 10);
  // Write price as a raw number so Sheets keeps the numeric type and the
  // column-level currency format ("$1.61") renders correctly. Strings like
  // "1.61" would otherwise survive USER_ENTERED parsing but defeat sorting
  // when mixed with edge cases. Falls back to '' for unknown / empty.
  let price: string | number = '';
  if (input.averagePrice != null && input.averagePrice !== '') {
    const n = typeof input.averagePrice === 'number'
      ? input.averagePrice
      : Number(input.averagePrice);
    price = Number.isFinite(n) ? n : '';
  }
  // Order MUST match SHEET_HEADERS exactly.
  return [
    dateScanned,
    input.sport ?? '',
    input.player ?? '',
    input.year ?? '',
    input.brand ?? '',
    input.cardNumber ?? '',
    input.cmpNumber ?? '',
    input.set ?? '',
    input.collection ?? '',
    input.foilType ?? '',
    input.serialNumber ?? '',
    input.variation ?? '',
    fmtBool(input.isRookieCard),
    fmtBool(input.isAutographed),
    fmtBool(input.isNumbered),
    price,
    safeCellValue(input.frontImageUrl),
    safeCellValue(input.backImageUrl),
    safeCellValue(input.ebaySearchUrl),
  ];
}

// ── Read helpers ─────────────────────────────────────────────────────────────
// PackScan treats the active Google Sheet as the source of truth for saved
// cards. The local `cards` table is still written for legacy reasons but it
// no longer receives new data, so any endpoint that powers Collection value,
// Collection tab, or Stats has to read from the sheet.

/**
 * Parsed shape of one data row in a PackScan-shaped Google Sheet. Field
 * names mirror SHEET_HEADERS / buildRow and the client `CardWithRelations`
 * contract so the UI can consume rows without a second translation layer.
 */
export interface SheetCardRow {
  /** Stable id — "<sheetId>-<rowIndex>" — for React keys. Rows have no DB id. */
  id: string;
  rowIndex: number;
  createdAt: string | null;
  sport: { name: string } | null;
  brand: { name: string } | null;
  playerFirstName: string;
  playerLastName: string;
  year: number | null;
  collection: string | null;
  set: string | null;
  cardNumber: string | null;
  cmpNumber: string | null;
  variant: string | null;
  serialNumber: string | null;
  foilType: string | null;
  isRookieCard: boolean;
  isAutographed: boolean;
  isNumbered: boolean;
  estimatedValue: string | null;
  frontImage: string | null;
  backImage: string | null;
  ebaySearchUrl: string | null;
}

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === '1' || s === 'y';
}

function parseInt10(v: string | undefined): number | null {
  if (!v) return null;
  const n = parseInt(String(v).trim(), 10);
  return isNaN(n) ? null : n;
}

function parsePlayerName(raw: string): { first: string; last: string } {
  const s = (raw || '').trim();
  if (!s) return { first: '', last: '' };
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { first: '', last: parts[0] };
  const first = parts[0];
  const last = parts.slice(1).join(' ');
  return { first, last };
}

/**
 * Parse one sheet row (the shape Google returns — a string[] aligned to
 * SHEET_HEADERS) into the card shape the UI expects. Returns null for
 * rows that are entirely empty so the caller can filter them out.
 */
function parseSheetRow(
  values: string[],
  rowIndex: number,
  sheetId: string,
): SheetCardRow | null {
  // Column order mirrors SHEET_HEADERS exactly:
  //   0 Date scanned, 1 Sport, 2 Player, 3 Year, 4 Brand, 5 Card #, 6 CMP,
  //   7 Set, 8 Collection, 9 Parallel, 10 Serial #, 11 Variant,
  //   12 Rookie, 13 Auto, 14 Numbered,
  //   15 Avg eBay price, 16 Front link, 17 Back link, 18 eBay search URL.
  const get = (i: number) => (values[i] ?? '').toString().trim();
  const player = get(2);
  const sport = get(1);
  const brand = get(4);
  // Treat the row as empty only when every meaningful identity column is
  // blank — protects against header-only rows and stray whitespace.
  if (!player && !sport && !brand && !get(5)) return null;
  const { first, last } = parsePlayerName(player);
  // "Date scanned" is ISO yyyy-mm-dd; hydrate to a full ISO string so the
  // client's `new Date(createdAt)` parse behaves.
  const dateStr = get(0);
  let createdAt: string | null = null;
  if (dateStr) {
    const dt = new Date(`${dateStr}T00:00:00`);
    createdAt = isNaN(dt.getTime()) ? null : dt.toISOString();
  }
  const priceRaw = get(15);
  const estimatedValue = priceRaw && !isNaN(Number(priceRaw)) ? Number(priceRaw).toFixed(2) : null;
  return {
    id: `${sheetId}-${rowIndex}`,
    rowIndex,
    createdAt,
    sport: sport ? { name: sport } : null,
    brand: brand ? { name: brand } : null,
    playerFirstName: first,
    playerLastName: last,
    year: parseInt10(get(3)),
    collection: get(8) || null,
    set: get(7) || null,
    cardNumber: get(5) || null,
    cmpNumber: get(6) || null,
    variant: get(11) || null,
    serialNumber: get(10) || null,
    foilType: get(9) || null,
    isRookieCard: parseBool(get(12)),
    isAutographed: parseBool(get(13)),
    isNumbered: parseBool(get(14)),
    estimatedValue,
    frontImage: get(16) || null,
    backImage: get(17) || null,
    ebaySearchUrl: get(18) || null,
  };
}

// Tiny in-memory TTL cache keyed by (userId, sheetId). The aggregate
// endpoints (/api/cards, /api/collection/summary, /api/stats/*) all fire
// back-to-back on page load — without a cache that's 4–5 Google round
// trips per navigation. 15s TTL is short enough that a just-appended row
// shows up quickly but long enough to absorb a page load.
type RowsCacheEntry = { rows: SheetCardRow[]; fetchedAt: number };
const rowsCache = new Map<string, RowsCacheEntry>();
const ROWS_TTL_MS = 15_000;

function rowsCacheKey(userId: number, sheetId: string) {
  return `${userId}:${sheetId}`;
}

/**
 * Invalidate the read cache for a user's active sheet. Call after any
 * mutation that would change row contents (append, delete, import) so the
 * next read sees the fresh state instead of serving a stale snapshot.
 */
export function invalidateSheetRowsCache(userId: number, sheetId?: string) {
  if (sheetId) {
    rowsCache.delete(rowsCacheKey(userId, sheetId));
    return;
  }
  // No sheetId — drop every entry for this user.
  const prefix = `${userId}:`;
  rowsCache.forEach((_v, key) => {
    if (key.startsWith(prefix)) rowsCache.delete(key);
  });
}

/**
 * Read every data row from the user's active sheet and return them as
 * SheetCardRow[]. Returns [] if the user has no active sheet, no Google
 * connection, or the sheet is empty. Never throws NotConnectedError —
 * swallows it so the Home/Collection/Stats pages render gracefully for
 * users who haven't finished OAuth.
 */
export async function getActiveSheetRows(userId: number): Promise<SheetCardRow[]> {
  try {
    const active = await getActiveSheet(userId);
    if (!active) return [];
    const cacheKey = rowsCacheKey(userId, active.googleSheetId);
    const cached = rowsCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < ROWS_TTL_MS) {
      return cached.rows;
    }
    const { oauth } = await getOAuthClient(userId);
    const sheets = sheetsFor(oauth);
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: active.googleSheetId,
      range: `A:${String.fromCharCode(65 + SHEET_HEADERS.length - 1)}`,
      majorDimension: 'ROWS',
    });
    const values = got.data.values || [];
    // Skip row 0 (header). Row index in the sheet is 1-based; we pass the
    // 1-based sheet row (i + 1 from values.slice(1)) so ids are stable.
    const rows: SheetCardRow[] = [];
    for (let i = 1; i < values.length; i++) {
      const parsed = parseSheetRow(values[i] as string[], i + 1, active.googleSheetId);
      if (parsed) rows.push(parsed);
    }
    rowsCache.set(cacheKey, { rows, fetchedAt: Date.now() });
    return rows;
  } catch (err: any) {
    if (err instanceof NotConnectedError) return [];
    console.error('[googleSheets] getActiveSheetRows failed:', err?.message || err);
    return [];
  }
}

/**
 * Count the number of data rows (excluding the header row) in a user's
 * spreadsheet. Used by the MySheets page so the "N cards" label reflects
 * what's actually in the Google Sheet rather than the legacy local cards
 * table — PackScan treats Sheets as the source of truth for saved cards,
 * so only the sheet knows the real count.
 *
 * Returns 0 for empty sheets and — best-effort — 0 if the row read fails.
 * Throws NotConnectedError if the user hasn't connected Google yet.
 */
export async function countRowsForSheet(
  userId: number,
  sheetRowId: number,
): Promise<number> {
  const [row] = await db
    .select()
    .from(userSheets)
    .where(and(eq(userSheets.id, sheetRowId), eq(userSheets.userId, userId)))
    .limit(1);
  if (!row) return 0;
  const { oauth } = await getOAuthClient(userId);
  const sheets = sheetsFor(oauth);
  try {
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: row.googleSheetId,
      // Column A is always populated (Sport) for a valid data row.
      range: 'A:A',
      majorDimension: 'ROWS',
    });
    const values = got.data.values || [];
    // Header row counts as 1; only non-empty rows beyond it are data rows.
    const dataRows = values.slice(1).filter((r) => (r?.[0] || '').toString().trim().length > 0);
    return dataRows.length;
  } catch (err: any) {
    console.error('[googleSheets] countRowsForSheet failed:', err?.message || err);
    return 0;
  }
}

export async function appendCardRow(
  userId: number,
  card: CardRowInput,
  targetSheetRowId?: number,
): Promise<{ sheet: UserSheet; sheetUrl: string }> {
  let sheet: UserSheet | null;
  if (targetSheetRowId) {
    const [t] = await db.select().from(userSheets).where(and(eq(userSheets.id, targetSheetRowId), eq(userSheets.userId, userId))).limit(1);
    sheet = t || null;
  } else {
    sheet = await getActiveSheet(userId);
  }
  if (!sheet) {
    // No sheets yet — try to create the default one now (user must have Google connected).
    const created = await ensureDefaultSheetForUser(userId);
    if (!created) throw new NotConnectedError();
    sheet = created;
  }
  const { oauth } = await getOAuthClient(userId);
  const sheets = sheetsFor(oauth);
  await syncHeaderRow(oauth, sheet.googleSheetId);
  // Idempotent safety net so existing user sheets (created before this
  // change) get the currency format retroactively on their next sync.
  const firstTabId = await getFirstTabSheetId(oauth, sheet.googleSheetId);
  if (firstTabId != null) {
    await applyPriceColumnCurrencyFormat(oauth, sheet.googleSheetId, firstTabId);
  }
  const row = buildRow(card);
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheet.googleSheetId,
    range: 'A1',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheet.googleSheetId}`;
  // Any new row means the TTL cache for this sheet is stale — clear it so
  // the next aggregate read (e.g. Home reloading /api/collection/summary
  // right after a save) sees the row immediately instead of waiting out
  // the 15s TTL.
  invalidateSheetRowsCache(userId, sheet.googleSheetId);
  return { sheet, sheetUrl };
}
