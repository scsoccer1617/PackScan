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

export interface DriveCsvFile {
  fileId: string;
  fileName: string;
  modifiedTime: Date;
  sizeBytes: number | null;
}

/**
 * Find the most recently modified CSV in a Drive folder. Returns null when the
 * folder has no CSVs (so callers can no-op cleanly instead of throwing).
 *
 * Filters:
 *  - mimeType = text/csv (the user's masters are exported as CSV; Sheets-native
 *    files are excluded — they would need a separate export step).
 *  - trashed = false (don't grab files the user just deleted).
 */
export async function findLatestCsvInFolder(folderId: string): Promise<DriveCsvFile | null> {
  if (!folderId) throw new Error('folderId is required');
  const drive = getDriveClient();
  // Order by modifiedTime desc, take the first CSV. Page size 25 to give us
  // some headroom for non-CSV junk in the folder without paginating.
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = 'text/csv' and trashed = false`,
    orderBy: 'modifiedTime desc',
    pageSize: 25,
    fields: 'files(id,name,modifiedTime,size)',
    // Required for shared drives, harmless on My Drive.
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = res.data.files ?? [];
  if (files.length === 0) return null;
  const top = files[0];
  if (!top.id || !top.name || !top.modifiedTime) return null;
  return {
    fileId: top.id,
    fileName: top.name,
    modifiedTime: new Date(top.modifiedTime),
    sizeBytes: top.size ? parseInt(top.size, 10) : null,
  };
}

/**
 * Download a Drive file's raw bytes. Used for CSVs only — keeps the whole file
 * in memory because the existing importer expects a Buffer. The masters are
 * sub-50 MB, well within Replit's RAM budget.
 */
export async function downloadFile(fileId: string): Promise<Buffer> {
  const drive = getDriveClient();
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(res.data as ArrayBuffer);
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
