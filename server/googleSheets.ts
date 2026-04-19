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
    fields: 'spreadsheetId,properties.title',
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
  return { spreadsheetId, title: create.data.properties?.title || title };
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
  const price = input.averagePrice == null || input.averagePrice === ''
    ? ''
    : (typeof input.averagePrice === 'number'
      ? input.averagePrice.toFixed(2)
      : String(input.averagePrice));
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
  const row = buildRow(card);
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheet.googleSheetId,
    range: 'A1',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheet.googleSheetId}`;
  return { sheet, sheetUrl };
}
