/**
 * Scan confirmation logger — companion to scanLogger.ts and the
 * /api/scan-corrections sink. One row per dealer-confirmed scan
 * (Save / 👍 with zero edits against the analyzer's snapshot).
 *
 * Storage: a `Confirmations` tab on the shared Scan Logs workbook
 * (SCAN_LOG_SHEET_ID). Service-account write access; the SA email
 * must already be Editor on the workbook (it is — same secret as
 * scanLogger.ts).
 *
 * Writes are fire-and-forget and best-effort: the tab is auto-created
 * on first append, headers are seeded once, append failures are
 * swallowed with a console.warn so a Sheets outage never blocks an
 * analyze or a Save.
 *
 * Toggle off via SCAN_CONFIRMATION_LOG_ENABLED=false.
 */
import { google, type sheets_v4 } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

export const CONFIRMATIONS_SHEET_TAB = 'Confirmations';

export const CONFIRMATION_HEADERS = [
  'ConfirmationId',
  'Timestamp',
  'ScanId',
  'ReviewerId',
  'ReviewerRole',
  'Source',
  'PredictedPlayer',
  'PredictedYear',
  'PredictedBrand',
  'PredictedSet',
  'PredictedCollection',
  'PredictedCardNumber',
  'PredictedVariant',
  'PredictedPotentialVariant',
  'FrontImageUrl',
  'BackImageUrl',
  'OriginalConfidence',
];

export type ReviewerRole = 'admin' | 'external' | 'anonymous';
export type ConfirmationSource = 'single_scan' | 'bulk_review';

export interface ConfirmationPayload {
  confirmationId: string;
  timestamp: string; // ISO8601 UTC
  scanId: string;
  reviewerId: string;
  reviewerRole: ReviewerRole;
  source: ConfirmationSource;
  predictedPlayer?: string | null;
  predictedYear?: string | number | null;
  predictedBrand?: string | null;
  predictedSet?: string | null;
  predictedCollection?: string | null;
  predictedCardNumber?: string | null;
  predictedVariant?: string | null;
  predictedPotentialVariant?: string | null;
  frontImageUrl?: string | null;
  backImageUrl?: string | null;
  originalConfidence?: number | string | null;
}

let cachedAuth: GoogleAuth | null = null;
let cachedSheets: sheets_v4.Sheets | null = null;
let tabEnsured = false;
let headersEnsured = false;

export function isConfirmationsLogEnabled(): boolean {
  if ((process.env.SCAN_CONFIRMATION_LOG_ENABLED ?? '').toLowerCase() === 'false') return false;
  if (!process.env.SCAN_LOG_SHEET_ID) return false;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return false;
  return true;
}

// Test seam — lets unit tests reset the cached singleton state between
// cases without having to fork the whole module.
export function __resetConfirmationsLogForTests() {
  cachedAuth = null;
  cachedSheets = null;
  tabEnsured = false;
  headersEnsured = false;
}

function loadServiceAccountCredentials(): Record<string, unknown> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');
  const parsed = JSON.parse(raw);
  if (parsed.private_key && typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  return parsed;
}

function getSheetsClient(): sheets_v4.Sheets {
  if (cachedSheets) return cachedSheets;
  if (!cachedAuth) {
    const credentials = loadServiceAccountCredentials();
    cachedAuth = new GoogleAuth({
      credentials: credentials as any,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  cachedSheets = google.sheets({ version: 'v4', auth: cachedAuth });
  return cachedSheets;
}

async function ensureTabOnce() {
  if (tabEnsured) return;
  tabEnsured = true;
  try {
    const sheets = getSheetsClient();
    const spreadsheetId = process.env.SCAN_LOG_SHEET_ID!;
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const exists = (meta.data.sheets ?? []).some(
      (s) => s.properties?.title === CONFIRMATIONS_SHEET_TAB,
    );
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: CONFIRMATIONS_SHEET_TAB } } }],
        },
      });
    }
  } catch (err) {
    console.warn('[scanConfirmationsLog] ensureTab failed:', (err as Error).message);
  }
}

async function ensureHeadersOnce() {
  if (headersEnsured) return;
  headersEnsured = true;
  try {
    const sheets = getSheetsClient();
    const spreadsheetId = process.env.SCAN_LOG_SHEET_ID!;
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${CONFIRMATIONS_SHEET_TAB}!A1:Z1`,
    });
    const row = got.data.values?.[0] ?? [];
    if (row.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${CONFIRMATIONS_SHEET_TAB}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [CONFIRMATION_HEADERS] },
      });
    }
  } catch (err) {
    console.warn('[scanConfirmationsLog] ensureHeaders failed:', (err as Error).message);
  }
}

export function buildConfirmationRow(p: ConfirmationPayload): (string | number)[] {
  return [
    p.confirmationId,
    p.timestamp,
    p.scanId,
    p.reviewerId,
    p.reviewerRole,
    p.source,
    p.predictedPlayer ?? '',
    p.predictedYear != null ? String(p.predictedYear) : '',
    p.predictedBrand ?? '',
    p.predictedSet ?? '',
    p.predictedCollection ?? '',
    p.predictedCardNumber ?? '',
    p.predictedVariant ?? '',
    p.predictedPotentialVariant ?? '',
    p.frontImageUrl ?? '',
    p.backImageUrl ?? '',
    p.originalConfidence != null
      ? typeof p.originalConfidence === 'number'
        ? p.originalConfidence.toFixed(2)
        : String(p.originalConfidence)
      : '',
  ];
}

export async function appendConfirmationRow(payload: ConfirmationPayload): Promise<void> {
  if (!isConfirmationsLogEnabled()) return;
  await ensureTabOnce();
  await ensureHeadersOnce();
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.SCAN_LOG_SHEET_ID!;
  const row = buildConfirmationRow(payload);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${CONFIRMATIONS_SHEET_TAB}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}
