/**
 * One-shot migration helper for PR J: clears the now-stale "Potential
 * Variant" cells from the OLD column position (column Y) on the user's
 * active Google Sheet.
 *
 * Background. PR #262 appended "Potential Variant" as the 25th column
 * (column Y, position 24) following the codebase's append-only contract.
 * PR J reorders SHEET_HEADERS so "Potential Variant" sits immediately
 * before "Variant" (position 11, column L). After the reorder:
 *   - syncHeaderRow rewrites row 1 with the new labels — column Y becomes
 *     "Cert #" (the trailing entry that bumped left).
 *   - New scans write to the new layout via buildRow.
 *   - Existing data rows still carry stale 'Yes' / 'No' / '' values in
 *     column Y, which would now appear under whatever column header
 *     ended up there (post-reorder column Y is empty — the sheet shrinks
 *     by one column? No: the count is still 25, so column Y is now
 *     "Cert #"). Stranded 'Yes'/'No' values would render as bogus cert
 *     numbers.
 *
 * What this script does:
 *   - Opens the user's active sheet via the same OAuth flow used by
 *     server/googleSheets.ts (token refresh persists back to the users
 *     table).
 *   - Issues a single spreadsheets.values.clear against `Y2:Y` to wipe
 *     any stale "Potential Variant" values from data rows. Header row 1
 *     is intentionally left alone — syncHeaderRow handles that on the
 *     next append.
 *   - Idempotent. Safe to re-run; subsequent calls clear an
 *     already-empty range.
 *
 * What this script does NOT do:
 *   - Rewrite Y with new contents.
 *   - Touch any other column.
 *   - Read or write the local cards table.
 *   - Try to be smart about which rows had values vs not. The Sheets
 *     `clear` request is one API call regardless of contents.
 *
 * USAGE (manual, one-shot):
 *   DATABASE_URL=... \
 *   GOOGLE_OAUTH_CLIENT_ID=... \
 *   GOOGLE_OAUTH_CLIENT_SECRET=... \
 *   npx tsx db/migrateMovePotentialVariant.ts <userId>
 *
 * The userId is the PackScan numeric users.id whose active sheet should
 * be cleaned. Print only — no destructive output beyond the cleared
 * range. The user can re-run after each rescan cycle without harm.
 */

import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { eq, and } from 'drizzle-orm';
import { db } from './index';
import { users, userSheets } from '@shared/schema';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

async function getOAuthClient(userId: number): Promise<OAuth2Client> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID/SECRET env vars are required.');
  }
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw new Error(`User ${userId} not found`);
  if (!u.googleAccessToken && !u.googleRefreshToken) {
    throw new Error(`User ${userId} has not connected a Google account.`);
  }
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
      if (Object.keys(update).length) {
        await db.update(users).set(update).where(eq(users.id, userId));
      }
    } catch (err) {
      console.error('[migrate] failed to persist refreshed tokens:', err);
    }
  });
  return oauth;
}

async function getActiveSheetId(userId: number): Promise<string | null> {
  const def = await db
    .select()
    .from(userSheets)
    .where(and(eq(userSheets.userId, userId), eq(userSheets.isDefault, true)))
    .limit(1);
  if (def[0]) return def[0].googleSheetId;
  const any = await db.select().from(userSheets).where(eq(userSheets.userId, userId)).limit(1);
  return any[0]?.googleSheetId ?? null;
}

async function main() {
  const userIdRaw = process.argv[2];
  if (!userIdRaw) {
    console.error('Usage: npx tsx db/migrateMovePotentialVariant.ts <userId>');
    process.exit(2);
  }
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) {
    console.error(`Invalid userId: ${userIdRaw}`);
    process.exit(2);
  }
  const spreadsheetId = await getActiveSheetId(userId);
  if (!spreadsheetId) {
    console.error(`User ${userId} has no active sheet.`);
    process.exit(1);
  }
  const oauth = await getOAuthClient(userId);
  const sheets = google.sheets({ version: 'v4', auth: oauth });

  // Range Y2:Y wipes the entire old "Potential Variant" column without
  // touching the header (row 1 is rewritten by syncHeaderRow on the next
  // append). One API call regardless of how many rows are populated.
  const range = 'Y2:Y';
  console.log(`[migrate] clearing ${range} on spreadsheet ${spreadsheetId} for user ${userId}…`);
  const resp = await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range,
  });
  const cleared = resp.data.clearedRange ?? '(none)';
  console.log(`[migrate] cleared range: ${cleared}`);
  console.log('[migrate] done. Safe to re-run; subsequent calls clear an already-empty range.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
