/**
 * PR K — unit tests for the unified ebayCompsSummary helper.
 * Run via:
 *
 *   npx tsx server/__tests__/ebayCompsSummary.test.ts
 *
 * Covers:
 *  - mean calc (canonical)
 *  - median calc (deprecated diagnostic, still computed)
 *  - itemPrice = price.value (NO shipping fold-in)
 *  - precision filter: card # + last name in title
 *  - empty pool returns nulls
 *  - listings array is included and capped by pool size
 *  - ensureBinFilter helper: appends LH_BIN=1, idempotent, handles
 *    URLs with and without an existing query string
 */

import assert from 'node:assert/strict';
import {
  median,
  mean,
  itemPrice,
  computeSummary,
  ensureBinFilter,
} from '../ebayCompsSummary';

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

// ── mean / median primitives ────────────────────────────────────────────────

check('mean: simple', () => {
  assert.equal(mean([2, 4, 6]), 4);
});

check('mean: single element', () => {
  assert.equal(mean([42]), 42);
});

check('mean: empty returns null', () => {
  assert.equal(mean([]), null);
});

check('median: odd-length pool', () => {
  assert.equal(median([1, 5, 3]), 3);
});

check('median: even-length pool averages middle two', () => {
  assert.equal(median([10, 20, 30, 40]), 25);
});

check('median: empty pool returns null', () => {
  assert.equal(median([]), null);
});

// ── itemPrice (PR K: no shipping fold-in) ──────────────────────────────────

check('itemPrice: returns price.value, no shipping fold-in', () => {
  const item = {
    price: { value: '10.00' },
    shippingOptions: [{ shippingCost: { value: '4.50' } }],
  };
  // Pre-PR-K this would have been 14.5; PR K drops shipping.
  assert.equal(itemPrice(item), 10);
});

check('itemPrice: missing price → 0', () => {
  assert.equal(itemPrice({}), 0);
  assert.equal(itemPrice({ price: { value: '0' } }), 0);
});

// ── computeSummary ─────────────────────────────────────────────────────────

check('computeSummary: filters by card # + last name, computes mean (canonical)', () => {
  const items = [
    {
      title: '2025 Topps #193 Nolan Arenado',
      itemWebUrl: 'https://example.com/1',
      price: { value: '10.00', currency: 'USD' },
      shippingOptions: [{ shippingCost: { value: '5.00' } }],
    }, // 10 (PR K: shipping ignored)
    {
      title: '2025 Topps #193 Nolan Arenado RC',
      itemWebUrl: 'https://example.com/2',
      price: { value: '20.00', currency: 'USD' },
    }, // 20
    {
      title: '2025 Topps #193 Arenado SP',
      itemWebUrl: 'https://example.com/3',
      price: { value: '30.00', currency: 'USD' },
    }, // 30
    // Filtered out — wrong card number
    { title: '2025 Topps #194 Nolan Arenado', price: { value: '999' } },
    // Filtered out — wrong last name
    { title: '2025 Topps #193 Mike Trout', price: { value: '999' } },
  ];
  const summary = computeSummary(items, 'q', {
    requireCardNumber: '193',
    requirePlayerLastName: 'Arenado',
  });
  assert.equal(summary.count, 3);
  assert.equal(summary.mean, 20); // (10 + 20 + 30) / 3
  assert.equal(summary.median, 20);
  assert.equal(summary.currency, 'USD');
  // Listings array is included and contains the 3 survivors.
  assert.equal(summary.listings.length, 3);
  assert.equal(summary.listings[0].price, 10);
  assert.equal(summary.listings[0].url, 'https://example.com/1');
  // Mean equals sum(listings.price) / listings.length.
  const sum = summary.listings.reduce((s, l) => s + l.price, 0);
  assert.equal(summary.mean, sum / summary.listings.length);
});

check('computeSummary: empty pool returns nulls + empty listings', () => {
  const summary = computeSummary([], 'q');
  assert.equal(summary.count, 0);
  assert.equal(summary.mean, null);
  assert.equal(summary.median, null);
  assert.deepEqual(summary.listings, []);
});

check('computeSummary: drops zero-priced items', () => {
  const items = [
    { title: 'a', price: { value: '0' } },
    { title: 'b', price: { value: '10' } },
  ];
  const summary = computeSummary(items, 'q');
  assert.equal(summary.count, 1);
  assert.equal(summary.mean, 10);
});

check('computeSummary: card # filter strips leading #', () => {
  const items = [
    { title: 'has 42 in title', price: { value: '10' } },
    { title: 'no number', price: { value: '20' } },
  ];
  const summary = computeSummary(items, 'q', { requireCardNumber: '#42' });
  assert.equal(summary.count, 1);
  assert.equal(summary.mean, 10);
});

check('computeSummary: listings.length <= raw items, never exceeds incoming pool', () => {
  // The Browse fetch caps at limit=10; the helper does not invent
  // listings beyond the input. Asserts the bound holds when given more
  // than 10 raw items (computeSummary itself doesn't slice — slicing
  // happens at the Browse `limit=10`; this just confirms we don't grow
  // the survivor set past the input).
  const items = Array.from({ length: 12 }, (_, i) => ({
    title: `card #99 player ${i}`,
    price: { value: `${i + 1}` },
  }));
  const summary = computeSummary(items, 'q');
  assert.ok(summary.listings.length <= items.length);
  assert.equal(summary.listings.length, 12);
});

// ── ensureBinFilter ────────────────────────────────────────────────────────

check('ensureBinFilter: appends LH_BIN=1 to a URL with no query string', () => {
  assert.equal(
    ensureBinFilter('https://www.ebay.com/sch/i.html'),
    'https://www.ebay.com/sch/i.html?LH_BIN=1',
  );
});

check('ensureBinFilter: appends LH_BIN=1 to a URL with an existing query string', () => {
  assert.equal(
    ensureBinFilter('https://www.ebay.com/sch/i.html?_nkw=foo&_sop=10'),
    'https://www.ebay.com/sch/i.html?_nkw=foo&_sop=10&LH_BIN=1',
  );
});

check('ensureBinFilter: idempotent when LH_BIN=1 is already present', () => {
  const url = 'https://www.ebay.com/sch/i.html?_nkw=foo&LH_BIN=1';
  assert.equal(ensureBinFilter(url), url);
});

check('ensureBinFilter: preserves other LH_BIN values without doubling', () => {
  // If someone passes LH_BIN=0 we don't override it — we just don't
  // add a second LH_BIN. (Belt-and-suspenders: callers shouldn't
  // construct LH_BIN=0, but if they do we don't make it worse.)
  const url = 'https://www.ebay.com/sch/i.html?LH_BIN=0';
  assert.equal(ensureBinFilter(url), url);
});

check('ensureBinFilter: empty / null input → empty string', () => {
  assert.equal(ensureBinFilter(''), '');
  assert.equal(ensureBinFilter(null), '');
  assert.equal(ensureBinFilter(undefined), '');
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
