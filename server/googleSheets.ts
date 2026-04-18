import { google, sheets_v4, drive_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db';
import { users, userSheets, type User, type UserSheet } from '../shared/schema';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

export const SHEET_HEADERS = [
  'Date scanned', 'Year', 'Brand', 'Collection', 'Set', 'Card #', 'Player',
  'Variation', 'Serial #', 'Rookie', 'Auto', 'Numbered', 'Foil type',
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
  // Bold the header row
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      }, {
        updateSheetProperties: {
          properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      }],
    },
  });
  return { spreadsheetId, title: create.data.properties?.title || title };
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
  year?: number | string | null;
  brand?: string | null;
  collection?: string | null;
  set?: string | null;
  cardNumber?: string | null;
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
  return [
    dateScanned,
    input.year ?? '',
    input.brand ?? '',
    input.collection ?? '',
    input.set ?? '',
    input.cardNumber ?? '',
    input.player ?? '',
    input.variation ?? '',
    input.serialNumber ?? '',
    fmtBool(input.isRookieCard),
    fmtBool(input.isAutographed),
    fmtBool(input.isNumbered),
    input.foilType ?? '',
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
