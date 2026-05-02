/**
 * One-shot backfill: populate `scan_grades.estimated_value` for historical
 * rows where it's NULL.
 *
 * Background — PR #219 added the `estimated_value` column so Recent Scans
 * tiles can render an eBay average price for scans that were never saved
 * as a card. Historical rows pre-#219 have NULL there; tiles for those
 * scans currently fall through to "No active listings".
 *
 * Strategy — re-run the same eBay lookup the live scan flow uses
 * (`searchCardValues` from server/ebayService.ts) and write the resulting
 * `averageValue` back via the existing `updateGradeEstimatedValue` helper
 * from server/holo/storage.ts. No schema changes, no runtime code paths
 * touched.
 *
 * Usage:
 *   npm run backfill:scan-grades                          # full backfill
 *   npm run backfill:scan-grades -- --dry-run             # log only
 *   npm run backfill:scan-grades -- --limit 10            # cap rows
 *   npm run backfill:scan-grades -- --delay-ms 500        # custom pacing
 *
 * Sequential and idempotent — re-running picks up any row still NULL,
 * including ones where the previous attempt found no listings (those stay
 * NULL until eBay sees comps for that card).
 */

import { eq, isNull, asc } from 'drizzle-orm';
import { db, pool } from '../db';
import { scanGrades, cards, brands } from '@shared/schema';
import { searchCardValues } from '../server/ebayService';
import { updateGradeEstimatedValue } from '../server/holo/storage';
import { formatGradeKeyword } from '../server/vlmGradingPrompt';

type Args = {
  dryRun: boolean;
  limit: number | null;
  delayMs: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, limit: null, delayMs: 250 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n);
    } else if (a === '--delay-ms') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 0) args.delayMs = Math.floor(n);
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: tsx scripts/backfill_scan_grades_estimated_value.ts [--dry-run] [--limit N] [--delay-ms N]',
      );
      process.exit(0);
    }
  }
  return args;
}

type IdentificationShape = {
  player?: string;
  brand?: string | null;
  setName?: string;
  collection?: string | null;
  year?: string | number;
  cardNumber?: string | null;
  serialNumber?: string | null;
  parallel?: string | null;
  variant?: string | null;
  sport?: string;
};

type Resolved = {
  playerName: string;
  cardNumber: string;
  brand: string;
  year: number;
  collection: string | undefined;
  set: string | undefined;
  isNumbered: boolean;
  foilType: string | undefined;
  serialNumber: string | undefined;
  variant: string | undefined;
  isAutographed: boolean;
  gradeKeyword: string | undefined;
};

function splitName(full: string): { first: string; last: string } {
  const trimmed = (full || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return { first: '', last: '' };
  const idx = trimmed.lastIndexOf(' ');
  if (idx === -1) return { first: '', last: trimmed };
  return { first: trimmed.slice(0, idx), last: trimmed.slice(idx + 1) };
}

function coerceYear(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === 'string') {
    const m = v.match(/\d{4}/);
    if (m) return Number(m[0]);
  }
  return 2024;
}

async function resolveFromCard(cardId: number): Promise<Resolved | null> {
  const [row] = await db
    .select({
      playerFirstName: cards.playerFirstName,
      playerLastName: cards.playerLastName,
      brandName: brands.name,
      collection: cards.collection,
      cardNumber: cards.cardNumber,
      year: cards.year,
      variant: cards.variant,
      serialNumber: cards.serialNumber,
      isNumbered: cards.isNumbered,
      isAutographed: cards.isAutographed,
      foilType: cards.foilType,
      isGraded: cards.isGraded,
      gradingCompany: cards.gradingCompany,
      numericalGrade: cards.numericalGrade,
    })
    .from(cards)
    .innerJoin(brands, eq(cards.brandId, brands.id))
    .where(eq(cards.id, cardId))
    .limit(1);
  if (!row) return null;
  const playerName = `${row.playerFirstName ?? ''} ${row.playerLastName ?? ''}`.trim();
  const gradeKeyword = row.isGraded
    ? formatGradeKeyword(row.gradingCompany ?? null, row.numericalGrade ?? null) || undefined
    : undefined;
  return {
    playerName,
    cardNumber: row.cardNumber || '',
    brand: row.brandName || '',
    year: row.year || 2024,
    collection: row.collection || undefined,
    set: undefined,
    isNumbered: !!row.isNumbered,
    foilType: row.foilType || undefined,
    serialNumber: row.serialNumber || undefined,
    variant: row.variant || undefined,
    isAutographed: !!row.isAutographed,
    gradeKeyword,
  };
}

function resolveFromIdentification(ident: IdentificationShape | null): Resolved | null {
  if (!ident) return null;
  const playerName = (ident.player || '').trim();
  if (!playerName) return null;
  const { first, last } = splitName(playerName);
  if (!first && !last) return null;
  return {
    playerName,
    cardNumber: (ident.cardNumber || '').trim(),
    brand: (ident.brand || '').trim(),
    year: coerceYear(ident.year),
    collection: ident.collection ? ident.collection.trim() : undefined,
    set: ident.setName ? ident.setName.trim() : undefined,
    isNumbered: !!(ident.serialNumber && ident.serialNumber.trim()),
    foilType: ident.parallel ? ident.parallel.trim() : undefined,
    serialNumber: ident.serialNumber ? ident.serialNumber.trim() : undefined,
    variant: ident.variant ? ident.variant.trim() : undefined,
    isAutographed: false,
    gradeKeyword: undefined,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseQuery = db
    .select({
      id: scanGrades.id,
      cardId: scanGrades.cardId,
      identification: scanGrades.identification,
    })
    .from(scanGrades)
    .where(isNull(scanGrades.estimatedValue))
    .orderBy(asc(scanGrades.createdAt));
  const rows = args.limit != null ? await baseQuery.limit(args.limit) : await baseQuery;

  console.log(
    `[backfill] scanning ${rows.length} scan_grades row(s) with estimated_value IS NULL` +
      (args.dryRun ? ' (DRY RUN — no writes)' : ''),
  );

  let updated = 0;
  let skippedNoListings = 0;
  let skippedNoFields = 0;
  let errored = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const idx = `[${i + 1}/${rows.length}]`;
    let resolved: Resolved | null = null;
    if (row.cardId != null) {
      try {
        resolved = await resolveFromCard(row.cardId);
      } catch (err) {
        console.warn(`${idx} scan_grades:${row.id} card-join failed:`, err);
      }
    }
    if (!resolved) {
      resolved = resolveFromIdentification(row.identification as IdentificationShape | null);
    }
    if (!resolved || !resolved.playerName) {
      console.log(`${idx} scan_grades:${row.id} → skipped (no card / identification fields)`);
      skippedNoFields += 1;
      continue;
    }
    const logHead =
      `${idx} scan_grades:${row.id} player="${resolved.playerName}" ` +
      `year=${resolved.year} set="${resolved.set || resolved.collection || ''}"`;
    try {
      const ebay = await searchCardValues(
        resolved.playerName,
        resolved.cardNumber,
        resolved.brand,
        resolved.year,
        resolved.collection,
        '',
        resolved.isNumbered,
        resolved.foilType,
        resolved.serialNumber,
        resolved.variant,
        resolved.isAutographed,
        undefined,
        resolved.set,
        resolved.gradeKeyword ? { gradeKeyword: resolved.gradeKeyword } : undefined,
      );
      const value = ebay?.averageValue;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        if (args.dryRun) {
          console.log(`${logHead} → $${value.toFixed(2)} (dry-run, not written)`);
        } else {
          await updateGradeEstimatedValue(row.id, value);
          console.log(`${logHead} → $${value.toFixed(2)}`);
        }
        updated += 1;
      } else {
        console.log(`${logHead} → no listings`);
        skippedNoListings += 1;
      }
    } catch (err: any) {
      console.warn(`${logHead} → error: ${err?.message || err}`);
      errored += 1;
    }
    if (args.delayMs > 0 && i < rows.length - 1) {
      await new Promise((r) => setTimeout(r, args.delayMs));
    }
  }

  console.log(
    `[backfill] done — scanned=${rows.length} updated=${updated} ` +
      `no-listings=${skippedNoListings} no-fields=${skippedNoFields} errored=${errored}` +
      (args.dryRun ? ' (DRY RUN)' : ''),
  );
}

main()
  .then(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[backfill] fatal:', err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
