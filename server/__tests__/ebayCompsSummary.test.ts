/**
 * PR G — unit tests for the ebayCompsSummary helper.
 * Run via:
 *
 *   npx tsx server/__tests__/ebayCompsSummary.test.ts
 *
 * Covers:
 *  - median calc (odd + even pool size)
 *  - mean calc
 *  - shipping fold-in (price + shippingCost)
 *  - precision filter: card # + last name in title
 *  - empty pool returns nulls
 */

import assert from 'node:assert/strict';
import {
  median,
  mean,
  effectivePrice,
  computeSummary,
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

check('median: odd-length pool', () => {
  assert.equal(median([1, 5, 3]), 3);
});

check('median: even-length pool averages middle two', () => {
  assert.equal(median([10, 20, 30, 40]), 25);
});

check('median: single element', () => {
  assert.equal(median([42]), 42);
});

check('median: empty pool returns null', () => {
  assert.equal(median([]), null);
});

check('mean: simple', () => {
  assert.equal(mean([2, 4, 6]), 4);
});

check('mean: empty returns null', () => {
  assert.equal(mean([]), null);
});

check('effectivePrice: folds shipping into price', () => {
  const item = {
    price: { value: '10.00' },
    shippingOptions: [{ shippingCost: { value: '4.50' } }],
  };
  assert.equal(effectivePrice(item), 14.5);
});

check('effectivePrice: no shipping → just price', () => {
  const item = { price: { value: '20.00' } };
  assert.equal(effectivePrice(item), 20);
});

check('effectivePrice: zero / missing values safe', () => {
  assert.equal(effectivePrice({}), 0);
  assert.equal(effectivePrice({ price: { value: '0' } }), 0);
});

check('computeSummary: filters by card # + last name, folds shipping, computes median + mean', () => {
  const items = [
    {
      title: '2025 Topps #193 Nolan Arenado',
      price: { value: '10.00' },
      shippingOptions: [{ shippingCost: { value: '5.00' } }],
    }, // 15
    {
      title: '2025 Topps #193 Nolan Arenado RC',
      price: { value: '20.00' },
    }, // 20
    {
      title: '2025 Topps #193 Arenado SP',
      price: { value: '40.00' },
    }, // 40
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
  assert.equal(summary.median, 20);
  assert.equal(summary.mean, 25);
  assert.equal(summary.currency, 'USD');
});

check('computeSummary: empty pool returns nulls', () => {
  const summary = computeSummary([], 'q');
  assert.equal(summary.count, 0);
  assert.equal(summary.median, null);
  assert.equal(summary.mean, null);
});

check('computeSummary: drops zero-priced items', () => {
  const items = [
    { title: 'a', price: { value: '0' } },
    { title: 'b', price: { value: '10' } },
  ];
  const summary = computeSummary(items, 'q');
  assert.equal(summary.count, 1);
  assert.equal(summary.median, 10);
});

check('computeSummary: card # filter strips leading #', () => {
  const items = [
    { title: 'has 42 in title', price: { value: '10' } },
    { title: 'no number', price: { value: '20' } },
  ];
  const summary = computeSummary(items, 'q', { requireCardNumber: '#42' });
  assert.equal(summary.count, 1);
  assert.equal(summary.median, 10);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
