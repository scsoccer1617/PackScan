/**
 * Drive Sync — pulls master CSVs from two Google Drive folders and feeds them
 * into the existing importCardsCSV / importVariationsCSV pipeline.
 *
 * Strategy: per the user's Saturday April 25 2026 design discussion, each sync
 * run lists CSVs in `DRIVE_FOLDER_CARDS_ID` and `DRIVE_FOLDER_VARIATIONS_ID`,
 * picks the most recently modified one in each, and imports it — but only if a
 * `csv_sync_log` row does not already exist for that (file_id, modified_time).
 * Old files in the folder are ignored, allowing the user to keep historical
 * snapshots there as a manual backup.
 *
 * Auth: a Google Cloud service account with read access to both folders. The
 * SA JSON is stored verbatim in the GOOGLE_SERVICE_ACCOUNT_JSON env var. The
 * existing googleapis dep (^148) is reused — no new deps.
 */
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { db } from '../db';
import { csvSyncLog } from '../shared/schema';
import { and, eq } from 'drizzle-orm';

// ─── Auth ───────────────────────────────────────────────────────────────────

let cachedDriveClient: ReturnType<typeof google.drive> | null = null;

function loadServiceAccountCredentials(): Record<string, unknown> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set. Add the service account JSON key as a secret.');
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed.private_key && typeof parsed.private_key === 'string') {
      // Replit secrets sometimes preserve the literal "\n" sequence; normalise.
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    return parsed;
  } catch (err: any) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON could not be parsed as JSON: ${err.message}`);
  }
}

function getDriveClient() {
  if (cachedDriveClient) return cachedDriveClient;
  const credentials = loadServiceAccountCredentials();
  const auth = new GoogleAuth({
    credentials: credentials as any,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  cachedDriveClient = google.drive({ version: 'v3', auth });
  return cachedDriveClient;
}

// ─── Listing & download ─────────────────────────────────────────────────────

// Drive mime types we accept as a master spreadsheet source. Native Google
// Sheets are pulled via the `export` endpoint as CSV bytes; uploaded `.csv`
// files are pulled via `alt=media`. Both end up as the same Buffer shape that
// the existing importer expects, so the rest of the pipeline doesn't change.
const MIME_CSV = 'text/csv';
const MIME_GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';

export interface DriveCsvFile {
  fileId: string;
  fileName: string;
  modifiedTime: Date;
  sizeBytes: number | null;
  /**
   * Native Drive mimeType. We need this at download time to decide between
   * `files.get(alt=media)` (for CSV) and `files.export(mimeType=text/csv)`
   * (for Google Sheets). Stored on the listing result so callers don't have
   * to round-trip Drive again.
   */
  mimeType: string;
}

/**
 * Find the most recently modified spreadsheet in a Drive folder. Returns null
 * when the folder has no candidates (so callers can no-op cleanly).
 *
 * Accepts:
 *  - Uploaded CSV files (mimeType = text/csv)
 *  - Native Google Sheets (mimeType = application/vnd.google-apps.spreadsheet)
 *
 * The user's workflow generates spreadsheets via Perplexity's google_sheets
 * connector, so the source of truth lives as a Google Sheet rather than a
 * re-uploaded CSV. We accept both so historical CSV uploads still work.
 *
 * Filters:
 *  - trashed = false (don't grab files the user just deleted).
 */
export async function findLatestCsvInFolder(folderId: string): Promise<DriveCsvFile | null> {
  if (!folderId) throw new Error('folderId is required');
  const drive = getDriveClient();
  // Order by modifiedTime desc, take the first match. Page size 25 to give us
  // some headroom for non-spreadsheet junk in the folder without paginating.
  const res = await drive.files.list({
    q: [
      `'${folderId}' in parents`,
      `(mimeType = '${MIME_CSV}' or mimeType = '${MIME_GOOGLE_SHEET}')`,
      `trashed = false`,
    ].join(' and '),
    orderBy: 'modifiedTime desc',
    pageSize: 25,
    fields: 'files(id,name,modifiedTime,size,mimeType)',
    // Required for shared drives, harmless on My Drive.
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = res.data.files ?? [];
  if (files.length === 0) return null;
  const top = files[0];
  if (!top.id || !top.name || !top.modifiedTime || !top.mimeType) return null;
  return {
    fileId: top.id,
    fileName: top.name,
    modifiedTime: new Date(top.modifiedTime),
    // Google Sheets don't report a `size` (it's null on the API), only uploaded
    // CSVs do. UI should treat null as "unknown" rather than zero.
    sizeBytes: top.size ? parseInt(top.size, 10) : null,
    mimeType: top.mimeType,
  };
}

/**
 * Download a Drive file's bytes as CSV. Branches on the source mimeType:
 *  - Uploaded CSV    → `files.get(alt=media)` (raw bytes as-is)
 *  - Google Sheet    → `files.export(mimeType=text/csv)` (Drive renders the
 *                       active/first sheet to CSV; multi-tab Sheets only
 *                       export the first tab — which matches our single-tab
 *                       master design).
 *
 * Either way the caller gets a Buffer it can hand straight to the existing
 * importCardsCSV / importVariationsCSV pipeline. The masters are sub-50 MB,
 * well within Replit's RAM budget for an in-memory buffer.
 */
export async function downloadFile(fileId: string, mimeType?: string): Promise<Buffer> {
  const drive = getDriveClient();

  // Default to the legacy CSV path when no mimeType is provided so existing
  // callers (and any external scripts) keep working unchanged.
  if (!mimeType || mimeType === MIME_CSV) {
    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' },
    );
    return Buffer.from(res.data as ArrayBuffer);
  }

  if (mimeType === MIME_GOOGLE_SHEET) {
    const res = await drive.files.export(
      { fileId, mimeType: MIME_CSV },
      { responseType: 'arraybuffer' },
    );
    return Buffer.from(res.data as ArrayBuffer);
  }

  throw new Error(
    `Drive sync: unsupported mimeType '${mimeType}' for file ${fileId}. ` +
    `Expected '${MIME_CSV}' or '${MIME_GOOGLE_SHEET}'.`,
  );
}

// ─── Skip-check against csv_sync_log ────────────────────────────────────────

/**
 * Returns the existing log row for (table, file, modified_time) if this exact
 * revision has already been imported, otherwise null. Used to make sync runs
 * idempotent so cron can fire every 30 min without re-importing the same file.
 */
export async function findExistingSyncLog(
  tableName: 'cards' | 'variations',
  driveFileId: string,
  driveModifiedTime: Date,
): Promise<typeof csvSyncLog.$inferSelect | null> {
  const rows = await db.select().from(csvSyncLog).where(
    and(
      eq(csvSyncLog.tableName, tableName),
      eq(csvSyncLog.driveFileId, driveFileId),
      eq(csvSyncLog.driveModifiedTime, driveModifiedTime),
    ),
  ).limit(1);
  return rows[0] ?? null;
}

// ─── Env helpers ────────────────────────────────────────────────────────────

export function getCardsFolderId(): string {
  const id = process.env.DRIVE_FOLDER_CARDS_ID;
  if (!id) throw new Error('DRIVE_FOLDER_CARDS_ID env var is not set.');
  return id;
}

export function getVariationsFolderId(): string {
  const id = process.env.DRIVE_FOLDER_VARIATIONS_ID;
  if (!id) throw new Error('DRIVE_FOLDER_VARIATIONS_ID env var is not set.');
  return id;
}

/**
 * True when all three env vars required for Drive sync are present. The admin
 * UI uses this (via /api/card-database/drive-sync-status) to gate the "Sync
 * from Drive" card so it doesn't render until the operator has wired things up.
 */
export function isDriveSyncConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON &&
    process.env.DRIVE_FOLDER_CARDS_ID &&
    process.env.DRIVE_FOLDER_VARIATIONS_ID,
  );
}
