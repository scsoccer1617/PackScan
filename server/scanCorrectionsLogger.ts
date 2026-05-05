/**
 * Scan-corrections logger — appends one structured row per edited field
 * to the "Corrections" tab of the Scan Logs workbook so we have a
 * permanent ML-training dataset of (original prediction → human
 * correction) events. Mirrors server/scanLogger.ts:
 *
 *   - Service-account auth via GOOGLE_SERVICE_ACCOUNT_JSON
 *   - Spreadsheet ID from SCAN_LOG_SHEET_ID
 *   - Header row auto-seeded / extended on first write
 *   - Disabled / NOOP when env vars are missing
 *   - Failures are swallowed; the corrections sink is best-effort
 *
 * Schema (one row per edited field):
 *   correction_id           UUID
 *   timestamp               ISO 8601 UTC
 *   scan_id                 e.g. "bulk-<batchId>-<itemId>" or single-scan id
 *   reviewer_id             email | "user:<id>" | "anonymous"
 *   reviewer_role           "admin" | "external" | "anonymous"
 *   source                  "single_scan" | "bulk_review"
 *   field                   field name (e.g. "year", "player")
 *   original_value          predicted value (string-coerced)
 *   corrected_value         human-entered value (string-coerced)
 *   front_image_url         best-effort URL of the front image, if known
 *   back_image_url          best-effort URL of the back image, if known
 *   original_confidence     confidence score from scan, if known
 *   notes                   free-text, optional
 */

import { google, type sheets_v4 } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

export const CORRECTIONS_SHEET_TAB = 'Corrections';

export const CORRECTIONS_HEADERS = [
  'correction_id',
  'timestamp',
  'scan_id',
  'reviewer_id',
  'reviewer_role',
  'source',
  'field',
  'original_value',
  'corrected_value',
  'front_image_url',
  'back_image_url',
  'original_confidence',
  'notes',
] as const;

export type ReviewerRole = 'admin' | 'external' | 'anonymous';
export type CorrectionSource = 'single_scan' | 'bulk_review';

export interface CorrectionEvent {
  correctionId: string;
  timestamp: string;
  scanId: string;
  reviewerId: string;
  reviewerRole: ReviewerRole;
  source: CorrectionSource;
  field: string;
  originalValue: string;
  correctedValue: string;
  frontImageUrl?: string | null;
  backImageUrl?: string | null;
  originalConfidence?: number | null;
  notes?: string | null;
}

let cachedAuth: GoogleAuth | null = null;
let cachedSheets: sheets_v4.Sheets | null = null;
let headerSyncDone = false;

export function isCorrectionsLogEnabled(): boolean {
  if ((process.env.SCAN_LOG_ENABLED ?? '').toLowerCase() === 'false') return false;
  if (!process.env.SCAN_LOG_SHEET_ID) return false;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return false;
  return true;
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

function columnIndexToA1(zeroIndex: number): string {
  let n = zeroIndex;
  let s = '';
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

async function ensureCorrectionsTabAndHeaders(spreadsheetId: string) {
  if (headerSyncDone) return;
  const sheets = getSheetsClient();

  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const tabExists = (meta.data.sheets ?? []).some(
      (s) => s.properties?.title === CORRECTIONS_SHEET_TAB,
    );
    if (!tabExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: CORRECTIONS_SHEET_TAB } } }],
        },
      });
    }

    const range = `${CORRECTIONS_SHEET_TAB}!A1:Z1`;
    const got = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const row = got.data.values?.[0] ?? [];
    if (row.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${CORRECTIONS_SHEET_TAB}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [CORRECTIONS_HEADERS as unknown as string[]] },
      });
    } else if (row.length < CORRECTIONS_HEADERS.length) {
      const startCol = columnIndexToA1(row.length);
      const newLabels = CORRECTIONS_HEADERS.slice(row.length);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${CORRECTIONS_SHEET_TAB}!${startCol}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [newLabels as unknown as string[]] },
      });
    }
    headerSyncDone = true;
  } catch (err) {
    // Don't latch headerSyncDone=true so we'll retry on the next call.
    console.warn('[scanCorrectionsLogger] header sync failed:', (err as Error).message);
  }
}

function eventToRow(e: CorrectionEvent): string[] {
  return [
    e.correctionId,
    e.timestamp,
    e.scanId,
    e.reviewerId,
    e.reviewerRole,
    e.source,
    e.field,
    e.originalValue ?? '',
    e.correctedValue ?? '',
    e.frontImageUrl ?? '',
    e.backImageUrl ?? '',
    e.originalConfidence != null ? String(e.originalConfidence) : '',
    e.notes ?? '',
  ];
}

/**
 * Append a batch of correction events. Best-effort: never throws,
 * tab-not-found triggers a one-shot retry by resetting the header cache.
 */
export async function appendCorrectionRows(events: CorrectionEvent[]): Promise<void> {
  if (!isCorrectionsLogEnabled()) return;
  if (!events.length) return;
  const spreadsheetId = process.env.SCAN_LOG_SHEET_ID!;

  try {
    await ensureCorrectionsTabAndHeaders(spreadsheetId);
    const sheets = getSheetsClient();
    const values = events.map(eventToRow);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${CORRECTIONS_SHEET_TAB}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // If the tab disappeared mid-flight, allow the next write to retry the seed.
    if (/Unable to parse range|not found/i.test(msg)) {
      headerSyncDone = false;
    }
    console.warn('[scanCorrectionsLogger] append failed:', msg);
  }
}
