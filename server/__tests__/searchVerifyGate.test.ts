import assert from 'node:assert/strict';
import { decideSearchVerifyGate, computeAveragePrice } from '../searchVerifyGate';

// Use any-cast for test fixtures since PickerListing has many required fields.
const L = (price: number) => ({ price } as any);

const cases: Array<{ name: string; in: any; broad: boolean; expectFire: boolean; expectReason: string }> = [
  { name: 'zero comps -> fire (zero)', in: { active: [], year: 2024 }, broad: false, expectFire: true, expectReason: 'zero' },
  { name: 'zero comps + broad off -> still fire (zero)', in: { active: null, year: 2024 }, broad: false, expectFire: true, expectReason: 'zero' },
  { name: '5 comps avg $20 -> no fire', in: { active: [L(20), L(20), L(20), L(20), L(20)], year: 2024, averagePriceUsd: 20 }, broad: true, expectFire: false, expectReason: 'enough-comps' },
  { name: '2 comps avg $2 broad on -> fire (low-confidence)', in: { active: [L(2), L(2)], year: 2024, averagePriceUsd: 2 }, broad: true, expectFire: true, expectReason: 'low-confidence' },
  { name: '2 comps avg $2 broad OFF -> no fire', in: { active: [L(2), L(2)], year: 2024, averagePriceUsd: 2 }, broad: false, expectFire: false, expectReason: 'enough-comps' },
  { name: '1 comp year 1995 broad on -> fire (vintage)', in: { active: [L(15)], year: 1995, averagePriceUsd: 15 }, broad: true, expectFire: true, expectReason: 'low-confidence-vintage' },
  { name: '1 comp year 1995 broad OFF -> no fire', in: { active: [L(15)], year: 1995, averagePriceUsd: 15 }, broad: false, expectFire: false, expectReason: 'enough-comps' },
  { name: '1 comp year 2024 -> no fire (not vintage)', in: { active: [L(15)], year: 2024, averagePriceUsd: 15 }, broad: true, expectFire: false, expectReason: 'enough-comps' },
  { name: '3 comps avg $4 -> no fire (count > 2)', in: { active: [L(4), L(4), L(4)], year: 1995, averagePriceUsd: 4 }, broad: true, expectFire: false, expectReason: 'enough-comps' },
  { name: '2 comps avg $5 exactly -> no fire (price not strictly <$5)', in: { active: [L(5), L(5)], year: 2024, averagePriceUsd: 5 }, broad: true, expectFire: false, expectReason: 'enough-comps' },
  { name: '2 comps avg null -> no fire', in: { active: [L(0), L(0)], year: 2024, averagePriceUsd: null }, broad: true, expectFire: false, expectReason: 'enough-comps' },
  { name: 'year as string "1995" + 1 comp broad on -> fire vintage', in: { active: [L(15)], year: '1995', averagePriceUsd: 15 }, broad: true, expectFire: true, expectReason: 'low-confidence-vintage' },
];

for (const c of cases) {
  const got = decideSearchVerifyGate(c.in, c.broad);
  assert.equal(got.fire, c.expectFire, `${c.name}: fire`);
  assert.equal(got.reason, c.expectReason, `${c.name}: reason`);
  console.log(`ok: ${c.name}`);
}

// computeAveragePrice
assert.equal(computeAveragePrice(null), null, 'avg null input');
assert.equal(computeAveragePrice([]), null, 'avg empty');
assert.equal(computeAveragePrice([L(10), L(20)]), 15, 'avg simple');
assert.equal(computeAveragePrice([{ price: 'not-a-number' } as any, L(10)]), 10, 'avg ignores non-numeric');
assert.equal(computeAveragePrice([{ price: 0 } as any, L(10)]), 10, 'avg ignores zero');
console.log('ok: computeAveragePrice');

console.log('ALL OK');
