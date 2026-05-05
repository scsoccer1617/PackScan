/**
 * PR X — unit tests for the eBay-only set/year normalization helper.
 *
 * Run with:
 *
 *   npx tsx server/__tests__/ebaySetNormalize.test.ts
 *
 * Covers:
 *  - normalizeSetForEbay: surgical "Series Two/One" → "Series 2/1"
 *    rewrite, leaves all other set strings untouched.
 *  - formatYearForEbay: emits YYYY-YY for season sports + printed
 *    ranges, falls through to integer year otherwise.
 *  - formatYearForSheet: same logic but never returns empty when the
 *    input parses (Sheet Year column is read by humans).
 */

import assert from 'node:assert/strict';
import {
  normalizeSetForEbay,
  formatYearForEbay,
  formatYearForSheet,
} from '../ebaySetNormalize';

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(err?.message ?? err);
  }
}

// ── normalizeSetForEbay ────────────────────────────────────────────────

check('normalizeSetForEbay: "Series Two" → "Series 2"', () => {
  assert.equal(normalizeSetForEbay('Series Two'), 'Series 2');
});

check('normalizeSetForEbay: "Series One" → "Series 1"', () => {
  assert.equal(normalizeSetForEbay('Series One'), 'Series 1');
});

check('normalizeSetForEbay: case-insensitive — "series two" → "Series 2"', () => {
  assert.equal(normalizeSetForEbay('series two'), 'Series 2');
  assert.equal(normalizeSetForEbay('SERIES TWO'), 'Series 2');
});

check('normalizeSetForEbay: rewrites embedded — "Topps Series Two" → "Topps Series 2"', () => {
  assert.equal(normalizeSetForEbay('Topps Series Two'), 'Topps Series 2');
});

check('normalizeSetForEbay: leaves "Update Series" untouched', () => {
  assert.equal(normalizeSetForEbay('Update Series'), 'Update Series');
});

check('normalizeSetForEbay: leaves "Stadium Club" untouched', () => {
  assert.equal(normalizeSetForEbay('Stadium Club'), 'Stadium Club');
});

check('normalizeSetForEbay: empty input → empty string', () => {
  assert.equal(normalizeSetForEbay(''), '');
  assert.equal(normalizeSetForEbay(null), '');
  assert.equal(normalizeSetForEbay(undefined), '');
});

check('normalizeSetForEbay: numeric "Series 2" passes through unchanged', () => {
  assert.equal(normalizeSetForEbay('Series 2'), 'Series 2');
  assert.equal(normalizeSetForEbay('Series 1'), 'Series 1');
});

check('normalizeSetForEbay: does NOT match "Series Twofold" or other word boundaries', () => {
  // \bSeries\s+Two\b only matches when "Two" is a whole word.
  assert.equal(normalizeSetForEbay('Series Twofold'), 'Series Twofold');
});

// ── formatYearForEbay ──────────────────────────────────────────────────

check('formatYearForEbay: Basketball + integer year → YYYY-YY', () => {
  assert.equal(
    formatYearForEbay({ year: 2024, sport: 'Basketball' }),
    '2024-25',
  );
});

check('formatYearForEbay: Hockey + integer year → YYYY-YY', () => {
  assert.equal(
    formatYearForEbay({ year: 2023, sport: 'Hockey' }),
    '2023-24',
  );
});

check('formatYearForEbay: Baseball + integer year → "2024" (no range)', () => {
  assert.equal(
    formatYearForEbay({ year: 2024, sport: 'Baseball' }),
    '2024',
  );
});

check('formatYearForEbay: Football + integer year → "2023"', () => {
  assert.equal(
    formatYearForEbay({ year: 2023, sport: 'Football' }),
    '2023',
  );
});

check('formatYearForEbay: yearPrintedRaw range matches integer year → range wins', () => {
  // "2024-25" matches start year 2024 → emit it.
  assert.equal(
    formatYearForEbay({
      year: 2024,
      sport: 'Baseball',
      yearPrintedRaw: '2024-25',
    }),
    '2024-25',
  );
});

check('formatYearForEbay: yearPrintedRaw with mismatched start year → fallback to sport-based', () => {
  // Off-by-one back imprint. Range "2023-24" vs canonical year 2024 →
  // ignore the range, fall through. Football is non-season → emit "2024".
  assert.equal(
    formatYearForEbay({
      year: 2024,
      sport: 'Football',
      yearPrintedRaw: '2023-24',
    }),
    '2024',
  );
});

check('formatYearForEbay: empty / null year returns empty string', () => {
  assert.equal(formatYearForEbay({ year: null }), '');
  assert.equal(formatYearForEbay({ year: undefined }), '');
  assert.equal(formatYearForEbay({ year: '' }), '');
});

check('formatYearForEbay: string year "2024" + Basketball → "2024-25"', () => {
  assert.equal(
    formatYearForEbay({ year: '2024', sport: 'Basketball' }),
    '2024-25',
  );
});

check('formatYearForEbay: Y2K boundary — 2099 Basketball → "2099-00"', () => {
  // (2099+1) mod 100 = 0, padded to "00".
  assert.equal(
    formatYearForEbay({ year: 2099, sport: 'Basketball' }),
    '2099-00',
  );
});

check('formatYearForEbay: yearPrintedRaw with unparseable year falls back', () => {
  // No integer, but "2024-25" range parseable.
  assert.equal(
    formatYearForEbay({
      year: null,
      yearPrintedRaw: '© 2024-25 PANINI',
    }),
    '2024-25',
  );
});

check('formatYearForEbay: yearPrintedRaw with single 4-digit year falls back to that', () => {
  assert.equal(
    formatYearForEbay({ year: null, yearPrintedRaw: '© 2023 TOPPS' }),
    '2023',
  );
});

// ── formatYearForSheet ─────────────────────────────────────────────────

check('formatYearForSheet: Basketball + integer year → YYYY-YY (matches eBay)', () => {
  assert.equal(
    formatYearForSheet({ year: 2024, sport: 'Basketball' }),
    '2024-25',
  );
});

check('formatYearForSheet: Baseball + integer → "2024"', () => {
  assert.equal(
    formatYearForSheet({ year: 2024, sport: 'Baseball' }),
    '2024',
  );
});

check('formatYearForSheet: null year + no printed raw → empty', () => {
  assert.equal(formatYearForSheet({ year: null }), '');
});

check('formatYearForSheet: integer year with no sport always emits the integer (never empty)', () => {
  // The Sheet column needs SOMETHING — never blank when the input parses.
  assert.equal(formatYearForSheet({ year: 2024 }), '2024');
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
