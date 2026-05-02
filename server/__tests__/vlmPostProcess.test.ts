/**
 * Standalone assert-based tests for the Big League era guard added in
 * server/vlmPostProcess.ts. Runs in the same style as
 * server/__tests__/vlmApply.coercion.test.ts:
 *
 *   npx tsx server/__tests__/vlmPostProcess.test.ts
 *
 * The repo has no vitest/jest config — we lean on `node:assert` so the
 * dependency surface stays at zero.
 */

import assert from 'node:assert/strict';
import { applySetEraGuard } from '../vlmPostProcess';

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

// ── Big League era guard ─────────────────────────────────────────────────

check('1987 Topps + set="Big League" → corrected to "Topps"', () => {
  const result = applySetEraGuard({ set: 'Big League', brand: 'Topps', year: 1987 });
  assert.equal(result.set, 'Topps');
  assert.equal(result.setCorrected, 'big-league-era-guard');
});

check('2017 Topps + set="Big League" → corrected (year is below 2018 launch)', () => {
  const result = applySetEraGuard({ set: 'Big League', brand: 'Topps', year: 2017 });
  assert.equal(result.set, 'Topps');
  assert.equal(result.setCorrected, 'big-league-era-guard');
});

check('2024 Topps + set="Big League" → unchanged (post-2018, valid)', () => {
  const result = applySetEraGuard({ set: 'Big League', brand: 'Topps', year: 2024 });
  assert.equal(result.set, 'Big League');
  assert.equal(result.setCorrected, null);
});

check('2018 Topps + set="Big League" → unchanged (launch year boundary)', () => {
  const result = applySetEraGuard({ set: 'Big League', brand: 'Topps', year: 2018 });
  assert.equal(result.set, 'Big League');
  assert.equal(result.setCorrected, null);
});

check('case-insensitive Big League match', () => {
  const result = applySetEraGuard({ set: 'BIG LEAGUE', brand: 'Topps', year: 1987 });
  assert.equal(result.set, 'Topps');
  assert.equal(result.setCorrected, 'big-league-era-guard');
});

// ── Vintage Topps empty-set fallback ─────────────────────────────────────

check('1987 Topps + set="" → falls back to "Topps"', () => {
  const result = applySetEraGuard({ set: '', brand: 'Topps', year: 1987 });
  assert.equal(result.set, 'Topps');
  assert.equal(result.setCorrected, 'vintage-topps-empty-set-fallback');
});

check('1968 Topps + set="" → falls back to "Topps"', () => {
  const result = applySetEraGuard({ set: '   ', brand: 'Topps', year: 1968 });
  assert.equal(result.set, 'Topps');
  assert.equal(result.setCorrected, 'vintage-topps-empty-set-fallback');
});

check('1987 Topps + set="unknown" → falls back to "Topps"', () => {
  const result = applySetEraGuard({ set: 'unknown', brand: 'topps', year: 1987 });
  assert.equal(result.set, 'Topps');
  assert.equal(result.setCorrected, 'vintage-topps-empty-set-fallback');
});

check('2024 Topps + set="" → unchanged (modern, do not autofill)', () => {
  const result = applySetEraGuard({ set: '', brand: 'Topps', year: 2024 });
  assert.equal(result.set, '');
  assert.equal(result.setCorrected, null);
});

check('1995 Topps + set="" → unchanged (boundary; cutoff is < 1995)', () => {
  const result = applySetEraGuard({ set: '', brand: 'Topps', year: 1995 });
  assert.equal(result.set, '');
  assert.equal(result.setCorrected, null);
});

check('1987 Panini + set="" → unchanged (only Topps gets the fallback)', () => {
  const result = applySetEraGuard({ set: '', brand: 'Panini', year: 1987 });
  assert.equal(result.set, '');
  assert.equal(result.setCorrected, null);
});

check('1987 Topps + set="Tiffany" → unchanged (recognized vintage subset)', () => {
  const result = applySetEraGuard({ set: 'Tiffany', brand: 'Topps', year: 1987 });
  assert.equal(result.set, 'Tiffany');
  assert.equal(result.setCorrected, null);
});

check('year 0 / null is a no-op (no era information)', () => {
  const result = applySetEraGuard({ set: 'Big League', brand: 'Topps', year: null });
  assert.equal(result.set, 'Big League');
  assert.equal(result.setCorrected, null);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nall tests passed');
}
