/**
 * Seed script: imports card_database and card_variations tables from CSV files.
 * Run with: npx tsx db/seedCardDatabase.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'csv-parse/sync';
import { db } from './index';
import { cardDatabase, cardVariations } from '../shared/schema';
import { sql } from 'drizzle-orm';

const CARDS_CSV    = resolve('attached_assets/Baseball_Card_Database_-_baseball_cards_(5)_1775393864176.csv');
const VARS_CSV     = resolve('attached_assets/Baseball_Card_Database_-_baseball_card_variations_(3)_1775393870208.csv');
const BATCH_SIZE   = 500;

function normalizeSerial(raw: string): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'none detected' || lower === 'not serialized' || lower === 'n/a') return null;
  return raw.trim();
}

async function seedCards() {
  const buf = readFileSync(CARDS_CSV);
  const records = parse(buf, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true }) as Record<string, string>[];

  console.log(`Importing ${records.length} card rows...`);
  let imported = 0;
  let skipped = 0;
  let batch: typeof cardDatabase.$inferInsert[] = [];

  const flush = async () => {
    if (!batch.length) return;
    await db.insert(cardDatabase).values(batch).onConflictDoNothing();
    imported += batch.length;
    batch = [];
  };

  for (const row of records) {
    const brand        = (row['brand'] || '').trim();
    const brandId      = (row['brand_id'] || brand.toLowerCase().replace(/\s+/g, '_')).trim();
    const yearStr      = (row['year'] || '').trim();
    const collection   = (row['collection'] || '').trim();
    const cardNumRaw   = (row['card_number_raw'] || '').trim();
    const playerName   = (row['player_name'] || '').trim();

    if (!brand || !yearStr || !collection || !cardNumRaw || !playerName) { skipped++; continue; }
    const year = parseInt(yearStr, 10);
    if (isNaN(year)) { skipped++; continue; }

    batch.push({
      brandId,
      brand,
      year,
      collection,
      cardNumberRaw: cardNumRaw,
      cmpNumber:    (row['cmp_number'] || '').trim() || null,
      playerName,
      team:         (row['team'] || '').trim() || null,
      rookieFlag:   (row['rookie_flag'] || '').trim() || null,
      notes:        (row['notes'] || '').trim() || null,
    });

    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  console.log(`Cards: imported=${imported} skipped=${skipped}`);
}

async function seedVariations() {
  const buf = readFileSync(VARS_CSV);
  const records = parse(buf, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true }) as Record<string, string>[];

  console.log(`Importing ${records.length} variation rows...`);
  let imported = 0;
  let skipped = 0;
  let batch: typeof cardVariations.$inferInsert[] = [];

  const flush = async () => {
    if (!batch.length) return;
    await db.insert(cardVariations).values(batch).onConflictDoNothing();
    imported += batch.length;
    batch = [];
  };

  for (const row of records) {
    const brand       = (row['brand'] || '').trim();
    const brandId     = (row['brand_id'] || brand.toLowerCase().replace(/\s+/g, '_')).trim();
    const yearStr     = (row['year'] || '').trim();
    const collection  = (row['collection'] || '').trim();
    const variation   = (row['variation_or_parallel'] || '').trim();

    if (!brand || !yearStr || !collection || !variation) { skipped++; continue; }
    const year = parseInt(yearStr, 10);
    if (isNaN(year)) { skipped++; continue; }

    const rawSerial  = (row['serial_number'] || '').trim();
    const serialNum  = normalizeSerial(rawSerial);

    batch.push({
      brandId,
      brand,
      year,
      collection,
      variationOrParallel: variation,
      serialNumber:  serialNum || null,
      cmpNumber:     (row['cmp_number'] || '').trim() || null,
      hobbyOdds:     (row['hobby_odds'] || '').trim() || null,
      jumboOdds:     (row['jumbo_odds'] || '').trim() || null,
      breakerOdds:   (row['breaker_odds'] || '').trim() || null,
      valueOdds:     (row['value_odds'] || '').trim() || null,
    });

    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  console.log(`Variations: imported=${imported} skipped=${skipped}`);
}

async function main() {
  const [{ count: cCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(cardDatabase);
  const [{ count: vCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(cardVariations);
  console.log(`Current DB state: cards=${cCount}, variations=${vCount}`);

  if (cCount > 0 || vCount > 0) {
    console.log('Tables already populated — skipping seed (use /api/card-database/clear to reset first).');
    process.exit(0);
  }

  await seedCards();
  await seedVariations();
  console.log('Done!');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
