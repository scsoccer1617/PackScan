/**
 * Unit tests for the pure filter helpers in `server/vlmSearchVerifyApply.ts`.
 * Run via:
 *
 *   npx tsx server/__tests__/vlmSearchVerifyApply.test.ts
 *
 * The repo has no vitest/jest config, so we lean on `node:assert/strict`
 * and exit non-zero on any failure.
 */

import assert from 'node:assert/strict';
import {
  canonicalizeSetString,
  isCardNumberPrefixMismatch,
  filterUnsafeCorrections,
} from '../vlmSearchVerifyApply';

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok: ${name}`);
  } catch (err: any) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err?.message || err);
  }
}

// ── canonicalizeSetString ────────────────────────────────────────────────

check('canonicalizeSetString: Series One === Series 1', () => {
  assert.equal(canonicalizeSetString('Series One'), canonicalizeSetString('Series 1'));
});

check('canonicalizeSetString: TOPPS chrome === topps chrome', () => {
  assert.equal(canonicalizeSetString('TOPPS chrome'), canonicalizeSetString('topps chrome'));
});

check('canonicalizeSetString: trims whitespace', () => {
  assert.equal(canonicalizeSetString('  Series One  '), 'series 1');
});

check('canonicalizeSetString: punctuation collapses', () => {
  assert.equal(
    canonicalizeSetString('Topps-Chrome!'),
    canonicalizeSetString('topps chrome'),
  );
});

check('canonicalizeSetString: empty / null', () => {
  assert.equal(canonicalizeSetString(''), '');
  assert.equal(canonicalizeSetString(null), '');
  assert.equal(canonicalizeSetString(undefined), '');
});

// ── isCardNumberPrefixMismatch ───────────────────────────────────────────

check('isCardNumberPrefixMismatch: US175 -> 100 is true', () => {
  assert.equal(isCardNumberPrefixMismatch('US175', '100'), true);
});

check('isCardNumberPrefixMismatch: 100 -> US175 is false', () => {
  assert.equal(isCardNumberPrefixMismatch('100', 'US175'), false);
});

check('isCardNumberPrefixMismatch: 100 -> 99 is false', () => {
  assert.equal(isCardNumberPrefixMismatch('100', '99'), false);
});

check('isCardNumberPrefixMismatch: null cases false', () => {
  assert.equal(isCardNumberPrefixMismatch(null, '100'), false);
  assert.equal(isCardNumberPrefixMismatch('US175', null), false);
  assert.equal(isCardNumberPrefixMismatch(null, null), false);
  assert.equal(isCardNumberPrefixMismatch('', '100'), false);
  assert.equal(isCardNumberPrefixMismatch('US175', ''), false);
});

check('isCardNumberPrefixMismatch: BCP-100 -> 100 is true', () => {
  assert.equal(isCardNumberPrefixMismatch('BCP-100', '100'), true);
});

check('isCardNumberPrefixMismatch: BCP-100 -> BCP100 is false (still prefixed)', () => {
  assert.equal(isCardNumberPrefixMismatch('BCP-100', 'BCP100'), false);
});

// ── filterUnsafeCorrections ──────────────────────────────────────────────

check('filterUnsafeCorrections: drops cardNumber prefix mismatch (US175 -> 100)', () => {
  const result = filterUnsafeCorrections(
    { player: 'X', year: '2024', brand: 'Topps', set: 'Update', cardNumber: 'US175' },
    { cardNumber: '100' },
  );
  assert.equal(result.safe.cardNumber, undefined);
  assert.ok(result.dropped.find((d) => d.field === 'cardNumber'));
});

check('filterUnsafeCorrections: drops stylistic set (Series One -> Series 1)', () => {
  const result = filterUnsafeCorrections(
    { player: 'X', year: '2024', brand: 'Topps', set: 'Series One', cardNumber: '100' },
    { set: 'Series 1' },
  );
  assert.equal(result.safe.set, undefined);
  assert.ok(result.dropped.find((d) => d.field === 'set'));
});

check('filterUnsafeCorrections: drops player even on different value', () => {
  const result = filterUnsafeCorrections(
    { player: 'Old Name', year: '2024', brand: 'Topps', set: 'Series One', cardNumber: '100' },
    { player: 'New Name' },
  );
  assert.equal((result.safe as any).player, undefined);
  assert.ok(result.dropped.find((d) => d.field === 'player'));
});

check('filterUnsafeCorrections: keeps year 1994 -> 1995', () => {
  const result = filterUnsafeCorrections(
    { player: 'X', year: '1994', brand: 'Upper Deck', set: 'Minor League', cardNumber: '28' },
    { year: '1995' },
  );
  assert.equal(result.safe.year, '1995');
});

check('filterUnsafeCorrections: keeps brand Upper Deck -> Upper Deck Minor League', () => {
  const result = filterUnsafeCorrections(
    { player: 'X', year: '1995', brand: 'Upper Deck', set: 'Future Stock', cardNumber: '28' },
    { brand: 'Upper Deck Minor League' },
  );
  assert.equal(result.safe.brand, 'Upper Deck Minor League');
});

check('filterUnsafeCorrections: drops "no change" cases', () => {
  const result = filterUnsafeCorrections(
    { player: 'X', year: '1995', brand: 'Topps', set: 'Series One', cardNumber: '100' },
    { brand: 'Topps', year: '1995' },
  );
  assert.equal(result.safe.brand, undefined);
  assert.equal(result.safe.year, undefined);
  assert.equal(result.dropped.filter((d) => d.reason === 'no change').length, 2);
});

check('filterUnsafeCorrections: keeps a real set change (Future Stock -> Minor League)', () => {
  const result = filterUnsafeCorrections(
    { player: 'X', year: '1995', brand: 'Upper Deck', set: 'Future Stock', cardNumber: '28' },
    { set: 'Upper Deck Minor League' },
  );
  assert.equal(result.safe.set, 'Upper Deck Minor League');
});

check('filterUnsafeCorrections: drops empty-proposed values', () => {
  const result = filterUnsafeCorrections(
    { player: 'X', year: '1995', brand: 'Topps', set: 'Series One', cardNumber: '100' },
    { brand: '   ' },
  );
  assert.equal(result.safe.brand, undefined);
});

check('filterUnsafeCorrections: keeps a legitimate cardNumber change with same prefix shape', () => {
  const result = filterUnsafeCorrections(
    { player: 'X', year: '2024', brand: 'Topps', set: 'Update', cardNumber: 'US175' },
    { cardNumber: 'US176' },
  );
  assert.equal(result.safe.cardNumber, 'US176');
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('ALL OK');
