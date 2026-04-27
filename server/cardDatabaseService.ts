/**
 * Card Database Service
 * 
 * Provides DB-driven card lookup using imported CSV data.
 * OCR detects brand/year/card-number → this service looks up authoritative
 * card info (player name, team, rookie status, collection, variation).
 * Falls back to OCR-only results if no match is found.
 */

import { db } from '../db';
import { cardDatabase, cardVariations } from '../shared/schema';
import { and, eq, sql, inArray } from 'drizzle-orm';
import { parse } from 'csv-parse/sync';
import { parse as parseStream } from 'csv-parse';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { Readable } from 'stream';

const CARDS_CSV    = resolve('attached_assets/Baseball_Card_Database_-_baseball_cards_(5)_1775393864176.csv');
const VARS_CSV     = resolve('attached_assets/Baseball_Card_Database_-_baseball_card_variations_(3)_1775393870208.csv');

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface CardLookupInput {
  brand?: string;
  year?: number;
  collection?: string;
  cardNumber?: string;
  serialNumber?: string;
  playerLastName?: string;  // used to disambiguate when prefix-matching finds multiple candidates
  /**
   * Optional hint (a parallel/variant name guessed upstream) used to pick one
   * variation when the serial-based or NULL-serial DB lookup returns multiple
   * candidates. e.g. multiple base-line variations could exist for a set; if
   * the hint matches one of their names (token overlap), that one is picked.
   */
  parallelHint?: string;
  /**
   * Raw OCR text from front and/or back of the card. Used as a generic
   * tiebreaker when multiple DB rows share the same brand+year+cardNumber:
   * if exactly one candidate row's collection or set name appears verbatim
   * in this text, that row is preferred. This lets us discover any subset
   * label printed on the card (e.g. "FUTURE STARS") without maintaining a
   * hand-curated list of subset names — the DB itself is the vocabulary.
   */
  ocrText?: string;
  /**
   * Detected sport for this scan (e.g. "Basketball", "Football", "Hockey",
   * "Baseball"). When provided, the lookup filters out rows whose `brandId`
   * suffix names a different sport — a basketball OCR scan will never match
   * a `panini_football` row even if brand+year+cardNumber happen to overlap.
   * The cardDatabase has no `sport` column today; brandId suffixes
   * (e.g. "panini_basketball", "topps_baseball") are the de-facto sport
   * indicator. Cross-sport overlap is the canonical 2024-25 Hoops failure
   * mode where Brunson #74 was being matched against unrelated sport rows.
   */
  sport?: string;
}

export interface CardLookupResult {
  found: boolean;
  playerFirstName?: string;
  playerLastName?: string;
  team?: string;
  collection?: string;
  set?: string;             // product set name from card_database or card_variations
  cardNumber?: string;      // authoritative card number from DB (e.g. "T91-13")
  variation?: string;
  serialNumber?: string;
  isRookieCard?: boolean;
  brand?: string;
  year?: number;
  cmpNumber?: string;       // internal CMP reference code from card_database
  source: 'card_database' | 'ocr_fallback';
  /** All candidate variation names found (when more than one matched the
   * serial-or-NULL-serial filter). When set and `variation` is undefined, the
   * caller should ask the user to confirm which parallel they have. */
  variationOptions?: string[];
  /** True when multiple variations matched and the parallelHint did not
   * uniquely resolve to one of them. */
  variationAmbiguous?: boolean;
  /** True when multiple distinct collection/set rows matched the same
   * brand+year+cardNumber and neither OCR-text vocabulary nor player-name
   * matching could uniquely pick one. The caller should prompt the user to
   * choose from `collectionCandidates`. The default `collection`/`set` fields
   * still hold the best-guess pick from the tiebreak ladder. */
  collectionAmbiguous?: boolean;
  /** Distinct candidate collection/set rows surfaced when
   * `collectionAmbiguous` is true. Already deduped by collection+set and
   * capped to a small number for UI display. */
  collectionCandidates?: Array<{
    brand: string;
    year: number;
    collection: string;
    set: string | null;
    cardNumber: string;
    playerName: string;
    isRookieCard: boolean;
  }>;
}

export interface CsvImportResult {
  cardsImported: number;
  variationsImported: number;
  errors: string[];
}

// ───────────────────────────────────────────────
// CSV Import
// ───────────────────────────────────────────────

/**
 * Import cards CSV into card_database table.
 * Expected columns: brand_id, brand, year, collection, card_number_raw,
 *                   cmp_number, player_name, team, rookie_flag, notes
 */
export async function importCardsCSV(csvBuffer: Buffer, onProgress?: (processed: number, total: number) => void): Promise<{ imported: number; replaced: number; errors: string[] }> {
  const errors: string[] = [];
  let imported = 0;
  let replaced = 0;

  const brandYearCombos = new Set<string>();
  let totalRows = 0;

  const streamParse = (buf: Buffer): AsyncIterable<Record<string, string>> =>
    Readable.from(buf).pipe(parseStream({ columns: true, skip_empty_lines: true, trim: true, relax_column_count: true }));

  for await (const row of streamParse(csvBuffer)) {
    totalRows++;
    const brand = (row['brand'] || row['Brand'] || '').trim();
    const brandId = (row['brand_id'] || row['Brand_id'] || '').trim();
    const yearStr = (row['year'] || row['Year'] || '').trim();
    if (brand && yearStr) {
      const year = parseInt(yearStr, 10);
      if (!isNaN(year) && year >= 1900 && year <= 2100) {
        const resolvedBrandId = brandId || brand.toLowerCase().replace(/\s+/g, '_');
        brandYearCombos.add(`${resolvedBrandId}|${year}`);
      }
    }
  }

  console.log(`[CardDB] Pass 1 complete: ${totalRows} CSV rows, ${brandYearCombos.size} brand+year combos`);
  onProgress?.(0, totalRows);

  for (const combo of brandYearCombos) {
    const [bId, yr] = combo.split('|');
    const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(cardDatabase)
      .where(and(eq(cardDatabase.brandId, bId), eq(cardDatabase.year, parseInt(yr))));
    const delCount = countRow?.count ?? 0;
    if (delCount > 0) {
      await db.delete(cardDatabase)
        .where(and(eq(cardDatabase.brandId, bId), eq(cardDatabase.year, parseInt(yr))));
      replaced += delCount;
    }
  }
  if (replaced > 0) console.log(`[CardDB] Removed ${replaced} existing card rows before re-import`);

  const BATCH_SIZE = 500;
  let batch: typeof cardDatabase.$inferInsert[] = [];
  let lineNum = 1;

  for await (const row of streamParse(csvBuffer)) {
    lineNum++;
    const brand = (row['brand'] || row['Brand'] || '').trim();
    const brandId = (row['brand_id'] || row['Brand_id'] || '').trim();
    const yearStr = (row['year'] || row['Year'] || '').trim();
    const collection = (row['collection'] || row['Collection'] || '').trim();
    const cardNumberRaw = (row['card_number_raw'] || row['Card_number_raw'] || '').trim();
    const playerName = (row['player_name'] || row['Player_name'] || '').trim();

    if (!brand || !yearStr || !collection || !cardNumberRaw || !playerName) {
      errors.push(`Line ${lineNum}: missing required field(s) — brand="${brand}" year="${yearStr}" collection="${collection}" card_number="${cardNumberRaw}" player="${playerName}"`);
      continue;
    }

    const year = parseInt(yearStr, 10);
    if (isNaN(year) || year < 1900 || year > 2100) {
      errors.push(`Line ${lineNum}: invalid year "${yearStr}"`);
      continue;
    }

    const resolvedBrandId = brandId || brand.toLowerCase().replace(/\s+/g, '_');
    batch.push({
      brandId: resolvedBrandId,
      brand,
      year,
      collection,
      set: (row['set'] || row['Set'] || '').trim() || null,
      cardNumberRaw,
      cmpNumber: (row['cmp_number'] || row['Cmp_number'] || '').trim() || null,
      playerName,
      team: (row['team'] || row['Team'] || '').trim() || null,
      rookieFlag: (row['rookie_flag'] || row['Rookie_flag'] || '').trim() || null,
      notes: (row['notes'] || row['Notes'] || '').trim() || null,
    });

    if (batch.length >= BATCH_SIZE) {
      try {
        await db.insert(cardDatabase).values(batch);
        imported += batch.length;
        onProgress?.(imported, totalRows);
      } catch (err: any) {
        errors.push(`Batch insert error at line ~${lineNum}: ${err.message}`);
      }
      batch = [];
    }
  }

  if (batch.length > 0) {
    try {
      await db.insert(cardDatabase).values(batch);
      imported += batch.length;
      onProgress?.(imported, totalRows);
    } catch (err: any) {
      errors.push(`Batch insert error (final): ${err.message}`);
    }
  }

  return { imported, replaced, errors };
}

/**
 * Import variations CSV into card_variations table.
 * Expected columns: brand_id, brand, year, collection, variation_or_parallel,
 *                   serial_number, cmp_number, hobby_odds, jumbo_odds, breaker_odds, value_odds
 */
export async function importVariationsCSV(csvBuffer: Buffer, onProgress?: (processed: number, total: number) => void): Promise<{ imported: number; replaced: number; errors: string[] }> {
  const errors: string[] = [];
  let imported = 0;
  let replaced = 0;

  const brandYearCombos = new Set<string>();
  let totalRows = 0;

  const streamParse = (buf: Buffer): AsyncIterable<Record<string, string>> =>
    Readable.from(buf).pipe(parseStream({ columns: true, skip_empty_lines: true, trim: true, relax_column_count: true }));

  for await (const row of streamParse(csvBuffer)) {
    totalRows++;
    const brand = (row['brand'] || row['Brand'] || '').trim();
    const brandId = (row['brand_id'] || row['Brand_id'] || '').trim();
    const yearStr = (row['year'] || row['Year'] || '').trim();
    if (brand && yearStr) {
      const year = parseInt(yearStr, 10);
      if (!isNaN(year) && year >= 1900 && year <= 2100) {
        const resolvedBrandId = brandId || brand.toLowerCase().replace(/\s+/g, '_');
        brandYearCombos.add(`${resolvedBrandId}|${year}`);
      }
    }
  }

  console.log(`[CardDB] Variations pass 1 complete: ${totalRows} CSV rows, ${brandYearCombos.size} brand+year combos`);
  onProgress?.(0, totalRows);

  for (const combo of brandYearCombos) {
    const [bId, yr] = combo.split('|');
    const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(cardVariations)
      .where(and(eq(cardVariations.brandId, bId), eq(cardVariations.year, parseInt(yr))));
    const delCount = countRow?.count ?? 0;
    if (delCount > 0) {
      await db.delete(cardVariations)
        .where(and(eq(cardVariations.brandId, bId), eq(cardVariations.year, parseInt(yr))));
      replaced += delCount;
    }
  }
  if (replaced > 0) console.log(`[CardDB] Removed ${replaced} existing variation rows before re-import`);

  const BATCH_SIZE = 500;
  let batch: typeof cardVariations.$inferInsert[] = [];
  let lineNum = 1;

  for await (const row of streamParse(csvBuffer)) {
    lineNum++;
    const brand = (row['brand'] || row['Brand'] || '').trim();
    const brandId = (row['brand_id'] || row['Brand_id'] || '').trim();
    const yearStr = (row['year'] || row['Year'] || '').trim();
    const collection = (row['collection'] || row['Collection'] || '').trim();
    const variation = (row['variation_or_parallel'] || row['Variation_or_parallel'] || '').trim();

    if (!brand || !yearStr || !collection || !variation) {
      errors.push(`Line ${lineNum}: missing required field(s)`);
      continue;
    }

    const year = parseInt(yearStr, 10);
    if (isNaN(year) || year < 1900 || year > 2100) {
      errors.push(`Line ${lineNum}: invalid year "${yearStr}"`);
      continue;
    }

    const rawSerial = (row['serial_number'] || row['Serial_number'] || '').trim();
    const serialNumber = normalizeSerial(rawSerial);

    const resolvedBrandId = brandId || brand.toLowerCase().replace(/\s+/g, '_');
    batch.push({
      brandId: resolvedBrandId,
      brand,
      year,
      collection,
      set: (row['set'] || row['Set'] || '').trim() || null,
      variationOrParallel: variation,
      serialNumber: serialNumber || null,
      cmpNumber: (row['cmp_number'] || row['Cmp_number'] || '').trim() || null,
      hobbyOdds: (row['hobby_odds'] || '').trim() || null,
      jumboOdds: (row['jumbo_odds'] || '').trim() || null,
      breakerOdds: (row['breaker_odds'] || '').trim() || null,
      valueOdds: (row['value_odds'] || '').trim() || null,
    });

    if (batch.length >= BATCH_SIZE) {
      try {
        await db.insert(cardVariations).values(batch);
        imported += batch.length;
        onProgress?.(imported, totalRows);
      } catch (err: any) {
        errors.push(`Batch insert error at line ~${lineNum}: ${err.message}`);
      }
      batch = [];
    }
  }

  if (batch.length > 0) {
    try {
      await db.insert(cardVariations).values(batch);
      imported += batch.length;
      onProgress?.(imported, totalRows);
    } catch (err: any) {
      errors.push(`Batch insert error (final): ${err.message}`);
    }
  }

  return { imported, replaced, errors };
}

// ───────────────────────────────────────────────
// Card Lookup
// ───────────────────────────────────────────────

/**
 * Look up a card in the database given OCR-detected fields.
 * Returns authoritative card data if found, or { found: false } to signal fallback.
 */
/**
 * Map a detected sport label to the lowercase token that appears as the
 * brandId suffix in cardDatabase (e.g. "Basketball" → "basketball"). Returns
 * null when the sport is unknown / "Not detected" so the caller can skip the
 * filter rather than reject every row. Generic across brands — brandId
 * convention is `<brand>_<sport>` for every modern entry.
 */
function sportTokenForBrandId(sport: string | undefined | null): string | null {
  if (!sport) return null;
  const s = sport.trim().toLowerCase();
  if (!s || s === 'not detected' || s === 'unknown') return null;
  // Pass-through for the canonical four sports plus their league-name aliases.
  if (s === 'basketball' || s === 'nba') return 'basketball';
  if (s === 'football' || s === 'nfl') return 'football';
  if (s === 'baseball' || s === 'mlb') return 'baseball';
  if (s === 'hockey' || s === 'nhl') return 'hockey';
  return null;
}

export async function lookupCard(input: CardLookupInput): Promise<CardLookupResult> {
  const { brand, year, collection, cardNumber, serialNumber, playerLastName, ocrText, sport } = input;

  if (!brand || !year || !cardNumber) {
    return { found: false, source: 'ocr_fallback' };
  }

  // Resolve sport token early so both the initial fetch and the year-shift
  // fallback can apply the same brandId-suffix guard.
  const sportToken = sportTokenForBrandId(sport);

  try {
    // Normalize brand for fuzzy matching
    const brandNorm = normalizeBrand(brand);
    const cardNumNorm = normalizeCardNumber(cardNumber);

    // ── Step 1: Find the card in card_database ──────────────────────────
    // Match on brand (fuzzy), year, and card number. Collection is optional
    // since OCR sometimes misreads or misses collection names.

    // Loosen separator/whitespace variants for LL-LL autograph / insert
    // codes so OCR reads of "RA-JE" / "RA JE" / "RAJE" all resolve to the
    // same DB row. Pure numeric numbers are not loosened.
    const cardNumVariants = cardNumberVariants(cardNumNorm);
    if (cardNumVariants.length > 1) {
      console.log(`[CardDB] Loosening card# "${cardNumNorm}" → trying variants [${cardNumVariants.join(', ')}]`);
    }

    let cardRows = await db
      .select()
      .from(cardDatabase)
      .where(
        and(
          sql`lower(${cardDatabase.brand}) = lower(${brandNorm})`,
          eq(cardDatabase.year, year),
          inArray(
            sql`lower(${cardDatabase.cardNumberRaw})`,
            cardNumVariants.map(v => v.toLowerCase())
          )
        )
      )
      .limit(200);

    // Sport filter via brandId suffix. brandId convention is
    // "<brand>_<sport>" (e.g. "panini_basketball", "topps_baseball"). When the
    // OCR detected a definite sport, drop rows whose brandId names a
    // different sport — these are cross-sport collisions where brand+year+
    // cardNumber happen to overlap across product lines (the canonical
    // Brunson #74 NBA Hoops failure mode where lookups picked up unrelated
    // sport rows). Rows with no clear sport suffix in their brandId pass
    // through unchanged so non-modern catalog data isn't accidentally hidden.
    const filterBySport = (rows: typeof cardRows): typeof cardRows => {
      if (!sportToken) return rows;
      const filtered = rows.filter(r => {
        const bid = (r.brandId || '').toLowerCase();
        // No sport indicator in brandId — keep (older / non-conventional
        // imports where the suffix may be missing).
        if (!/_[a-z]+$/.test(bid)) return true;
        // Suffix must match the detected sport. Anything else is dropped.
        return bid.endsWith(`_${sportToken}`);
      });
      if (filtered.length !== rows.length) {
        console.log(`[CardDB] Sport filter ("${sportToken}"): ${rows.length} → ${filtered.length} rows after dropping cross-sport brandId matches`);
      }
      return filtered;
    };
    cardRows = filterBySport(cardRows);

    // ── Step 1a: Off-by-one year fallback (copyright→release convention) ──
    // Several manufacturers consistently printed the prior-year copyright on
    // the card back, even though the card was sold as the next year's set.
    // Documented patterns:
    //   • Vintage Topps/Fleer/Donruss (pre-1987): © year = release year - 1
    //     (e.g. a 1979 Topps card shows "© 1978" with stats through 1978).
    //   • Donruss 1984–1993: card says "© 1989 Donruss" but set = 1990.
    //   • Score   1988–1992: card says "© 1988 Score"   but set = 1989.
    //   • Fleer   early 1980s: occasional one-year lag.
    // We approach this generically: if the exact-year lookup misses, try
    // year+1, then year-1. Both retries are scoped to the same brand and
    // card-number so they cannot leak across unrelated sets. The matched
    // row's actual year is what we return downstream, so the eBay search
    // will use the corrected release year automatically.
    const tryYearShift = async (shifted: number, label: string) => {
      if (shifted < 1900 || shifted > new Date().getFullYear() + 1) return;
      if (cardRows.length > 0) return;
      const shiftedRowsRaw = await db
        .select()
        .from(cardDatabase)
        .where(
          and(
            sql`lower(${cardDatabase.brand}) = lower(${brandNorm})`,
            eq(cardDatabase.year, shifted),
            inArray(
              sql`lower(${cardDatabase.cardNumberRaw})`,
              cardNumVariants.map(v => v.toLowerCase())
            )
          )
        )
        .limit(10);
      const shiftedRows = filterBySport(shiftedRowsRaw);
      if (shiftedRows.length > 0) {
        console.log(`[CardDB] ${label} year fallback: no match for ${year} ${brandNorm} #${cardNumNorm}; found ${shiftedRows.length} match(es) at year ${shifted}`);
        cardRows = shiftedRows;
      }
    };

    if (cardRows.length === 0) {
      // year+1 first (covers vintage Topps/Fleer/Donruss pre-1987 AND the
      // Donruss/Score 1984-1993 copyright-lag rule).
      await tryYearShift(year + 1, '+1');
      // year-1 as final retry (catches the rarer reverse case).
      await tryYearShift(year - 1, '-1');
    }

    // Normalize ordinal words to digits so "Series Two" == "Series 2" etc.
    // Pulled up here so both the collection-scoring pass below AND the OCR-text
    // vocabulary tiebreak (further down) can use the same normalisation —
    // otherwise a Topps Series 1 back ("@TOPPS Series 1") fails to match the
    // DB row whose set is "Series One", and ties get broken alphabetically
    // (Opening Day winning over Series One for Judge 2021 #99).
    const normalizeOrdinals = (s: string) =>
      s.replace(/\bone\b/gi, '1')
       .replace(/\btwo\b/gi, '2')
       .replace(/\bthree\b/gi, '3')
       .replace(/\bfour\b/gi, '4')
       .replace(/\bfive\b/gi, '5')
       .replace(/\bsix\b/gi, '6')
       .replace(/\bseven\b/gi, '7')
       .replace(/\beight\b/gi, '8')
       .replace(/\bnine\b/gi, '9');

    // If collection provided, score and filter by collection + set similarity.
    // The OCR text from the back of a card (e.g. "SERIES TWO", "SAPPHIRE") often
    // maps directly to the DB `set` column rather than `collection`. Scoring both
    // columns and taking the max ensures e.g. "SERIES TWO" correctly prefers
    // "Series Two" over "Topps Chrome Sapphire" rows.
    if (cardRows.length > 1 && collection) {
      const collectionNorm = normalizeOrdinals(collection.trim().toLowerCase());

      const matchScore = (dbStr: string): number => {
        const norm = normalizeOrdinals(dbStr.toLowerCase());
        if (norm === collectionNorm) return 100;
        // DB is a superset of OCR text (e.g. DB "Chrome Prospects" contains OCR "Chrome").
        // Score 90 — nearly as good as exact, and more specific is better for eBay filtering.
        if (norm.includes(collectionNorm)) return 90;
        // OCR is a superset of DB text (less common, lower confidence)
        if (collectionNorm.includes(norm)) return 50;
        return 0;
      };

      const scored = cardRows.map(r => {
        const colScore = matchScore(r.collection);
        const setScore = r.set ? matchScore(r.set) : 0;
        const score = Math.max(colScore, setScore);
        return { row: r, score };
      });

      const best = scored.filter(s => s.score > 0);
      if (best.length > 0) {
        best.sort((a, b) => b.score - a.score);
        cardRows = best.map(s => s.row);
        console.log(`[CardDB] Set/collection scoring: top pick "${cardRows[0].set || cardRows[0].collection}" (score ${best[0].score})`);
      }
    }

    // Shared tiebreak helper: when multiple candidate rows survive the lookup,
    // sort them by player-name match → OCR-text vocabulary match → specialty
    // deprioritisation → base-set / flagship preferences → shortest name. Used
    // by both the original multi-row code path AND the autograph-parallel
    // fallback below so any new disambiguation logic only has to live in one
    // place.
    const lastNameNormGlobal = (playerLastName || '').trim().toLowerCase();
    const brandLower = (brandNorm || '').toLowerCase().trim();
    const isSpecialtySubset = (col: string) => {
      const c = col.toLowerCase();
      return c.includes('autograph') || c.includes(' auto') || c.endsWith(' auto') ||
             c.includes('relic') || c.includes('patch') ||
             c.includes('memorabilia') || c.includes('signature') ||
             // Parallel/variation rows that happen to share the base card # —
             // these should never be the default pick without explicit OCR
             // evidence (e.g. detected foil/colour, serial number, or matching
             // collection text). Examples: "Team Color", "Golden Mirror Image
             // Variations", "Black and White Image Variations", "Rookie Design
             // Variations", "Inverted Variations", "1965 Inverted Variations".
             c.includes('variation') || c.includes('variations') ||
             /\bteam\s+color\b/.test(c) ||
             /\bmirror\s+image\b/.test(c) ||
             /\bnegative\b/.test(c) ||
             /\binverted\b/.test(c) ||
             /\bsuperfractor\b/.test(c) ||
             /\brefractor\b/.test(c);
    };
    const isBaseSet = (col: string) => {
      const c = col.toLowerCase().trim();
      return c === 'base set' || c === 'base';
    };

    // OCR-text vocabulary match: when raw OCR text is available, check
    // whether each candidate row's collection or set name appears
    // verbatim in the OCR text. The DB itself is the vocabulary, so we
    // never need to maintain a hand-curated list of subset names — any
    // label printed on the card that matches a real DB collection wins.
    // Normalize ordinal words to digits on BOTH sides so "Series 1" in OCR
    // matches "Series One" in DB (and vice-versa). Without this, the
    // tiebreak failed for Topps 2021 Judge #99 — the Series One back text
    // says "Series 1" but the DB row's set is "Series One", so neither
    // collection scored OCR points and the alphabetical fallback wrongly
    // picked Opening Day.
    // Collapse all whitespace (newlines, tabs, multiple spaces) into a single
    // space so multi-word names like "Flagship Collection" still match when
    // the OCR returns them on separate lines (raw backOCRText is newline-
    // delimited per detected text block — a card showing
    //   FLAGSHIP\nCOLLECTION
    // would otherwise fail to match the DB row "Flagship Collection" via
    // the literal-space regex below, and the alphabetical fallback would
    // wrongly pick "Spotlight" for Topps 2024 Pete Alonso #29.
    const ocrTextNorm = normalizeOrdinals((ocrText || '').toLowerCase()).replace(/\s+/g, ' ');
    // NOTE: do NOT add "series" here. We match the full phrase
    // ("Series One" / "Series 1" / "Series Two") against the OCR text via
    // a word-boundary regex, so the danger of "series" alone matching
    // unrelated cards doesn't apply. Adding it caused Series One to be
    // rejected as "not meaningful" (only "one" left after stripping +
    // length filter), so the OCR-vocab tiebreak scored 0 for both
    // Series One and Opening Day on Topps 2021 Judge #99 → alphabetical
    // fallback wrongly picked Opening Day.
    const stripWords = new Set(['set', 'cards', 'card', 'the', 'and', 'of', 'a', 'an', 'edition', 'baseball', 'basketball', 'football', 'hockey']);
    const isMeaningfulName = (name: string): boolean => {
      const tokens = name.toLowerCase().split(/\s+/).filter(t => t.length > 0);
      const meaningful = tokens.filter(t => !stripWords.has(t) && t.length >= 3);
      // Need at least one meaningful token of length >= 4, OR multiple
      // meaningful tokens — avoids matching trivial words like "Base".
      return meaningful.some(t => t.length >= 4) || meaningful.length >= 2;
    };
    const ocrContainsName = (name: string): boolean => {
      if (!ocrTextNorm || !name) return false;
      const norm = normalizeOrdinals(name.toLowerCase().trim());
      if (!norm || !isMeaningfulName(norm)) return false;
      // Word-boundary match against OCR text.
      const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`).test(ocrTextNorm);
    };
    const ocrMatchScore = (row: { collection: string; set: string | null }): number => {
      const colMatch = ocrContainsName(row.collection) ? 1 : 0;
      const setMatch = row.set ? (ocrContainsName(row.set) ? 1 : 0) : 0;
      return colMatch + setMatch;
    };

    /**
     * Sort candidate rows in place using the standard tiebreak ladder:
     * player-name match → OCR-vocab score → insert/specialty deprioritisation
     * → base-set / flagship-set preference → shortest collection name.
     * Logs the OCR-vocab winners and the final top pick under the given label.
     */
    const sortCandidatesByPreference = (rows: typeof cardRows, label: string) => {
      if (rows.length <= 1) return;
      // Pre-compute scores so we can log which row(s) won on OCR evidence.
      if (ocrTextNorm) {
        const scored = rows.map(r => ({ row: r, score: ocrMatchScore(r) }));
        const maxScore = Math.max(...scored.map(s => s.score));
        if (maxScore > 0) {
          const winners = scored.filter(s => s.score === maxScore).map(s => `"${s.row.collection}"${s.row.set ? ` / "${s.row.set}"` : ''}`);
          console.log(`[CardDB] OCR-text vocabulary match (${label}): top score=${maxScore}, ${winners.length} row(s) tied → ${winners.slice(0, 3).join(', ')}${winners.length > 3 ? ` (+${winners.length - 3} more)` : ''}`);
        }
      }

      rows.sort((a, b) => {
        // Primary: player name match (OCR is authoritative for who is on the card)
        const aNameMatch = lastNameNormGlobal && a.playerName.toLowerCase().includes(lastNameNormGlobal) ? 1 : 0;
        const bNameMatch = lastNameNormGlobal && b.playerName.toLowerCase().includes(lastNameNormGlobal) ? 1 : 0;
        if (aNameMatch !== bNameMatch) return bNameMatch - aNameMatch;
        // Secondary: OCR-text vocabulary match — rows whose collection/set
        // name appears in the printed card text are strongly preferred.
        const aOcrScore = ocrMatchScore(a);
        const bOcrScore = ocrMatchScore(b);
        if (aOcrScore !== bOcrScore) return bOcrScore - aOcrScore;
        // Deprioritise insert/sub-collections with " - " separators.
        const aIsInsert = a.collection.includes(' - ') ? 1 : 0;
        const bIsInsert = b.collection.includes(' - ') ? 1 : 0;
        if (aIsInsert !== bIsInsert) return aIsInsert - bIsInsert;
        // Deprioritise autograph/relic/patch/memorabilia subsets — these need an
        // explicit OCR signal (visible signature/swatch) to be the right match.
        const aIsSpecialty = isSpecialtySubset(a.collection) ? 1 : 0;
        const bIsSpecialty = isSpecialtySubset(b.collection) ? 1 : 0;
        if (aIsSpecialty !== bIsSpecialty) return aIsSpecialty - bIsSpecialty;
        // Prefer "Base Set" / "Base" as the safe default for tied non-specialty rows.
        const aIsBase = isBaseSet(a.collection) ? 1 : 0;
        const bIsBase = isBaseSet(b.collection) ? 1 : 0;
        if (aIsBase !== bIsBase) return bIsBase - aIsBase;
        // Prefer the row whose `set` EXACTLY matches the OCR brand — this is the
        // flagship product. e.g. OCR brand="Bowman" → prefer set="Bowman" over
        // set="Bowman Chrome Sapphire". Without this, the shorter-collection-name
        // tiebreak would pick "Base" (specialty set) over "Base Set" (flagship).
        const aSet = (a.set || '').toLowerCase().trim();
        const bSet = (b.set || '').toLowerCase().trim();
        const aSetIsFlagship = brandLower && aSet === brandLower ? 1 : 0;
        const bSetIsFlagship = brandLower && bSet === brandLower ? 1 : 0;
        if (aSetIsFlagship !== bSetIsFlagship) return bSetIsFlagship - aSetIsFlagship;
        // Next best: prefer the row whose `set` STARTS WITH the brand and is
        // the shortest such set — covers cases like brand="Topps" with no
        // flagship "Topps" row, preferring "Topps Chrome" over "Topps Chrome Sapphire".
        const aSetMatchesBrand = brandLower && aSet.startsWith(brandLower) ? 1 : 0;
        const bSetMatchesBrand = brandLower && bSet.startsWith(brandLower) ? 1 : 0;
        if (aSetMatchesBrand !== bSetMatchesBrand) return bSetMatchesBrand - aSetMatchesBrand;
        if (aSetMatchesBrand && bSetMatchesBrand && aSet.length !== bSet.length) {
          return aSet.length - bSet.length;
        }
        // Final tiebreak: prefer shorter (more general) collection names for non-specialty rows.
        return a.collection.length - b.collection.length;
      });
      console.log(`[CardDB] Tiebreak (${label}) — ${rows.length} candidate(s), top pick "${rows[0].playerName}" (${rows[0].set || rows[0].collection})`);
    };

    // When still multiple hits, use the OCR player name to pick the best match.
    // The same card number often maps to different players across sets (e.g.
    // Bowman 2022 #91 = Scherzer in "Bowman Baseball", Turner in "Bowman Chrome Sapphire").
    let collectionAmbiguousCandidates: typeof cardRows | null = null;
    if (cardRows.length > 1) {
      sortCandidatesByPreference(cardRows, 'card-number match');

      // ── Collection-ambiguity detection ─────────────────────────────────
      // When multiple non-specialty rows survive AND none of them has a
      // unique signal advantage over the others, surface the top candidates
      // so the caller can prompt the user to pick the right Set/Collection.
      // Without this, the tiebreak ladder silently picks an arbitrary
      // alphabetically-shortest set (e.g. Topps 2024 Ohtani #1 quietly
      // resolved to "Big League" or "Chrome" with no way for the user to
      // tell us they actually have a different one).
      let pool = cardRows.filter(r => !isSpecialtySubset(r.collection) && !r.collection.includes(' - '));
      // Narrow to player-matching rows first when a player name is available.
      // Card # often collides across sets with completely different players
      // (e.g. Topps 2024 #1 = Ohtani in some sets, Judge / Trout / Acuña in
      // others). Without this narrowing the OCR-vocab tie check almost never
      // fires because non-Ohtani rows count as "differentiated by player".
      if (lastNameNormGlobal && pool.length > 1) {
        const playerMatches = pool.filter(r => r.playerName.toLowerCase().includes(lastNameNormGlobal));
        if (playerMatches.length >= 1) pool = playerMatches;
      }
      if (pool.length >= 2) {
        const ocrScores = pool.map(r => ocrMatchScore(r));
        const topOcr = Math.max(...ocrScores);
        const ocrWinners = pool.filter(r => ocrMatchScore(r) === topOcr);
        const ocrSignalUnique = topOcr > 0 && ocrWinners.length === 1;
        if (!ocrSignalUnique) {
          // No signal differentiates the player-matched candidates. Dedupe by
          // (collection, set, player) — duplicate CSV rows with the same
          // set/collection and player are the same card from the user's
          // perspective.
          const seen = new Set<string>();
          const deduped: typeof cardRows = [];
          for (const r of pool) {
            const key = `${(r.collection || '').toLowerCase().trim()}||${(r.set || '').toLowerCase().trim()}||${(r.playerName || '').toLowerCase().trim()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push(r);
            if (deduped.length >= 8) break;
          }
          if (deduped.length >= 2) {
            collectionAmbiguousCandidates = deduped;
            console.log(`[CardDB] Collection ambiguous: ${deduped.length} candidates with no disambiguating signal — will surface for user pick (top default: "${cardRows[0].set || cardRows[0].collection}")`);
          }
        }
      }
    }

    // ── Step 1b: Prefix-match fallback ──────────────────────────────────
    // If OCR truncated the card number (e.g. "T91" instead of "T91-13"),
    // try finding cards whose DB card number STARTS WITH the OCR number.
    if (cardRows.length === 0 && cardNumNorm.length >= 2) {
      const prefixRows = await db
        .select()
        .from(cardDatabase)
        .where(
          and(
            sql`lower(${cardDatabase.brand}) = lower(${brandNorm})`,
            eq(cardDatabase.year, year),
            sql`lower(${cardDatabase.cardNumberRaw}) like lower(${cardNumNorm + '-%'})`
          )
        )
        .limit(50);

      const prefixRowsFiltered = filterBySport(prefixRows);
      if (prefixRowsFiltered.length > 0) {
        console.log(`[CardDB] Prefix match found ${prefixRowsFiltered.length} candidate(s) for "${cardNumNorm}"`);
        // Score each candidate: boost rows whose player name contains the OCR player last name
        const lastNameNorm = (playerLastName || '').trim().toLowerCase();
        const scored = prefixRowsFiltered.map(r => {
          const dbName = r.playerName.toLowerCase();
          const nameMatch = lastNameNorm && dbName.includes(lastNameNorm) ? 100 : 0;
          return { row: r, score: nameMatch };
        });
        scored.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          // Secondary: prefer shorter card numbers (more specific match)
          return a.row.cardNumberRaw.length - b.row.cardNumberRaw.length;
        });
        if (scored[0].score > 0) {
          console.log(`[CardDB] Prefix match winner: ${scored[0].row.cardNumberRaw} (${scored[0].row.playerName}) — name matched "${lastNameNorm}"`);
        }
        cardRows = scored.map(s => s.row);
      }
    }

    // ── Step 1b2: Cross-year fallback for letter-bearing card numbers ──
    // Modern insert/parallel cards often encode a vintage design year in the
    // card number itself (e.g. Topps 2022 "1987 Topps Baseball" #T87-31, Topps
    // 2025 "1990 Topps Baseball" #T90-72). The OCR sees the printed design
    // year (1987, 1990) and uses it as the lookup year, so the exact
    // (brand, year, cardNumber) match fails. Card numbers that contain at
    // least one letter (T87-31, MLM-CCO, RC-CCO) are unique enough across
    // years that we can safely widen the search to all years for the same
    // brand and let the existing tiebreak (player name + OCR-text vocabulary)
    // pick the right row. Pure numeric card numbers (1, 100) are excluded —
    // they collide across thousands of sets and would introduce ambiguity.
    if (cardRows.length === 0 && /[A-Za-z]/.test(cardNumNorm) && cardNumNorm.length >= 3) {
      const anyYearRows = await db
        .select()
        .from(cardDatabase)
        .where(
          and(
            sql`lower(${cardDatabase.brand}) = lower(${brandNorm})`,
            sql`lower(${cardDatabase.cardNumberRaw}) = lower(${cardNumNorm})`
          )
        )
        .limit(50);
      const anyYearRowsFiltered = filterBySport(anyYearRows);
      if (anyYearRowsFiltered.length > 0) {
        console.log(`[CardDB] Cross-year fallback: no match for ${brandNorm} year=${year} #${cardNumNorm}; found ${anyYearRowsFiltered.length} match(es) across other years — letting tiebreak pick`);
        cardRows = anyYearRowsFiltered;
        sortCandidatesByPreference(cardRows, 'cross-year fallback');
      }
    }

    // ── Step 1c: Autograph-parallel-code fallback ──────────────────────
    // Some card numbers are parallel-specific autograph codes (e.g.
    // "EZA-JHT" for the End Zone Autographs Justin Herbert) that don't
    // appear in card_database (which catalogs the base card numbers like
    // "46"). When the OCR'd card number is letters-dash-letters with NO
    // digits AND we have a player last name, look the player up directly
    // in card_database for this brand+year and let the OCR-text vocabulary
    // tiebreak (further down) pick the correct collection/set (e.g. the
    // back text "PANINI-REVOLUTION" disambiguates Revolution from Prizm).
    // Recognise autograph/insert card-number shapes across separator
    // variants: "RA-JE", "RA JE", "RAJE", "EZA-JHT", etc. The regex below
    // checks the original OCR form; `cardNumVariants` (computed above)
    // expanded it to every separator-equivalent form.
    const looksLikeAutoCode =
      /^[A-Z]+(?:[\s\-._]+[A-Z0-9]+)+$/i.test(cardNumNorm) ||
      // No-separator run of letters that's too long to be a jersey or
      // base card number (e.g. "RAJE" ← "RA JE", "EZAJHT" ← "EZA-JHT")
      // but not a full word. Guard: 3–8 letters, all caps, no digits.
      /^[A-Z]{3,8}$/i.test(cardNumNorm);
    let autographFallbackUsed = false;
    if (cardRows.length === 0 && playerLastName && looksLikeAutoCode) {
      const lastNameNorm = playerLastName.trim().toLowerCase();
      if (lastNameNorm.length >= 2) {
        const playerRows = await db
          .select()
          .from(cardDatabase)
          .where(
            and(
              sql`lower(${cardDatabase.brand}) = lower(${brandNorm})`,
              eq(cardDatabase.year, year),
              sql`lower(${cardDatabase.playerName}) like ${'%' + lastNameNorm + '%'}`
            )
          )
          .limit(200);
        const playerRowsFiltered = filterBySport(playerRows);
        if (playerRowsFiltered.length > 0) {
          console.log(`[CardDB] Autograph-parallel fallback: card number "${cardNumNorm}" not found; falling back to player "${playerLastName}" lookup → ${playerRowsFiltered.length} candidate(s)`);
          cardRows = playerRowsFiltered;
          autographFallbackUsed = true;
          // Run the same OCR-vocab + base-set tiebreak we use for the
          // multi-row card-number path. Without this, the player fallback
          // returns rows in Postgres order and cardRows[0] picks an
          // arbitrary set (e.g. Rookies & Stars #1) instead of the one
          // whose collection/set name actually appears in the OCR text
          // (e.g. Revolution from "PANINI-REVOLUTION FOOTBALL").
          sortCandidatesByPreference(cardRows, 'autograph-parallel fallback');
        }
      }
    }

    if (cardRows.length === 0) {
      console.log(`[CardDB] No match found for brand="${brandNorm}" year=${year} cardNumber="${cardNumNorm}"`);
      return { found: false, source: 'ocr_fallback' };
    }

    const cardRow = cardRows[0];
    console.log(`[CardDB] Match found: ${cardRow.playerName} (${cardRow.brand} ${cardRow.year} #${cardRow.cardNumberRaw})`);

    // Split player name into first/last
    const { firstName, lastName } = splitPlayerName(cardRow.playerName);
    const isRookieCard = !!(cardRow.rookieFlag && cardRow.rookieFlag.toLowerCase().includes('rookie'));

    // ── Step 2: Find the matching variation ────────────────────────────
    // Match by brand + year + collection. Then narrow by serial number if provided.

    const variationResult = await lookupVariation({
      brandId: cardRow.brandId,
      year: cardRow.year,
      collection: cardRow.collection,
      set: cardRow.set || undefined,
      serialNumber,
      parallelHint: input.parallelHint,
    });

    // Resolve set: prefer card_database.set, fall back to (single) variation row's set
    const resolvedSet = cardRow.set || variationResult.picked?.set || undefined;

    // When the autograph-parallel fallback was used, the matched DB row is
    // the player's *base* card (e.g. Revolution #46) — but we cannot trust
    // its set/collection as authoritative for the card we actually scanned.
    // The card number the OCR read (e.g. RA-JE, EZA-JHT) is a parallel /
    // insert code that does not appear in the base catalog, so the row we
    // picked is just "some card this player appears on for this brand+year".
    // Injecting that row's set/collection into the final cardData is what
    // caused the 2020 Panini Origins Jacob Eason card to be mis-identified
    // as 2020 Panini Prizm.
    //
    // Aggressive rule: in the autograph fallback, preserve the OCR card
    // number and emit the player/team/rookie data for identity validation,
    // but DO NOT emit collection/set/variation from the unmatched row.
    // Holo + the front-wordmark product-line extractor own set/collection
    // in this path.
    const resolvedCardNumber = autographFallbackUsed ? cardNumNorm : cardRow.cardNumberRaw;
    if (autographFallbackUsed) {
      console.log(`[CardDB] Autograph-parallel fallback: preserving OCR'd card number "${cardNumNorm}" and NOT injecting set/collection from unmatched row (was "${cardRow.set || cardRow.collection}").`);
    }

    return {
      found: true,
      playerFirstName: firstName,
      playerLastName: lastName,
      team: cardRow.team || undefined,
      collection: autographFallbackUsed ? undefined : cardRow.collection,
      set: autographFallbackUsed ? undefined : (resolvedSet || undefined),
      cardNumber: resolvedCardNumber,
      variation: autographFallbackUsed ? undefined : variationResult.picked?.variationOrParallel,
      variationOptions: autographFallbackUsed ? undefined : variationResult.options,
      variationAmbiguous: autographFallbackUsed ? undefined : variationResult.ambiguous,
      serialNumber: variationResult.picked?.serialNumber || serialNumber,
      isRookieCard,
      brand: cardRow.brand,
      year: cardRow.year,
      cmpNumber: cardRow.cmpNumber || undefined,
      source: 'card_database',
      collectionAmbiguous: !!collectionAmbiguousCandidates,
      collectionCandidates: collectionAmbiguousCandidates
        ? collectionAmbiguousCandidates.map(r => ({
            brand: r.brand,
            year: r.year,
            collection: r.collection,
            set: r.set,
            cardNumber: r.cardNumberRaw,
            playerName: r.playerName,
            isRookieCard: !!(r.rookieFlag && r.rookieFlag.toLowerCase().includes('rookie')),
          }))
        : undefined,
    };

  } catch (err: any) {
    console.error('[CardDB] Lookup error:', err.message);
    return { found: false, source: 'ocr_fallback' };
  }
}

// ───────────────────────────────────────────────
// Player-anchored fallback lookup (H-3)
// ───────────────────────────────────────────────

export interface PlayerAnchoredLookupInput {
  brand: string;
  year: number;
  /** Last name, case-insensitive substring match against card_database.player_name. */
  playerLastName: string;
  /** Optional: if provided and non-empty, require first-name match too. */
  playerFirstName?: string;
  /** Optional: narrow to a specific collection/set (e.g. "Series One") — case-insensitive. */
  collection?: string;
  /** Optional: the "wrong" card number the caller originally tried (OCR mis-read
   *  or user mis-spoke). When provided and it has a non-numeric prefix like
   *  "T88-", "US", "RC-", or "H", rows whose cardNumberRaw shares the same
   *  prefix get a strong score boost — breaking ties when the player appears
   *  on multiple cards in the same set. Without this, "Griffey T88-80" (where
   *  the real card is T88-82) would tie T88-82 against base-set #1 and
   *  refuse to auto-correct. */
  cardNumberHint?: string;
  /** Optional: sport context (e.g. "Basketball", "NBA") used to filter
   *  cardDatabase rows by brandId suffix so an NBA scan can't reach
   *  across to a baseball/football brand row at the same brand+year+lastName. */
  sport?: string;
}

/**
 * Player-anchored fallback lookup (H-3).
 *
 * Precondition: the standard (brand, year, cardNumber) lookup and all of its
 * ±year fallbacks returned no matching row whose player name agrees with the
 * OCR. That is overwhelming evidence that the *card number* — not the player,
 * brand, or year — is what OCR got wrong.
 *
 * Strategy: drop the card number from the query entirely and search by
 * (brand, year, playerLastName). If exactly one row matches, auto-correct
 * the card number to that row's value. If multiple rows match (the player
 * appears on multiple cards in the same set — base + subset + insert), we
 * refuse to auto-pick rather than guess wrong; the caller keeps the OCR
 * number and the UI surfaces the ambiguity.
 *
 * Scoped tightly to (brand, year) to avoid cross-set leakage, and uses
 * last-name substring matching so middle initials / suffixes ("Jr.")
 * don't force a miss.
 */
export async function lookupCardByPlayer(
  input: PlayerAnchoredLookupInput
): Promise<CardLookupResult> {
  const { brand, year, playerLastName, playerFirstName, collection, cardNumberHint } = input;

  if (!brand || !year || !playerLastName || playerLastName.trim().length < 2) {
    return { found: false, source: 'ocr_fallback' };
  }

  try {
    const brandNorm = normalizeBrand(brand);
    const lastNameNorm = playerLastName.trim().toLowerCase();
    const firstNameNorm = playerFirstName?.trim().toLowerCase() || '';
    const sportToken = sportTokenForBrandId(input.sport);

    // Build a list of candidate rows across the exact year plus ±1 (the
    // surrounding retry window that the main lookupCard loop already
    // probed). The caller tells us those all rejected on player-name
    // mismatch, so we expect the real match to come from the exact year
    // in the vast majority of cases — but we include ±1 for the same
    // copyright-lag reasons the main lookup does.
    const yearCandidates = [year, year + 1, year - 1];
    let allRows: Array<typeof cardDatabase.$inferSelect> = [];
    for (const yr of yearCandidates) {
      if (yr < 1900 || yr > new Date().getFullYear() + 1) continue;
      const rowsRaw = await db
        .select()
        .from(cardDatabase)
        .where(
          and(
            sql`lower(${cardDatabase.brand}) = lower(${brandNorm})`,
            eq(cardDatabase.year, yr),
            sql`lower(${cardDatabase.playerName}) LIKE ${'%' + lastNameNorm + '%'}`
          )
        )
        .limit(50);
      // Apply the same brandId-suffix sport guard used by the primary
      // lookup path so the player-anchored fallback can't reach across
      // sports either (e.g. an NBA OCR scan must not match a baseball
      // brandId player row).
      const rows = sportToken
        ? rowsRaw.filter(r => {
            const bid = (r.brandId || '').toLowerCase();
            if (!/_[a-z]+$/.test(bid)) return true;
            return bid.endsWith(`_${sportToken}`);
          })
        : rowsRaw;
      if (rows.length > 0) {
        console.log(`[CardDB] Player-anchored probe year=${yr} lastName="${lastNameNorm}" → ${rows.length} candidate row(s)${sportToken && rows.length !== rowsRaw.length ? ` (filtered ${rowsRaw.length}→${rows.length} by sport=${sportToken})` : ''}`);
        allRows.push(...rows);
      }
    }

    if (allRows.length === 0) {
      console.log(`[CardDB] Player-anchored fallback: no rows for brand="${brandNorm}" year≈${year} lastName="${lastNameNorm}"`);
      return { found: false, source: 'ocr_fallback' };
    }

    // If first name was provided, use it as a tiebreaker but don't filter
    // hard — some DB rows store nicknames or alternate spellings. Instead
    // score rows: +10 if last name matches as a standalone word at end,
    // +20 if first name also matches, and prefer higher score.
    const lastNameWord = new RegExp(`\\b${lastNameNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const firstNameWord = firstNameNorm
      ? new RegExp(`\\b${firstNameNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      : null;
    // Card-number prefix hint: when the caller provided the "wrong" number
    // they originally tried (e.g. "T88-80" for the real card "T88-82"),
    // extract its non-numeric prefix and strongly prefer rows whose
    // cardNumberRaw shares that prefix. A shared prefix like "T88-" is a
    // nearly unambiguous set-identity signal — the user wanted the T88
    // insert and just got the number wrong by a digit. Without this hint,
    // players with multiple cards in the same set (base + insert + highlights)
    // tie on name score and we refuse to auto-pick.
    //
    // Prefix extraction: leading non-digit chars up to and including any
    // trailing dash or dot. "T88-80" → "T88-", "US239" → "US", "1" → ""
    // (purely numeric numbers have no distinguishing prefix). We only apply
    // the boost when the extracted prefix is at least 1 character AND at
    // least one character is alphabetic (so "99" doesn't become a prefix
    // boost for any row starting with "99").
    const extractPrefix = (raw: string): string => {
      const m = raw.trim().match(/^[^0-9]+[-.]?/);
      if (!m) return '';
      const pref = m[0];
      return /[a-zA-Z]/.test(pref) ? pref.toLowerCase() : '';
    };
    const hintPrefix = cardNumberHint ? extractPrefix(cardNumberHint) : '';
    if (hintPrefix) {
      console.log(`[CardDB] Player-anchored: card-number hint="${cardNumberHint}" → prefix="${hintPrefix}" (will boost matching rows by +50)`);
    }

    const scoreRow = (row: typeof cardDatabase.$inferSelect): number => {
      const name = (row.playerName || '').toLowerCase();
      let s = 0;
      if (lastNameWord.test(name)) s += 10;
      if (firstNameWord && firstNameWord.test(name)) s += 20;
      // +50 when the row's card number shares the hint's alphanumeric prefix.
      // Dominates name score so a T88-series insert wins over a base-set row
      // with the same player, but only when the hint provided a usable prefix.
      if (hintPrefix) {
        const rowPrefix = extractPrefix(row.cardNumberRaw || '');
        if (rowPrefix && rowPrefix === hintPrefix) {
          s += 50;
        }
      }
      return s;
    };
    // Keep only rows that actually have the last name as a whole word —
    // LIKE '%ritter%' also matches "Ritterbach", which would poison the
    // uniqueness check below. Whole-word match eliminates that class of
    // false positive.
    const strictRows = allRows.filter(r => lastNameWord.test(r.playerName || ''));
    if (strictRows.length === 0) {
      console.log(`[CardDB] Player-anchored fallback: no whole-word last-name matches (substring-only — too weak to auto-correct)`);
      return { found: false, source: 'ocr_fallback' };
    }

    // Optional collection narrow: if caller provided a collection, prefer
    // rows where collection OR set contains that token (case-insensitive).
    // Only narrows the candidate pool when it leaves ≥1 row standing; if
    // the collection filter would zero out the pool, fall back to the
    // un-narrowed set so the extractor still has a shot at uniqueness.
    let candidates = strictRows;
    if (collection && collection.trim().length > 0) {
      const collNorm = collection.trim().toLowerCase();
      const narrowed = strictRows.filter(r =>
        (r.collection || '').toLowerCase().includes(collNorm) ||
        (r.set || '').toLowerCase().includes(collNorm)
      );
      if (narrowed.length > 0) {
        console.log(`[CardDB] Player-anchored: collection="${collection}" narrowed ${strictRows.length} → ${narrowed.length} candidate(s)`);
        candidates = narrowed;
      } else {
        console.log(`[CardDB] Player-anchored: collection="${collection}" would zero out ${strictRows.length} candidates — ignoring filter`);
      }
    }

    // Score and sort.
    const scored = candidates
      .map(r => ({ row: r, score: scoreRow(r) }))
      .sort((a, b) => b.score - a.score);

    // Unique-row rule: auto-correct only when a SINGLE row stands alone at
    // the top. If the best score is tied across multiple rows, we refuse —
    // the player has multiple cards in this set and we don't know which
    // one was scanned from the image alone.
    const bestScore = scored[0].score;
    const tied = scored.filter(s => s.score === bestScore);
    if (tied.length > 1) {
      console.log(`[CardDB] Player-anchored fallback: ${tied.length} rows tied at score=${bestScore} — refusing to auto-pick to avoid guessing wrong card. Tied card #s: [${tied.map(t => t.row.cardNumberRaw).join(', ')}]`);
      return { found: false, source: 'ocr_fallback' };
    }

    const cardRow = tied[0].row;
    console.log(`[CardDB] Player-anchored fallback HIT: ${cardRow.playerName} — ${cardRow.brand} ${cardRow.year} #${cardRow.cardNumberRaw} (collection="${cardRow.collection}", set="${cardRow.set || ''}"). Auto-correcting card number from OCR read.`);

    const { firstName, lastName } = splitPlayerName(cardRow.playerName);
    const isRookieCard = !!(cardRow.rookieFlag && cardRow.rookieFlag.toLowerCase().includes('rookie'));

    // Look up variation the same way the main lookup does so the caller
    // still gets the parallel/serial context when available.
    const variationResult = await lookupVariation({
      brandId: cardRow.brandId,
      year: cardRow.year,
      collection: cardRow.collection,
      set: cardRow.set || undefined,
      serialNumber: undefined,
    });

    return {
      found: true,
      playerFirstName: firstName,
      playerLastName: lastName,
      team: cardRow.team || undefined,
      collection: cardRow.collection,
      set: cardRow.set || variationResult.picked?.set || undefined,
      cardNumber: cardRow.cardNumberRaw,
      variation: variationResult.picked?.variationOrParallel,
      variationOptions: variationResult.options,
      variationAmbiguous: variationResult.ambiguous,
      serialNumber: variationResult.picked?.serialNumber || undefined,
      isRookieCard,
      brand: cardRow.brand,
      year: cardRow.year,
      cmpNumber: cardRow.cmpNumber || undefined,
      source: 'card_database',
    };
  } catch (err: any) {
    console.error('[CardDB] Player-anchored lookup error:', err.message);
    return { found: false, source: 'ocr_fallback' };
  }
}

// ---------------------------------------------------------------------------
// Voice-lookup enrichment (H-5)
// ---------------------------------------------------------------------------

export interface VoiceEnrichInput {
  brand: string | null;
  year: number | null;
  collection: string | null;
  cardNumber: string | null;
  playerFirstName: string | null;
  playerLastName: string | null;
  serialNumber: string | null;
  /** Free-form parallel/variant description the speaker provided, used as a
   *  hint when resolving the variation row. Optional. */
  parallelHint?: string | null;
}

export interface VoiceEnrichResult {
  /** The CardLookupResult that matched. `found` is always true when returned. */
  hit: CardLookupResult;
  /** Which fallback chain produced the hit. Informational for logs/UI. */
  source: 'direct' | 'year-widen' | 'player-anchored';
}

/**
 * Voice-flow CardDB enrichment (H-5).
 *
 * Mirrors the image-scan CardDB lookup ladder used inside dualSideOCR.ts:
 *   1. Direct lookup on (brand, year, cardNumber)
 *   2. ±1-year fallback with requireNameMatch against the spoken surname
 *   3. Player-anchored fallback on (brand, year, lastName) when the spoken
 *      card number turns out to be wrong (e.g. user said a jersey number or
 *      misspoke). Only auto-picks when a single row uniquely matches.
 *
 * Returns null when all three paths miss; the caller keeps the voice-provided
 * fields as-is. Never throws — this is purely enrichment.
 */
export async function enrichVoiceFields(
  input: VoiceEnrichInput,
): Promise<VoiceEnrichResult | null> {
  const { brand, year, collection, cardNumber, playerLastName, playerFirstName, serialNumber, parallelHint } = input;

  // Gate: need at least brand + year + (cardNumber OR last name) to make any
  // lookup meaningful. Below that the search would be unbounded.
  if (!brand || !year || (!cardNumber && !playerLastName)) {
    return null;
  }

  try {
    // ─── 1. Direct lookup ─────────────────────────────────────────────
    if (cardNumber) {
      const direct = await lookupCard({
        brand,
        year,
        cardNumber,
        collection: collection || undefined,
        playerLastName: playerLastName || undefined,
        serialNumber: serialNumber || undefined,
        ocrText: parallelHint || undefined,
      });
      if (direct.found) {
        return { hit: direct, source: 'direct' };
      }
    }

    // ─── 2. ±1-year widening (name-match guarded) ───────────────────────────
    // Speakers occasionally fumble the year ("twenty twenty five" vs
    // "twenty twenty six"). Widen by ±1 and require the surname to agree
    // — otherwise a base-set card number hits a different player in the
    // adjacent year and corrupts everything.
    if (cardNumber && playerLastName) {
      for (const delta of [1, -1]) {
        const yr = year + delta;
        const widened = await lookupCard({
          brand,
          year: yr,
          cardNumber,
          collection: collection || undefined,
          playerLastName,
          serialNumber: serialNumber || undefined,
          ocrText: parallelHint || undefined,
        });
        if (widened.found) {
          const dbLast = (widened.playerLastName || '').trim().toLowerCase();
          const spokenLast = playerLastName.trim().toLowerCase();
          const lastMatch =
            !!dbLast && !!spokenLast &&
            (dbLast === spokenLast || dbLast.startsWith(spokenLast) || spokenLast.startsWith(dbLast));
          if (lastMatch) {
            console.log(`[VoiceCardDB] ±1 year widen hit at year=${yr}`);
            return { hit: widened, source: 'year-widen' };
          }
        }
      }
    }

    // ─── 3. Player-anchored fallback (H-3 for voice) ────────────────────────
    // Speaker gave a wrong card number (read a jersey number, misheard, etc.)
    // Search by (brand, year, lastName) and auto-correct the card number
    // when a single row uniquely matches.
    if (playerLastName) {
      const anchored = await lookupCardByPlayer({
        brand,
        year,
        playerLastName,
        playerFirstName: playerFirstName || undefined,
        collection: collection || undefined,
        cardNumberHint: cardNumber || undefined,
      });
      if (anchored.found) {
        console.log(`[VoiceCardDB] player-anchored fallback hit — corrected cardNumber="${anchored.cardNumber}"`);
        return { hit: anchored, source: 'player-anchored' };
      }
    }

    return null;
  } catch (err: any) {
    console.warn('[VoiceCardDB] enrichment error (non-fatal):', err.message);
    return null;
  }
}

/**
 * Find variation record(s) matching the given context.
 *
 * Rule:
 *   - If a serial number was detected on the card, restrict to DB rows whose
 *     serial-limit matches.
 *   - If no serial number was detected, restrict to DB rows where serial_number
 *     is NULL/blank (the un-numbered base/finish row).
 *   - Of the resulting candidates:
 *       0 → no variation.
 *       1 → auto-pick.
 *       n → try `parallelHint` (token overlap) to pick one. If still
 *           ambiguous, return all options for the user to confirm.
 */
type VariationLookupResult = {
  picked: typeof cardVariations.$inferSelect | null;
  options?: string[];
  ambiguous?: boolean;
};

async function lookupVariation(params: {
  brandId: string;
  year: number;
  collection: string;
  set?: string;
  serialNumber?: string;
  parallelHint?: string;
}): Promise<VariationLookupResult> {
  const { brandId, year, collection, set, serialNumber, parallelHint } = params;

  // Build WHERE conditions — always filter by brand + year + collection.
  // Also filter by set when available to prevent cross-product contamination
  // (e.g. "Base Set /399" matching Chrome Update Magenta Refractors instead of
  // Series Two Yellow Rainbow Foil when both share the same collection name).
  const conditions = [
    eq(cardVariations.brandId, brandId),
    eq(cardVariations.year, year),
    sql`lower(${cardVariations.collection}) = lower(${collection})`,
  ];
  if (set) {
    conditions.push(sql`lower(${cardVariations.set}) = lower(${set})`);
  }

  const rows = await db
    .select()
    .from(cardVariations)
    .where(and(...conditions))
    .limit(200);

  if (rows.length === 0) {
    console.log('[CardDB] No variation rows for brand/year/collection/set');
    return { picked: null };
  }

  // ── Step 1: filter to candidates that match the serial-number rule ──
  let candidates: typeof rows;
  const isBlank = (s: string | null | undefined) =>
    !s || !s.trim() || /^(none|n\/a|not\s*serialized|unnumbered)$/i.test(s.trim());

  if (serialNumber) {
    const ocrLimit = extractSerialLimit(serialNumber);
    if (!ocrLimit) {
      console.log(`[CardDB] Serial "${serialNumber}" detected but unparseable — no variation`);
      return { picked: null };
    }
    candidates = rows.filter(r => {
      if (isBlank(r.serialNumber)) return false;
      return extractSerialLimit(r.serialNumber!) === ocrLimit;
    });
    console.log(`[CardDB] Serial /${ocrLimit} → ${candidates.length} candidate variation(s)`);
  } else {
    candidates = rows.filter(r => isBlank(r.serialNumber));
    console.log(`[CardDB] No serial detected → ${candidates.length} NULL-serial variation(s)`);
  }

  if (candidates.length === 0) return { picked: null };

  const optionNames = Array.from(
    new Set(candidates.map(c => c.variationOrParallel).filter(Boolean) as string[])
  );

  // ── Step 2: pick from candidates ──
  // Serial-detected case: the serial number itself is positive evidence the
  // card is one of these parallels, so a single candidate auto-picks.
  // No-serial case: card_variations only catalogs parallels (it has no
  // explicit "base" rows for most collections), so a NULL-serial entry like
  // "1987 Topps Blue" is itself an un-numbered parallel — NOT the base
  // finish. Without positive evidence (a parallel hint matching the
  // candidate's name), we must NOT auto-apply it; the card is treated as
  // base and the candidates are surfaced as options for user confirmation.
  if (serialNumber) {
    if (candidates.length === 1) {
      console.log(`[CardDB] Variation auto-picked by serial: "${candidates[0].variationOrParallel}"`);
      return { picked: candidates[0] };
    }
    // multiple serial-matched candidates — try the hint
    if (parallelHint && parallelHint.trim()) {
      const picked = pickByHint(candidates, parallelHint);
      if (picked) {
        console.log(`[CardDB] Variation picked via hint "${parallelHint}": "${picked.variationOrParallel}"`);
        return { picked, options: optionNames };
      }
    }
    console.log(
      `[CardDB] Ambiguous serial-matched variation (${candidates.length}) — needs user confirmation: ${optionNames.join(' | ')}`
    );
    return { picked: null, options: optionNames, ambiguous: true };
  }

  // No serial detected — require positive parallel-hint evidence to apply
  // any NULL-serial candidate. Without a confident hint match, default to
  // base (no variation) and surface the options for the user to confirm.
  if (parallelHint && parallelHint.trim()) {
    const picked = pickByHint(candidates, parallelHint);
    if (picked) {
      console.log(`[CardDB] NULL-serial variation picked via hint "${parallelHint}": "${picked.variationOrParallel}"`);
      return { picked, options: optionNames };
    }
  }
  console.log(
    `[CardDB] No serial + no matching parallel hint → defaulting to base. NULL-serial parallel options exist (${candidates.length}): ${optionNames.join(' | ')}`
  );
  return { picked: null, options: optionNames, ambiguous: true };
}

/**
 * Pick one candidate whose `variationOrParallel` overlaps best with the hint.
 * Generic token-overlap: the hint and each candidate name are reduced to
 * lowercase alphanumeric word tokens; the candidate with the most overlapping
 * tokens wins, but only if it strictly beats the runner-up.
 */
function pickByHint(
  candidates: Array<typeof cardVariations.$inferSelect>,
  hint: string,
): typeof cardVariations.$inferSelect | null {
  const tok = (s: string) =>
    new Set(
      s.toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 3),
    );
  const hintTokens = tok(hint);
  if (hintTokens.size === 0) return null;

  const scored = candidates.map(c => {
    const ct = tok(c.variationOrParallel || '');
    let overlap = 0;
    hintTokens.forEach(t => { if (ct.has(t)) overlap++; });
    return { c, overlap };
  });
  scored.sort((a, b) => b.overlap - a.overlap);
  if (scored[0].overlap === 0) return null;
  if (scored.length > 1 && scored[0].overlap === scored[1].overlap) return null;
  return scored[0].c;
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

/**
 * List every distinct `variation_or_parallel` name in card_variations for a
 * given brand+year (optionally narrowed by collection). Used to verify a
 * detector- or model-supplied parallel name against the catalog even when the
 * specific card row was not found in card_database (e.g. the identifier guessed a
 * card # that isn't in our catalog, but we still want to veto a parallel
 * name that doesn't exist for the brand/year).
 *
 * Returns an empty array when no rows exist (caller can decide whether
 * "unknown to catalog" should be treated as veto or as no-info).
 */
export async function getKnownVariationNames(
  brand: string,
  year: number,
  collection?: string,
): Promise<string[]> {
  if (!brand || !year) return [];
  const conditions: any[] = [
    sql`lower(${cardVariations.brand}) = lower(${normalizeBrand(brand)})`,
    eq(cardVariations.year, year),
  ];
  if (collection && collection.trim()) {
    conditions.push(sql`lower(${cardVariations.collection}) = lower(${collection})`);
  }
  const rows = await db
    .select({ name: cardVariations.variationOrParallel })
    .from(cardVariations)
    .where(and(...conditions))
    .limit(500);
  const set = new Set<string>();
  for (const r of rows) {
    if (r.name && r.name.trim()) set.add(r.name.trim());
  }
  return Array.from(set);
}

function normalizeBrand(brand: string): string {
  return brand.trim().replace(/\s+/g, ' ');
}

function normalizeCardNumber(num: string): string {
  return num.trim().replace(/^#/, '');
}

/**
 * For autograph / insert card numbers in LL-LL form (e.g. "RA-JE",
 * "EZA-JHT", "BDC-12"), OCR often reads them with different separators
 * depending on kerning and foil: "RA-JE", "RA JE", "RAJE", "RA.JE".
 * Return every equivalent form so the lookup can try each. When the input
 * does not contain a separator-joined alphanumeric pair, returns [input].
 */
function cardNumberVariants(raw: string): string[] {
  const norm = raw.trim();
  if (!norm) return [];
  // Extract letter/digit groups separated by [- . _ space]
  const groups = norm.split(/[\s\-._\u2013\u2014]+/).filter(Boolean);
  if (groups.length < 2) return [norm];
  // Only loosen when at least one group is letters-only (the autograph /
  // insert pattern). Purely-numeric card numbers like "12-34" are real and
  // shouldn't be collapsed.
  const hasLetters = groups.some(g => /^[A-Za-z]+$/.test(g));
  if (!hasLetters) return [norm];
  const variants = new Set<string>();
  variants.add(norm);
  variants.add(groups.join('-'));
  variants.add(groups.join(' '));
  variants.add(groups.join(''));
  return Array.from(variants);
}

function normalizeSerial(raw: string): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'none detected' || lower === 'not serialized' || lower === 'n/a' || lower === '') return null;
  // Keep values like "/499", "1 of 1", "/1"
  return raw.trim();
}

function extractSerialLimit(serial: string): number | null {
  const m = serial.match(/\/(\d+)/);
  if (m) return parseInt(m[1], 10);
  const m2 = serial.match(/^(\d+)\s+of\s+1$/i);
  if (m2) return 1;
  return null;
}

// Strip trailing jersey/uniform numbers that sometimes appear in OCR or CSV data
// e.g. "José Buttó 6" → "José Buttó", "Trout (6)" → "Trout"
function stripTrailingNumber(s: string): string {
  return s
    .replace(/\s*\(#?\d+\)\s*$/, '') // "(6)" or "(#6)"
    .replace(/\s+#?\d+\s*$/, '')      // " 6" or " #6"
    .trim();
}

function splitPlayerName(fullName: string): { firstName: string; lastName: string } {
  const parts = stripTrailingNumber(fullName.trim()).split(/\s+/);
  if (parts.length === 1) return { firstName: '', lastName: parts[0] };
  if (parts.length === 2) return { firstName: parts[0], lastName: parts[1] };
  // 3+ word name: first word is first name, rest is last name
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// ───────────────────────────────────────────────
// Auto-seed on startup
// ───────────────────────────────────────────────

/**
 * Called at server startup. If the card_database table is empty AND the
 * bundled CSV files are present, imports them automatically.
 * Runs in the background — never delays server readiness.
 */
export async function autoSeedCardDatabaseIfEmpty(): Promise<void> {
  try {
    const [{ count: cardCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(cardDatabase);

    if (cardCount > 0) {
      console.log(`[CardDB] Auto-seed skipped — ${cardCount} cards already in database`);
      return;
    }

    console.log('[CardDB] Database is empty — starting auto-seed from bundled CSV files...');

    let cardsLoaded = 0;
    let variationsLoaded = 0;

    if (existsSync(CARDS_CSV)) {
      const buf = readFileSync(CARDS_CSV);
      const result = await importCardsCSV(buf);
      cardsLoaded = result.imported;
      if (result.errors.length > 0) {
        console.warn(`[CardDB] Cards CSV had ${result.errors.length} skipped rows`);
      }
    } else {
      console.warn('[CardDB] Cards CSV not found at:', CARDS_CSV);
    }

    if (existsSync(VARS_CSV)) {
      const buf = readFileSync(VARS_CSV);
      const result = await importVariationsCSV(buf);
      variationsLoaded = result.imported;
      if (result.errors.length > 0) {
        console.warn(`[CardDB] Variations CSV had ${result.errors.length} skipped rows`);
      }
    } else {
      console.warn('[CardDB] Variations CSV not found at:', VARS_CSV);
    }

    console.log(`[CardDB] Auto-seed complete: ${cardsLoaded} cards, ${variationsLoaded} variations`);
  } catch (err: any) {
    // Non-fatal — log and continue
    console.error('[CardDB] Auto-seed error (non-fatal):', err.message);
  }
}
