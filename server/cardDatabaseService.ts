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
}

export interface CardLookupResult {
  found: boolean;
  playerFirstName?: string;
  playerLastName?: string;
  team?: string;
  collection?: string;
  variation?: string;
  serialNumber?: string;
  isRookieCard?: boolean;
  brand?: string;
  year?: number;
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
export async function importCardsCSV(csvBuffer: Buffer): Promise<{ imported: number; errors: string[] }> {
  const errors: string[] = [];
  let imported = 0;

  const records = parse(csvBuffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  const BATCH_SIZE = 500;
  let batch: typeof cardDatabase.$inferInsert[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    try {
      await db.insert(cardDatabase).values(batch).onConflictDoNothing();
      imported += batch.length;
    } catch (err: any) {
      errors.push(`Batch insert error: ${err.message}`);
    }
    batch = [];
  };

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const lineNum = i + 2; // 1-indexed, +1 for header

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

    batch.push({
      brandId: brandId || brand.toLowerCase().replace(/\s+/g, '_'),
      brand,
      year,
      collection,
      cardNumberRaw,
      cmpNumber: (row['cmp_number'] || row['Cmp_number'] || '').trim() || null,
      playerName,
      team: (row['team'] || row['Team'] || '').trim() || null,
      rookieFlag: (row['rookie_flag'] || row['Rookie_flag'] || '').trim() || null,
      notes: (row['notes'] || row['Notes'] || '').trim() || null,
    });

    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  return { imported, errors };
}

/**
 * Import variations CSV into card_variations table.
 * Expected columns: brand_id, brand, year, collection, variation_or_parallel,
 *                   serial_number, cmp_number, hobby_odds, jumbo_odds, breaker_odds, value_odds
 */
export async function importVariationsCSV(csvBuffer: Buffer): Promise<{ imported: number; errors: string[] }> {
  const errors: string[] = [];
  let imported = 0;

  const records = parse(csvBuffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  const BATCH_SIZE = 500;
  let batch: typeof cardVariations.$inferInsert[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    try {
      await db.insert(cardVariations).values(batch).onConflictDoNothing();
      imported += batch.length;
    } catch (err: any) {
      errors.push(`Batch insert error: ${err.message}`);
    }
    batch = [];
  };

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

    batch.push({
      brandId: brandId || brand.toLowerCase().replace(/\s+/g, '_'),
      brand,
      year,
      collection,
      variationOrParallel: variation,
      serialNumber: serialNumber || null,
      cmpNumber: (row['cmp_number'] || row['Cmp_number'] || '').trim() || null,
      hobbyOdds: (row['hobby_odds'] || '').trim() || null,
      jumboOdds: (row['jumbo_odds'] || '').trim() || null,
      breakerOdds: (row['breaker_odds'] || '').trim() || null,
      valueOdds: (row['value_odds'] || '').trim() || null,
    });

    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  return { imported, errors };
}

// ───────────────────────────────────────────────
// Card Lookup
// ───────────────────────────────────────────────

/**
 * Look up a card in the database given OCR-detected fields.
 * Returns authoritative card data if found, or { found: false } to signal fallback.
 */
export async function lookupCard(input: CardLookupInput): Promise<CardLookupResult> {
  const { brand, year, collection, cardNumber, serialNumber } = input;

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

    // If collection provided, score and filter by collection similarity
    if (cardRows.length > 1 && collection) {
      const collectionNorm = collection.trim().toLowerCase();
      const scored = cardRows.map(r => {
        const dbCol = r.collection.toLowerCase();
        let score = 0;
        if (dbCol === collectionNorm) score = 100;
        else if (dbCol.includes(collectionNorm) || collectionNorm.includes(dbCol)) score = 50;
        return { row: r, score };
      });
      const best = scored.filter(s => s.score > 0);
      if (best.length > 0) {
        best.sort((a, b) => b.score - a.score);
        cardRows = best.map(s => s.row);
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
      serialNumber,
    });

    return {
      found: true,
      playerFirstName: firstName,
      playerLastName: lastName,
      team: cardRow.team || undefined,
      collection: cardRow.collection,
      variation: variationResult?.variationOrParallel,
      serialNumber: variationResult?.serialNumber || serialNumber,
      isRookieCard,
      brand: cardRow.brand,
      year: cardRow.year,
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
  serialNumber?: string;
}): Promise<typeof cardVariations.$inferSelect | null> {
  const { brandId, year, collection, serialNumber } = params;

  let rows = await db
    .select()
    .from(cardVariations)
    .where(
      and(
        eq(cardVariations.brandId, brandId),
        eq(cardVariations.year, year),
        sql`lower(${cardVariations.collection}) = lower(${collection})`
      )
    )
    .limit(100);

  if (rows.length === 0) return null;

  // If we have a serial number from OCR, try to match it
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

  // Return the base variation (first row without a specific serial, i.e. base parallel)
  const base = rows.find(r =>
    !r.serialNumber ||
    r.serialNumber === 'Not serialized' ||
    r.serialNumber === 'None detected'
  );
  return base || rows[0];
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

function splitPlayerName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
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
