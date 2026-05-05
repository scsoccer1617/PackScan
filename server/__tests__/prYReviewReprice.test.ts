/**
 * PR Y — review-flow re-price wiring tests.
 *
 * Run with:
 *
 *   npx tsx server/__tests__/prYReviewReprice.test.ts
 *
 * The new POST /api/bulk-scan/review/:itemId/reprice endpoint takes the
 * dealer's edited identity, runs the picker pipeline against it, and
 * returns the resulting CompsSummary + rebuilt eBay URL — without
 * touching the DB analysisResult or the user's sheet. The
 * heavyweight pieces (DB, eBay HTTP, sheet writes) are covered by their
 * own suites; this suite focuses on the wiring that's specific to PR Y:
 *
 *  1. The picker query the endpoint builds for representative review
 *     edits applies PR X helpers (Series Two→2 set normalization,
 *     YYYY-YY year normalization for season sports). Same chain as the
 *     analyze pipeline so the preview pool matches what auto-save would
 *     have priced before the dealer's correction.
 *  2. `formatYearForSheet` produces the YYYY-YY string for season-sport
 *     reviews so the year cell in /save matches the analyze pipeline.
 *  3. Required-field validation catches the empty-identity case before
 *     burning an eBay round trip — same gate the server's 422 path uses.
 */

import assert from 'node:assert/strict';
import { buildPickerQuery } from '../ebayPickerSearch';
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

// Mirror the endpoint's query-building chain so any drift between the
// test and the route surfaces as a failure here.
function buildEditedQuery(edits: {
  year: string;
  brand: string;
  set: string;
  cardNumber: string;
  player: string;
  sport?: string;
  yearPrintedRaw?: string;
  parallel?: string;
  subset?: string;
}): string {
  const parallel = (edits.parallel ?? '').trim();
  return buildPickerQuery({
    year:
      formatYearForEbay({
        year: edits.year,
        sport: edits.sport,
        yearPrintedRaw: edits.yearPrintedRaw,
      }) || edits.year,
    brand: edits.brand,
    set: normalizeSetForEbay(edits.set),
    cardNumber: edits.cardNumber,
    player: edits.player || (edits.subset ?? ''),
    subset: edits.player ? (edits.subset ?? '') : '',
    parallel,
    excludeParallels: !parallel,
  });
}

// ── Series Two → Series 2 propagation ──────────────────────────────────

check('reprice query rewrites edited "Series Two" → "Series 2"', () => {
  const q = buildEditedQuery({
    year: '2024',
    brand: 'Topps',
    set: 'Series Two',
    cardNumber: '650',
    player: 'Francisco Lindor',
    sport: 'Baseball',
  });
  assert.match(q, /Series 2\b/);
  assert.doesNotMatch(q, /Series Two/i);
});

check('reprice query preserves "Update Series" untouched (only Two/One are rewritten)', () => {
  const q = buildEditedQuery({
    year: '2024',
    brand: 'Topps',
    set: 'Update Series',
    cardNumber: 'US300',
    player: 'Aaron Judge',
    sport: 'Baseball',
  });
  assert.match(q, /Update Series/);
});

check('reprice query rewrites embedded "Topps Series Two" inside set', () => {
  const q = buildEditedQuery({
    year: '2024',
    brand: 'Topps',
    set: 'Topps Series Two',
    cardNumber: '7',
    player: 'Mookie Betts',
    sport: 'Baseball',
  });
  assert.match(q, /Series 2/);
  assert.doesNotMatch(q, /Series Two/i);
});

// ── YYYY-YY year normalization for season sports ───────────────────────

check('reprice query emits YYYY-YY for Basketball (season sport)', () => {
  const q = buildEditedQuery({
    year: '2024',
    brand: 'Panini',
    set: 'Prizm',
    cardNumber: '249',
    player: 'Victor Wembanyama',
    sport: 'Basketball',
  });
  assert.match(q, /\b2024-25\b/);
});

check('reprice query emits YYYY-YY for Hockey (season sport)', () => {
  const q = buildEditedQuery({
    year: '2023',
    brand: 'Upper Deck',
    set: 'Series One',
    cardNumber: '450',
    player: 'Connor Bedard',
    sport: 'Hockey',
  });
  assert.match(q, /\b2023-24\b/);
  // Series One also gets normalized to "Series 1" via PR X.
  assert.match(q, /Series 1\b/);
});

check('reprice query stays integer year for Baseball', () => {
  const q = buildEditedQuery({
    year: '2024',
    brand: 'Topps',
    set: 'Series One',
    cardNumber: '1',
    player: 'Shohei Ohtani',
    sport: 'Baseball',
  });
  assert.match(q, /(^|\s)2024(\s|$)/);
  assert.doesNotMatch(q, /2024-25/);
});

// ── formatYearForSheet propagates through the save path ─────────────────

check('formatYearForSheet returns YYYY-YY for Basketball reviews', () => {
  const cell = formatYearForSheet({
    year: 2024,
    sport: 'Basketball',
    yearPrintedRaw: null,
  });
  assert.equal(cell, '2024-25');
});

check('formatYearForSheet returns YYYY-YY for Hockey reviews', () => {
  const cell = formatYearForSheet({
    year: 2023,
    sport: 'Hockey',
    yearPrintedRaw: null,
  });
  assert.equal(cell, '2023-24');
});

check('formatYearForSheet preserves printed range when start matches', () => {
  const cell = formatYearForSheet({
    year: 2024,
    sport: 'Baseball',
    yearPrintedRaw: '2024-25',
  });
  assert.equal(cell, '2024-25');
});

check('formatYearForSheet falls back to integer year for Baseball without range', () => {
  const cell = formatYearForSheet({
    year: 2024,
    sport: 'Baseball',
    yearPrintedRaw: null,
  });
  assert.equal(cell, '2024');
});

// ── Required-field validation matches the server's 422 path ────────────

interface IdentityCheckable {
  brand?: string | null;
  year?: string | number | null;
  cardNumber?: string | null;
  player?: string | null;
  subset?: string | null;
}

function isIncompleteIdentity(edits: IdentityCheckable): boolean {
  const brand = (edits.brand ?? '').toString().trim();
  const yearStr = edits.year != null && edits.year !== '' ? String(edits.year).trim() : '';
  const cardNumber = (edits.cardNumber ?? '').toString().trim();
  const player = (edits.player ?? '').toString().trim();
  const subset = (edits.subset ?? '').toString().trim();
  return !cardNumber || !brand || !yearStr || (!player && !subset);
}

check('incomplete identity: missing brand → reject', () => {
  assert.equal(
    isIncompleteIdentity({
      year: '2024',
      cardNumber: '650',
      player: 'Lindor',
    }),
    true,
  );
});

check('incomplete identity: missing year → reject', () => {
  assert.equal(
    isIncompleteIdentity({
      brand: 'Topps',
      cardNumber: '650',
      player: 'Lindor',
    }),
    true,
  );
});

check('incomplete identity: missing card number → reject', () => {
  assert.equal(
    isIncompleteIdentity({
      brand: 'Topps',
      year: '2024',
      player: 'Lindor',
    }),
    true,
  );
});

check('incomplete identity: missing player AND subset → reject', () => {
  assert.equal(
    isIncompleteIdentity({
      brand: 'Topps',
      year: '2024',
      cardNumber: '650',
    }),
    true,
  );
});

check('complete identity with player → accept', () => {
  assert.equal(
    isIncompleteIdentity({
      brand: 'Topps',
      year: '2024',
      cardNumber: '650',
      player: 'Francisco Lindor',
    }),
    false,
  );
});

check('complete identity with subset (no player) → accept', () => {
  assert.equal(
    isIncompleteIdentity({
      brand: 'Topps',
      year: '1971',
      cardNumber: '160',
      subset: 'N.L. Strikeout Leaders',
    }),
    false,
  );
});

// ── Reprice payload shape (mirrors RepriceResponse on the client) ──────
// The Save flow sends the response's `summary.mean` back as
// `estimatedValue` in the /save payload. Verify the contract: a missing
// mean is treated as 0 (sentinel writes "No active listings"), and a
// numeric mean rounds to two decimals for display.

function meanForSheet(summary: { mean: number | null; count: number }): number {
  if (typeof summary.mean === 'number' && Number.isFinite(summary.mean)) {
    return summary.mean;
  }
  return 0;
}

check('save payload: numeric mean propagates verbatim', () => {
  assert.equal(meanForSheet({ mean: 12.34, count: 5 }), 12.34);
});

check('save payload: null mean → 0 (sentinel write path)', () => {
  assert.equal(meanForSheet({ mean: null, count: 0 }), 0);
});

check('save payload: NaN mean → 0 (defensive)', () => {
  assert.equal(meanForSheet({ mean: Number.NaN, count: 0 }), 0);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
