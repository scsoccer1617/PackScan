/**
 * Scan logger — appends one structured row per analyze-card-dual-images
 * call to a Google Sheet so we can review every scan's foil-detection
 * decisions without copy/pasting console logs.
 *
 * The Sheet is a single shared spreadsheet whose ID lives in the
 * SCAN_LOG_SHEET_ID env var. Service-account auth (re-using the
 * GOOGLE_SERVICE_ACCOUNT_JSON secret already powering Drive sync) writes
 * the rows; the service account email must be granted Editor access on
 * the Sheet.
 *
 * Wire-up:
 *   1.  startScanLog(scanContext)  → returns a ScanLog handle
 *   2.  log.addIndicator(line)     → buffer indicator lines as the
 *                                    visual detector / classifier emits
 *                                    them
 *   3.  log.setFinal({ ... })      → record final foilType / confidence /
 *                                    user decision
 *   4.  log.flush()                → fire-and-forget append; failures are
 *                                    swallowed and logged so a Sheets
 *                                    outage never breaks an analyze
 *
 * Toggle off via SCAN_LOG_ENABLED=false. When the toggle is off (or the
 * sheet ID / SA JSON is missing) every entry point is a no-op so this
 * module is safe to call unconditionally from the analyze path.
 */

import { google, type sheets_v4 } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

const HEADERS = [
  'Timestamp',
  'ScanId',
  'Brand',
  'Year',
  'Set',
  'CardNumber',
  'Player',
  'DetectedColor',
  'FoilType',
  'Confidence',
  'IsFoil',
  'UserDecision',
  'Indicators',
  'OcrFrontText',
  'OcrBackText',
  'DurationMs',
  // Gemini VLM observability (PR #158): which prompt version ran, what
  // Gemini actually returned for the four most-watched fields, and what
  // the legacy OCR pipeline had BEFORE the Gemini overlay overwrote
  // it. When GeminiYear is empty the model call returned null (failed,
  // unparseable, or empty response) and the LegacyYear is what landed
  // on the saved card. Lets us tell at a glance whether a wrong year
  // came from a bad model output vs a missed model call.
  'GeminiPromptVersion',
  'GeminiYear',
  'GeminiBrand',
  'GeminiPlayer',
  'LegacyYear',
];

// Truncate large free-text fields so the Sheet stays readable. Cells
// max out at 50,000 chars but pasting 30k of OCR per row makes the
// sheet unusable. Keep enough to debug card-number / player drift.
const OCR_TEXT_TRUNCATE_AT = 4000;

function columnIndexToA1(zeroIndex: number): string {
  // 0 → A, 25 → Z, 26 → AA, etc.
  let n = zeroIndex;
  let s = '';
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

let cachedAuth: GoogleAuth | null = null;
let cachedSheets: sheets_v4.Sheets | null = null;
let headerSyncDone = false;

function isEnabled(): boolean {
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
    // spreadsheets (write) scope, NOT readonly — driveSync uses a
    // separate auth instance with readonly scopes for masters.
    cachedAuth = new GoogleAuth({
      credentials: credentials as any,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  cachedSheets = google.sheets({ version: 'v4', auth: cachedAuth });
  return cachedSheets;
}

/**
 * One-time best-effort header check.
 *
 * Two cases:
 *   1. Row 1 is empty → seed full HEADERS.
 *   2. Row 1 is partially populated (older seed had fewer columns than
 *      the current HEADERS) → extend it to cover any newly added
 *      trailing columns. We never overwrite existing labels, so users
 *      who customised earlier columns keep their text.
 *
 * Failures are swallowed — the sink is best-effort.
 */
async function ensureHeadersOnce() {
  if (headerSyncDone) return;
  headerSyncDone = true;
  try {
    const sheets = getSheetsClient();
    const spreadsheetId = process.env.SCAN_LOG_SHEET_ID!;
    // Ask for slightly more than HEADERS in case a future version
    // shrinks; A:AZ covers 52 columns which is well beyond any
    // foreseeable schema.
    const got = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'A1:AZ1' });
    const row = got.data.values?.[0] ?? [];
    if (row.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'A1',
        valueInputOption: 'RAW',
        requestBody: { values: [HEADERS] },
      });
    } else if (row.length < HEADERS.length) {
      // Append only the missing trailing labels so we don't clobber
      // any user-edited cells. Sheets columns are 1-indexed; convert
      // the next-empty index to its A1 letter.
      const startCol = columnIndexToA1(row.length); // row.length == next empty col index (0-based)
      const newLabels = HEADERS.slice(row.length);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${startCol}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [newLabels] },
      });
    }
  } catch (err) {
    // Don't surface — the log sink is best-effort. Just emit one
    // indicator so the user can see in console why writes are silent.
    console.warn('[scanLogger] header sync failed:', (err as Error).message);
  }
}

export interface ScanContext {
  scanId: string;
  brand?: string;
  year?: number | string;
  set?: string;
  cardNumber?: string;
  player?: string;
  detectedColor?: string;
}

export interface ScanLogFinal {
  foilType?: string;
  confidence?: number;
  isFoil?: boolean;
  userDecision?: string;
  ocrFrontText?: string;
  ocrBackText?: string;
  durationMs?: number;
  // Gemini VLM observability fields. All are optional — when the model
  // call failed entirely, the year/brand/player slots are left empty
  // and only `geminiPromptVersion` is filled (so we can still see which
  // prompt was active when Gemini didn't return).
  geminiPromptVersion?: string | null;
  geminiYear?: number | string | null;
  geminiBrand?: string | null;
  geminiPlayer?: string | null;
  // Year on the combined result BEFORE the Gemini overlay ran. Helps us
  // see whether the legacy OCR pipeline had it right and Gemini
  // overrode it, or whether legacy was wrong and Gemini either fixed
  // it or didn't run.
  legacyYear?: number | string | null;
}

export interface ScanLog {
  addIndicator(line: string): void;
  setFinal(final: ScanLogFinal): void;
  flush(): void;
}

const NOOP_LOG: ScanLog = {
  addIndicator: () => {},
  setFinal: () => {},
  flush: () => {},
};

/**
 * Begin a scan log entry. Returns a NOOP handle when the sink is
 * disabled / not configured, so callers don't need feature-flag
 * branches.
 */
export function startScanLog(ctx: ScanContext): ScanLog {
  if (!isEnabled()) return NOOP_LOG;

  const indicators: string[] = [];
  let final: ScanLogFinal = {};
  let flushed = false;

  return {
    addIndicator(line: string) {
      indicators.push(line);
    },
    setFinal(f: ScanLogFinal) {
      final = { ...final, ...f };
    },
    flush() {
      if (flushed) return;
      flushed = true;
      // Fire-and-forget — never await from the analyze path. Errors are
      // caught + logged but do not propagate.
      void appendRow(ctx, final, indicators).catch((err) => {
        console.warn('[scanLogger] append failed:', (err as Error).message);
      });
    },
  };
}

async function appendRow(ctx: ScanContext, final: ScanLogFinal, indicators: string[]) {
  await ensureHeadersOnce();
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.SCAN_LOG_SHEET_ID!;
  // Sheets cells max out at 50,000 chars. Trim defensively.
  const indicatorsCell = indicators.join('\n').slice(0, 49000);
  const ocrFront = (final.ocrFrontText ?? '').slice(0, OCR_TEXT_TRUNCATE_AT);
  const ocrBack = (final.ocrBackText ?? '').slice(0, OCR_TEXT_TRUNCATE_AT);
  const row = [
    new Date().toISOString(),
    ctx.scanId,
    ctx.brand ?? '',
    ctx.year != null ? String(ctx.year) : '',
    ctx.set ?? '',
    ctx.cardNumber ?? '',
    ctx.player ?? '',
    ctx.detectedColor ?? '',
    final.foilType ?? '',
    final.confidence != null ? final.confidence.toFixed(2) : '',
    final.isFoil != null ? String(final.isFoil) : '',
    final.userDecision ?? '',
    indicatorsCell,
    ocrFront,
    ocrBack,
    final.durationMs != null ? String(final.durationMs) : '',
    // Gemini observability tail (PR #158)
    final.geminiPromptVersion ?? '',
    final.geminiYear != null ? String(final.geminiYear) : '',
    final.geminiBrand ?? '',
    final.geminiPlayer ?? '',
    final.legacyYear != null ? String(final.legacyYear) : '',
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'A1',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}
