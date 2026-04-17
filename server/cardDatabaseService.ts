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
import { and, eq, sql } from 'drizzle-orm';
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
   * Raw OCR text from front and/or back of the card. Used as a generic
   * tiebreaker when multiple DB rows share the same brand+year+cardNumber:
   * if exactly one candidate row's collection or set name appears verbatim
   * in this text, that row is preferred. This lets us discover any subset
   * label printed on the card (e.g. "FUTURE STARS") without maintaining a
   * hand-curated list of subset names — the DB itself is the vocabulary.
   */
  ocrText?: string;
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
export async function lookupCard(input: CardLookupInput): Promise<CardLookupResult> {
  const { brand, year, collection, cardNumber, serialNumber, playerLastName, ocrText } = input;

  if (!brand || !year || !cardNumber) {
    return { found: false, source: 'ocr_fallback' };
  }

  try {
    // Normalize brand for fuzzy matching
    const brandNorm = normalizeBrand(brand);
    const cardNumNorm = normalizeCardNumber(cardNumber);

    // ── Step 1: Find the card in card_database ──────────────────────────
    // Match on brand (fuzzy), year, and card number. Collection is optional
    // since OCR sometimes misreads or misses collection names.

    let cardRows = await db
      .select()
      .from(cardDatabase)
      .where(
        and(
          sql`lower(${cardDatabase.brand}) = lower(${brandNorm})`,
          eq(cardDatabase.year, year),
          sql`lower(${cardDatabase.cardNumberRaw}) = lower(${cardNumNorm})`
        )
      )
      .limit(200);

    // ── Step 1a: Off-by-one year fallback (vintage copyright convention) ──
    // Vintage Topps/Fleer/Donruss cards (pre-1987) were printed with the previous
    // year's copyright (e.g. a 1979 Topps card has "© 1978" on the back, with stats
    // ending in 1978). Collectors catalog these by release year (1979), so OCR of
    // the back often yields copyright_year = release_year - 1. If we didn't find
    // a match, try year+1 before falling back.
    if (cardRows.length === 0 && year >= 1900 && year < 1990) {
      const bumpedRows = await db
        .select()
        .from(cardDatabase)
        .where(
          and(
            sql`lower(${cardDatabase.brand}) = lower(${brandNorm})`,
            eq(cardDatabase.year, year + 1),
            sql`lower(${cardDatabase.cardNumberRaw}) = lower(${cardNumNorm})`
          )
        )
        .limit(10);
      if (bumpedRows.length > 0) {
        console.log(`[CardDB] Off-by-one year fallback: no match for ${year} ${brandNorm} #${cardNumNorm}; found ${bumpedRows.length} match(es) at year ${year + 1} (copyright→release year convention)`);
        cardRows = bumpedRows;
      }
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

    // When still multiple hits, use the OCR player name to pick the best match.
    // The same card number often maps to different players across sets (e.g.
    // Bowman 2022 #91 = Scherzer in "Bowman Baseball", Turner in "Bowman Chrome Sapphire").
    if (cardRows.length > 1) {
      const lastNameNorm = (playerLastName || '').trim().toLowerCase();
      // Subsets that require an explicit OCR signal (autograph/swatch/relic visible).
      // Without such a signal, these should never be the default match.
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
      const brandLower = (brandNorm || '').toLowerCase().trim();

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
      const ocrTextNorm = normalizeOrdinals((ocrText || '').toLowerCase());
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
      // Pre-compute scores so we can log which row(s) won on OCR evidence.
      if (ocrTextNorm) {
        const scored = cardRows.map(r => ({ row: r, score: ocrMatchScore(r) }));
        const maxScore = Math.max(...scored.map(s => s.score));
        if (maxScore > 0) {
          const winners = scored.filter(s => s.score === maxScore).map(s => `"${s.row.collection}"${s.row.set ? ` / "${s.row.set}"` : ''}`);
          console.log(`[CardDB] OCR-text vocabulary match: top score=${maxScore}, ${winners.length} row(s) tied → ${winners.slice(0, 3).join(', ')}${winners.length > 3 ? ` (+${winners.length - 3} more)` : ''}`);
        }
      }

      cardRows.sort((a, b) => {
        // Primary: player name match (OCR is authoritative for who is on the card)
        const aNameMatch = lastNameNorm && a.playerName.toLowerCase().includes(lastNameNorm) ? 1 : 0;
        const bNameMatch = lastNameNorm && b.playerName.toLowerCase().includes(lastNameNorm) ? 1 : 0;
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
      if (lastNameNorm) {
        console.log(`[CardDB] Multiple matches (${cardRows.length}) — sorted by player name "${lastNameNorm}": top pick "${cardRows[0].playerName}" (${cardRows[0].set || cardRows[0].collection})`);
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

      if (prefixRows.length > 0) {
        console.log(`[CardDB] Prefix match found ${prefixRows.length} candidate(s) for "${cardNumNorm}"`);
        // Score each candidate: boost rows whose player name contains the OCR player last name
        const lastNameNorm = (playerLastName || '').trim().toLowerCase();
        const scored = prefixRows.map(r => {
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
    });

    // Resolve set: prefer card_database.set, fall back to variation row's set
    const resolvedSet = cardRow.set || variationResult?.set || undefined;

    return {
      found: true,
      playerFirstName: firstName,
      playerLastName: lastName,
      team: cardRow.team || undefined,
      collection: cardRow.collection,
      set: resolvedSet || undefined,
      cardNumber: cardRow.cardNumberRaw,
      variation: variationResult?.variationOrParallel,
      serialNumber: variationResult?.serialNumber || serialNumber,
      isRookieCard,
      brand: cardRow.brand,
      year: cardRow.year,
      cmpNumber: cardRow.cmpNumber || undefined,
      source: 'card_database',
    };

  } catch (err: any) {
    console.error('[CardDB] Lookup error:', err.message);
    return { found: false, source: 'ocr_fallback' };
  }
}

/**
 * Find a variation record matching the given context + serial number.
 */
async function lookupVariation(params: {
  brandId: string;
  year: number;
  collection: string;
  set?: string;
  serialNumber?: string;
}): Promise<typeof cardVariations.$inferSelect | null> {
  const { brandId, year, collection, set, serialNumber } = params;

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

  let rows = await db
    .select()
    .from(cardVariations)
    .where(and(...conditions))
    .limit(100);

  if (rows.length === 0) return null;

  // Only return a variation when we have a serial number from OCR that matches.
  // Never assign a numbered parallel to a base card that has no serial number detected.
  if (serialNumber) {
    const ocrLimit = extractSerialLimit(serialNumber);
    if (ocrLimit) {
      const matched = rows.filter(r => {
        if (!r.serialNumber) return false;
        const dbLimit = extractSerialLimit(r.serialNumber);
        return dbLimit === ocrLimit;
      });
      if (matched.length > 0) {
        console.log(`[CardDB] Variation matched by serial /${ocrLimit}: ${matched[0].variationOrParallel}`);
        return matched[0];
      }
    }
  }

  // No serial number detected — do not infer a parallel/variation from the DB.
  // The card is a base card or we don't have enough information to assign a variant.
  console.log('[CardDB] No serial number detected — skipping variation assignment');
  return null;
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

function normalizeBrand(brand: string): string {
  return brand.trim().replace(/\s+/g, ' ');
}

function normalizeCardNumber(num: string): string {
  return num.trim().replace(/^#/, '');
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
