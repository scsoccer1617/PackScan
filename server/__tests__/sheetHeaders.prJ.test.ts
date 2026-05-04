/**
 * Lock the SHEET_HEADERS / buildRow / parseSheetRow lockstep after PR J
 * moved "Potential Variant" from the trailing column (24) to position 11
 * (immediately before "Variant").
 *
 * Run via:
 *   npx tsx server/__tests__/sheetHeaders.prJ.test.ts
 *
 * Repo has no vitest/jest config (the existing vlmApply.coercion test
 * uses the same node:assert pattern). Exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { SHEET_HEADERS, buildRow, parseSheetRow } from '../googleSheets';

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err: any) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(err?.message || err);
  }
}

// ── Header layout ────────────────────────────────────────────────────────

check('SHEET_HEADERS has 25 columns', () => {
  assert.equal(SHEET_HEADERS.length, 25);
});
check('SHEET_HEADERS[11] === "Potential Variant"', () => {
  assert.equal(SHEET_HEADERS[11], 'Potential Variant');
});
check('SHEET_HEADERS[12] === "Variant"', () => {
  assert.equal(SHEET_HEADERS[12], 'Variant');
});
check('Other anchor positions unchanged (Parallel @ 9, Serial # @ 10)', () => {
  assert.equal(SHEET_HEADERS[9], 'Parallel');
  assert.equal(SHEET_HEADERS[10], 'Serial #');
});
check('Average eBay price shifted to 16 (was 15)', () => {
  assert.equal(SHEET_HEADERS[16], 'Average eBay price');
});
check('eBay search URL shifted to 19 (was 18)', () => {
  assert.equal(SHEET_HEADERS[19], 'eBay search URL');
});
check('Cert # is now the trailing column (24)', () => {
  assert.equal(SHEET_HEADERS[24], 'Cert #');
});

// ── buildRow lockstep ────────────────────────────────────────────────────

check('buildRow length matches SHEET_HEADERS length', () => {
  const row = buildRow({});
  assert.equal(row.length, SHEET_HEADERS.length);
});
check('buildRow emits potentialVariant at index 11', () => {
  const row = buildRow({
    potentialVariant: 'Yes',
    variation: 'Refractor',
    player: 'Test Player',
  });
  assert.equal(row[11], 'Yes');
});
check('buildRow emits variation at index 12', () => {
  const row = buildRow({
    potentialVariant: 'Yes',
    variation: 'Refractor',
    player: 'Test Player',
  });
  assert.equal(row[12], 'Refractor');
});
check('buildRow base scan (no potential variant): index 11 is empty string', () => {
  const row = buildRow({ player: 'Test Player' });
  assert.equal(row[11], '');
});
check('buildRow places price at index 16 and graded fields after', () => {
  const row = buildRow({
    averagePrice: 12.34,
    isGraded: true,
    gradingCompany: 'PSA',
    numericalGrade: 10,
    gradeQualifier: '',
    certificationNumber: 'ABC123',
  });
  assert.equal(row[16], 12.34);
  assert.equal(row[20], 'Yes');
  assert.equal(row[21], 'PSA');
  assert.equal(row[22], 10);
  assert.equal(row[24], 'ABC123');
});

// ── parseSheetRow lockstep ───────────────────────────────────────────────
//
// Build a values[] aligned to the new layout and confirm the parser maps
// each cell to the intended field. The fields we care most about are the
// two that swapped (potentialVariant / variant) plus the cascade of
// indices that shifted +1.

function makeValues(): string[] {
  // 25 cells matching the post-PR-J header order. Use distinct,
  // recognizable values so a wrong-index read shows up as a mis-mapped
  // string rather than a coincidental match.
  return [
    '2026-05-04',          // 0  Date scanned
    'Baseball',            // 1  Sport
    'Test Player',         // 2  Player
    '2026',                // 3  Year
    'Topps',               // 4  Brand
    '#100',                // 5  Card #
    'CMP12345',            // 6  CMP code
    'Series One',          // 7  Set
    'Base Set',            // 8  Collection
    'Refractor',           // 9  Parallel
    '12/299',              // 10 Serial #
    'Yes',                 // 11 Potential Variant ← PR J
    'Photo Variation',     // 12 Variant            ← PR J
    'Yes',                 // 13 Rookie
    'No',                  // 14 Auto
    'Yes',                 // 15 Numbered
    '15.50',               // 16 Average eBay price
    'http://front.png',    // 17 Front image link
    'http://back.png',     // 18 Back image link
    'http://ebay.test',    // 19 eBay search URL
    'Yes',                 // 20 Graded
    'PSA',                 // 21 Grading company
    '10',                  // 22 Grade
    'GEM',                 // 23 Grade qualifier
    'CERT-XYZ',            // 24 Cert #
  ];
}

check('parseSheetRow reads potentialVariant from index 11', () => {
  const parsed = parseSheetRow(makeValues(), 2, 'sheet-id-test');
  assert.ok(parsed, 'expected a non-null row');
  assert.equal(parsed!.potentialVariant, 'Yes');
});
check('parseSheetRow reads variant from index 12', () => {
  const parsed = parseSheetRow(makeValues(), 2, 'sheet-id-test');
  assert.equal(parsed!.variant, 'Photo Variation');
});
check('parseSheetRow reads price from shifted index 16', () => {
  const parsed = parseSheetRow(makeValues(), 2, 'sheet-id-test');
  assert.equal(parsed!.estimatedValue, '15.50');
});
check('parseSheetRow reads eBay URL from shifted index 19', () => {
  const parsed = parseSheetRow(makeValues(), 2, 'sheet-id-test');
  assert.equal(parsed!.ebaySearchUrl, 'http://ebay.test');
});
check('parseSheetRow reads graded fields from shifted indices 20–24', () => {
  const parsed = parseSheetRow(makeValues(), 2, 'sheet-id-test');
  assert.equal(parsed!.isGraded, true);
  assert.equal(parsed!.gradingCompany, 'PSA');
  assert.equal(parsed!.numericalGrade, 10);
  assert.equal(parsed!.gradeQualifier, 'GEM');
  assert.equal(parsed!.certificationNumber, 'CERT-XYZ');
});
check('parseSheetRow round-trips a buildRow result for PV + Variant', () => {
  const row = buildRow({
    sport: 'Baseball',
    player: 'Round Trip',
    year: 2026,
    brand: 'Topps',
    cardNumber: '#1',
    set: 'Series One',
    collection: 'Base Set',
    foilType: '',
    serialNumber: '',
    potentialVariant: 'No',
    variation: 'SP',
  });
  const parsed = parseSheetRow(row as unknown[], 2, 'sheet-id-test');
  assert.ok(parsed);
  assert.equal(parsed!.potentialVariant, 'No');
  assert.equal(parsed!.variant, 'SP');
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
