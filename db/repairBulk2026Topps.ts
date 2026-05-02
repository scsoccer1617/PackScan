/**
 * One-shot repair script for the 53 already-auto-saved 2026 Topps Series One
 * cards from the bulk-scan batch reported on 2026-05-02.
 *
 * Background — what this script DOES:
 *   - Re-runs the new post-processing coercions (set normalization,
 *     collection→"Base Set" defaulting) from `server/vlmApply.ts` against
 *     the persisted `scan_batch_items.analysisResult` JSONB blob for a
 *     hardcoded list of item ids.
 *   - Writes the coerced fields back into the same row.
 *
 * What this script DOES NOT do:
 *   - Touch the user's Google Sheet. Auto-saved items already appended a
 *     row to the sheet at scan time. Re-running this script does not
 *     change those rows. The user must edit the sheet directly, OR delete
 *     the affected rows from the sheet and reprocess.
 *   - Re-extract the YEAR. Year correction lives in the VLM prompt
 *     (`(b2)` modern-brand front-wordmark override). Fixing year on
 *     already-saved rows requires a reprocess: delete the row from the
 *     sheet first (the `/reprocess` endpoint blocks auto-saved items to
 *     prevent silent double-writes), then re-run the bulk sync.
 *
 * USAGE (manual, one-shot):
 *   DATABASE_URL=... npx tsx db/repairBulk2026Topps.ts
 *
 * The script is intentionally idempotent: running it twice produces the
 * same final state. Safe to re-run if it dies partway through.
 */

import { eq, inArray } from 'drizzle-orm';
import { db } from './index';
import { scanBatchItems } from '@shared/schema';
import { isBaseCollection, normalizeSetValue } from '../server/vlmApply';

// 53 affected scan_batch_items.id values, parsed from the user-reported
// `bulk-25-NNN` IDs (batch 25, item NNN). Hardcoded so the audit trail
// lives in git rather than a one-off CSV that disappears.
const AFFECTED_ITEM_IDS: number[] = [
  // Filled in from /tmp/scan_ids_to_audit.txt at runtime — see main().
];

function loadIdsFromTxt(path: string): number[] {
  const fs = require('node:fs') as typeof import('node:fs');
  const ids: number[] = [];
  for (const raw of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = raw.trim().match(/^bulk-\d+-(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) ids.push(n);
    }
  }
  return ids;
}

function coerceAnalysis(analysis: Record<string, any>): {
  next: Record<string, any>;
  changed: string[];
} {
  const changed: string[] = [];
  const next = { ...analysis };

  // SET: strip leading "<Brand> " / "<Year> <Brand> " prefix.
  if (typeof next.set === 'string' && next.set.trim()) {
    const brand = (next.brand ?? '').toString();
    const normalized = normalizeSetValue(next.set, brand);
    if (normalized !== next.set) {
      changed.push(`set: "${next.set}" → "${normalized}"`);
      next.set = normalized;
    }
  }

  // COLLECTION: default → "Base Set" when empty / sentinel / mirrors set.
  const setLower = (next.set ?? '').toString().trim().toLowerCase();
  const brandLower = (next.brand ?? '').toString().trim().toLowerCase();
  const collectionLower = (next.collection ?? '').toString().trim().toLowerCase();
  const brandedSetLower = brandLower && setLower ? `${brandLower} ${setLower}` : '';
  const mirrorsSet =
    !!setLower && (collectionLower === setLower || collectionLower === brandedSetLower);
  if (isBaseCollection(next.collection ?? '') || mirrorsSet) {
    if (next.collection !== 'Base Set') {
      changed.push(`collection: "${next.collection ?? ''}" → "Base Set"`);
      next.collection = 'Base Set';
    }
  }

  return { next, changed };
}

async function main() {
  const ids = process.argv[2]
    ? loadIdsFromTxt(process.argv[2])
    : AFFECTED_ITEM_IDS;
  if (ids.length === 0) {
    console.error('No item ids — pass a path to scan_ids_to_audit.txt as argv[2]');
    process.exit(2);
  }
  console.log(`Repairing ${ids.length} scan_batch_items rows...`);
  const rows = await db.select().from(scanBatchItems).where(inArray(scanBatchItems.id, ids));
  console.log(`Loaded ${rows.length}/${ids.length} rows from DB.`);

  let updated = 0;
  for (const row of rows) {
    const analysis = (row.analysisResult ?? {}) as Record<string, any>;
    const { next, changed } = coerceAnalysis(analysis);
    if (changed.length === 0) continue;
    await db
      .update(scanBatchItems)
      .set({ analysisResult: next })
      .where(eq(scanBatchItems.id, row.id));
    console.log(`  item=${row.id}: ${changed.join('; ')}`);
    updated += 1;
  }
  console.log(`Done. Updated ${updated}/${rows.length} rows. Sheet rows must be edited separately.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
