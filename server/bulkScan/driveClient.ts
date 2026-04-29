// Google Drive client for the bulk-scan pipeline.
//
// PackScan already has a working OAuth integration for Google Sheets
// (see server/googleSheets.ts — `getOAuthClient(userId)` loads + refreshes the
// user's tokens off the `users` table). The bulk-scan pipeline reuses that
// exact pattern so we don't duplicate auth plumbing: one OAuth flow, one set
// of persisted tokens, one refresh loop. The only new concept here is the
// Drive-specific helpers — list / download / move.
//
// Scopes: the existing PackScan OAuth consent screen already requests
// `https://www.googleapis.com/auth/drive.file`, which lets the app read /
// write only the files it has interacted with. That's narrower than full
// `drive` scope and keeps us inside the "non-sensitive" tier. The Brother
// scanner drops new files into a user-selected folder; we can list those
// files because the user opened the folder via a Drive picker OR because
// the user shared the folder with the app. Either way `drive.file` suffices
// as long as the app "touches" the file (which listing + downloading counts
// as).

import { google, drive_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { eq } from 'drizzle-orm';
import { Readable } from 'stream';
import { Agent as HttpsAgent } from 'https';
import { db } from '@db';
import { users, type User } from '@shared/schema';

// Shared HTTPS agent with keep-alive enabled. Drive lives behind
// www.googleapis.com which terminates TLS per connection, and a 4-wide
// (now 8-wide) Phase 1 PQueue used to pay a fresh handshake on every
// `downloadFile` call — visible as multi-second cold-start latency on the
// first file of a batch. One process-wide pooled agent lets every Drive
// call (list / download / move / fetchThumbnail / getFolderName) reuse
// existing sockets, so subsequent requests skip the TLS round-trip and
// the first batch's startup floor drops from ~45s into the single-digit
// seconds.
const driveKeepAliveAgent = new HttpsAgent({
  keepAlive: true,
  // Default keepAliveMsecs is 1000; bump so a paused worker's socket
  // stays warm long enough for the next pair download to grab it.
  keepAliveMsecs: 30_000,
  // googleapis runs Drive list + download + move concurrently and we
  // hold up to 8 Phase 1 + 4 Phase 2 = 12 in flight at peak.
  maxSockets: 32,
  maxFreeSockets: 16,
});

const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

export class DriveNotConnectedError extends Error {
  constructor() { super('User has not connected a Google account.'); }
}

/**
 * Build an OAuth2Client for the user and auto-persist refreshed tokens
 * back to the `users` table. Mirrors googleSheets.getOAuthClient so both
 * integrations stay in lockstep — a token refreshed by one side is
 * immediately visible to the other.
 */
async function getOAuthClient(userId: number): Promise<{ oauth: OAuth2Client; user: User }> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth is not configured on this server.');
  }
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw new Error('User not found');
  if (!u.googleAccessToken && !u.googleRefreshToken) throw new DriveNotConnectedError();
  const oauth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth.setCredentials({
    access_token: u.googleAccessToken || undefined,
    refresh_token: u.googleRefreshToken || undefined,
    expiry_date: u.googleTokenExpiresAt ? new Date(u.googleTokenExpiresAt).getTime() : undefined,
  });
  oauth.on('tokens', async (tokens) => {
    try {
      const update: Record<string, unknown> = {};
      if (tokens.access_token) update.googleAccessToken = tokens.access_token;
      if (tokens.refresh_token) update.googleRefreshToken = tokens.refresh_token;
      if (tokens.expiry_date) update.googleTokenExpiresAt = new Date(tokens.expiry_date);
      if (Object.keys(update).length) await db.update(users).set(update).where(eq(users.id, userId));
    } catch (err) {
      console.error('[bulkScan/driveClient] failed to persist refreshed tokens:', err);
    }
  });
  return { oauth, user: u };
}

function driveFor(oauth: OAuth2Client): drive_v3.Drive {
  // Wire the keep-alive agent into the OAuth client's gaxios transporter
  // so every Drive request issued through this client (list / download /
  // move / get) reuses the warm socket pool. We re-set on every call
  // because google-auth-library overwrites `transporter.defaults` during
  // refresh; setting once at construction is not durable.
  const transporter: any = (oauth as any).transporter;
  if (transporter) {
    transporter.defaults = {
      ...(transporter.defaults || {}),
      agent: driveKeepAliveAgent,
    };
  }
  return google.drive({ version: 'v3', auth: oauth });
}

export interface DriveImageFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  size: number | null;
}

/**
 * List image files inside a Drive folder, ordered by createdTime ascending.
 * The Brother duplex scanner writes each page sequentially, so createdTime
 * ascending is the natural scan order — pages 1..N follow the physical sheet
 * feeder order without any filename-parsing heuristics.
 *
 * Only JPEG / PNG are returned; anything else is filtered out (the Brother
 * iPrint&Scan UI lets users pick PDF / TIFF too, and we want to ignore
 * those cleanly instead of crashing downstream).
 */
export async function listInboxImages(
  userId: number,
  folderId: string,
  opts: { pageLimit?: number } = {},
): Promise<DriveImageFile[]> {
  const { oauth } = await getOAuthClient(userId);
  const drive = driveFor(oauth);
  const limit = opts.pageLimit ?? 500;
  const files: DriveImageFile[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    pages++;
    const res = await drive.files.list({
      // `and trashed=false` keeps deleted files out. `parents in '<folderId>'`
      // restricts to direct children so we don't recurse into subfolders the
      // user may have nested inside the inbox (like a "processed" subfolder).
      q: `'${folderId}' in parents and trashed=false and (mimeType='image/jpeg' or mimeType='image/jpg' or mimeType='image/png')`,
      fields: 'nextPageToken, files(id,name,mimeType,createdTime,size)',
      orderBy: 'createdTime asc, name asc',
      pageSize: 100,
      pageToken,
      spaces: 'drive',
    });
    const batch = res.data.files || [];
    for (const f of batch) {
      if (!f.id || !f.name) continue;
      files.push({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType || 'image/jpeg',
        createdTime: f.createdTime || new Date().toISOString(),
        size: f.size ? Number(f.size) : null,
      });
      if (files.length >= limit) break;
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken && files.length < limit);
  console.log(`[bulkScan/driveClient] listInboxImages(${folderId}) user=${userId}: ${files.length} image(s) across ${pages} page(s)`);
  return files;
}

/**
 * List ALL files in a Drive folder regardless of mimeType. Used by the
 * inbox diagnostic so the dealer can see why HEIC / PDF / TIFF / random
 * scans don't show up in the bulk-scan listing. Mirrors listInboxImages
 * but without the image-only filter.
 */
export async function listInboxAllFiles(
  userId: number,
  folderId: string,
  opts: { pageLimit?: number } = {},
): Promise<DriveImageFile[]> {
  const { oauth } = await getOAuthClient(userId);
  const drive = driveFor(oauth);
  const limit = opts.pageLimit ?? 500;
  const files: DriveImageFile[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id,name,mimeType,createdTime,size)',
      orderBy: 'createdTime asc, name asc',
      pageSize: 100,
      pageToken,
      spaces: 'drive',
    });
    const batch = res.data.files || [];
    for (const f of batch) {
      if (!f.id || !f.name) continue;
      files.push({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType || '',
        createdTime: f.createdTime || new Date().toISOString(),
        size: f.size ? Number(f.size) : null,
      });
      if (files.length >= limit) break;
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken && files.length < limit);
  return files;
}

/**
 * Fetch a Drive file's bytes for previewing in the review queue.
 *
 * We previously tried Drive's `thumbnailLink`, but that route is unreliable:
 * - thumbnailLink is generated asynchronously and is often null for
 *   recently uploaded files
 * - the lh3.googleusercontent.com URL is sometimes signed (works without
 *   auth) and sometimes requires a Bearer token, and getting it wrong
 *   either way returns 401/403
 *
 * Going straight at the file bytes via `alt=media` is authenticated through
 * the same OAuth client we already use for listing/moving files, returns the
 * actual JPEG, and works for every image regardless of thumbnail-generation
 * status. Card scans are typically <2 MB and the route caches 1h, so the
 * larger payload is fine for a review-queue preview.
 */
export async function fetchThumbnail(
  userId: number,
  fileId: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const { oauth } = await getOAuthClient(userId);
    const drive = driveFor(oauth);
    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' },
    );
    const data = res.data as ArrayBuffer | Buffer | undefined;
    if (!data) {
      console.warn(`[bulkScan/driveClient] fetchThumbnail(${fileId}) empty body`);
      return null;
    }
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    const headers = (res.headers || {}) as Record<string, string>;
    const contentType = headers['content-type'] || headers['Content-Type'] || 'image/jpeg';
    return { bytes, contentType };
  } catch (err: any) {
    const status = err?.code || err?.response?.status;
    console.warn(`[bulkScan/driveClient] fetchThumbnail(${fileId}) failed status=${status} msg=${err?.message}`);
    return null;
  }
}

/**
 * Download a Drive file as a Buffer. The Vision analyzer wants raw bytes so
 * we buffer the whole response into memory; card scans are small JPEGs
 * (typically under 2 MB) so this is safe. `arraybuffer` responseType keeps
 * the googleapis client from streaming and gives us a single promise.
 */
export async function downloadFile(userId: number, fileId: string): Promise<Buffer> {
  const { oauth } = await getOAuthClient(userId);
  const drive = driveFor(oauth);
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' },
  );
  // The googleapis types mark `data` as GaxiosResponse['data'] which is a
  // union including string/object/Stream — at runtime with responseType
  // 'arraybuffer' it's always an ArrayBuffer. Guard defensively so a
  // wrapper change in googleapis never yields an unreadable buffer.
  const data = res.data as unknown;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof (data as { pipe?: unknown }).pipe === 'function') {
    // Stream fallback — shouldn't happen with responseType 'arraybuffer'
    // but keeps the code safe if googleapis ever changes its default.
    const chunks: Buffer[] = [];
    const stream = data as Readable;
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    }
    return Buffer.concat(chunks);
  }
  throw new Error(`[bulkScan/driveClient] downloadFile: unexpected response type ${typeof data}`);
}

/**
 * Move a file from one Drive folder to another. Drive's semantics use a
 * `parents` array on each file; moving means adding the new parent and
 * removing the old one in a single update call. Returns the destination
 * file id (same as source — Drive file ids are stable across moves).
 *
 * No-op when `fromFolderId === toFolderId`.
 */
export async function moveFile(
  userId: number,
  fileId: string,
  fromFolderId: string,
  toFolderId: string,
): Promise<void> {
  if (fromFolderId === toFolderId) return;
  const { oauth } = await getOAuthClient(userId);
  const drive = driveFor(oauth);
  await drive.files.update({
    fileId,
    addParents: toFolderId,
    removeParents: fromFolderId,
    fields: 'id,parents',
  });
}

/**
 * Resolve a Drive folder name (or verify a folder id) so the UI can surface
 * a human-readable label alongside the raw id. Returns null when the folder
 * doesn't exist or isn't accessible. Logs the failure so we don't have to
 * play guessing games when a dealer reports "Inbox stuck on loading".
 */
export async function getFolderName(userId: number, folderId: string): Promise<string | null> {
  try {
    const { oauth } = await getOAuthClient(userId);
    const drive = driveFor(oauth);
    const res = await drive.files.get({ fileId: folderId, fields: 'name,mimeType' });
    if (res.data.mimeType !== 'application/vnd.google-apps.folder') {
      console.warn(`[bulkScan/driveClient] getFolderName(${folderId}): not a folder (mimeType=${res.data.mimeType})`);
      return null;
    }
    return res.data.name || null;
  } catch (err: any) {
    const status = err?.response?.status ?? err?.code;
    const msg = err?.response?.data?.error?.message ?? err?.message ?? 'unknown';
    console.warn(`[bulkScan/driveClient] getFolderName(${folderId}) for user=${userId} failed: status=${status} msg=${msg}`);
    return null;
  }
}
