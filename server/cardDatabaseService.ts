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
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

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
export async function importCardsCSV(csvBuffer: Buffer): Promise<{ imported: number; replaced: number; errors: string[] }> {
  const errors: string[] = [];
  let imported = 0;
  let replaced = 0;

  const records = parse(csvBuffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  // Pass 1: parse all valid rows and collect which brand+year combos are present
  const rows: typeof cardDatabase.$inferInsert[] = [];
  const brandYearCombos = new Set<string>();

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const lineNum = i + 2;

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
    brandYearCombos.add(`${resolvedBrandId}|${year}`);
    rows.push({
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
  }

  // Pass 2: delete existing rows for every brand+year found in the file so we never duplicate
  for (const combo of brandYearCombos) {
    const [bId, yr] = combo.split('|');
    const deleted = await db.delete(cardDatabase)
      .where(and(eq(cardDatabase.brandId, bId), eq(cardDatabase.year, parseInt(yr))))
      .returning({ id: cardDatabase.id });
    replaced += deleted.length;
  }
  if (replaced > 0) console.log(`[CardDB] Removed ${replaced} existing card rows before re-import`);

  // Pass 3: insert all fresh rows in batches
  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    try {
      await db.insert(cardDatabase).values(batch);
      imported += batch.length;
    } catch (err: any) {
      errors.push(`Batch insert error: ${err.message}`);
    }
  }

  return { imported, replaced, errors };
}

/**
 * Import variations CSV into card_variations table.
 * Expected columns: brand_id, brand, year, collection, variation_or_parallel,
 *                   serial_number, cmp_number, hobby_odds, jumbo_odds, breaker_odds, value_odds
 */
export async function importVariationsCSV(csvBuffer: Buffer): Promise<{ imported: number; replaced: number; errors: string[] }> {
  const errors: string[] = [];
  let imported = 0;
  let replaced = 0;

  const records = parse(csvBuffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  // Pass 1: parse all valid rows and collect which brand+year combos are present
  const rows: typeof cardVariations.$inferInsert[] = [];
  const brandYearCombos = new Set<string>();

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const lineNum = i + 2;

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
    brandYearCombos.add(`${resolvedBrandId}|${year}`);
    rows.push({
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
  }

  // Pass 2: delete existing rows for every brand+year found in the file so we never duplicate
  for (const combo of brandYearCombos) {
    const [bId, yr] = combo.split('|');
    const deleted = await db.delete(cardVariations)
      .where(and(eq(cardVariations.brandId, bId), eq(cardVariations.year, parseInt(yr))))
      .returning({ id: cardVariations.id });
    replaced += deleted.length;
  }
  if (replaced > 0) console.log(`[CardDB] Removed ${replaced} existing variation rows before re-import`);

  // Pass 3: insert all fresh rows in batches
  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    try {
      await db.insert(cardVariations).values(batch);
      imported += batch.length;
    } catch (err: any) {
      errors.push(`Batch insert error: ${err.message}`);
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
  const { brand, year, collection, cardNumber, serialNumber, playerLastName } = input;

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
      .limit(10);

    // If collection provided, score and filter by collection + set similarity.
    // The OCR text from the back of a card (e.g. "SERIES TWO", "SAPPHIRE") often
    // maps directly to the DB `set` column rather than `collection`. Scoring both
    // columns and taking the max ensures e.g. "SERIES TWO" correctly prefers
    // "Series Two" over "Topps Chrome Sapphire" rows.
    if (cardRows.length > 1 && collection) {
      // Normalize ordinal words to digits so "Series Two" == "Series 2" etc.
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

      const collectionNorm = normalizeOrdinals(collection.trim().toLowerCase());

      const matchScore = (dbStr: string): number => {
        const norm = normalizeOrdinals(dbStr.toLowerCase());
        if (norm === collectionNorm) return 100;
        if (norm.includes(collectionNorm) || collectionNorm.includes(norm)) return 50;
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

    // When still multiple hits, prefer simpler/shorter collections (base sets over variations/inserts)
    if (cardRows.length > 1) {
      cardRows.sort((a, b) => {
        // Penalize rows that look like variation/insert sets (contain " - " or have long names)
        const aIsBase = !a.collection.includes(' - ') ? 0 : 1;
        const bIsBase = !b.collection.includes(' - ') ? 0 : 1;
        if (aIsBase !== bIsBase) return aIsBase - bIsBase;
        return a.collection.length - b.collection.length;
      });
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
