/**
 * Standalone assert-based tests for the VLM post-processing coercions added
 * in the 2026 Topps Series One bulk-audit fix. Run via:
 *
 *   npx tsx server/__tests__/vlmApply.coercion.test.ts
 *
 * The repo has no vitest/jest config (PR #206 noted this), so we keep the
 * dependency surface minimal and lean on `node:assert`. Exits non-zero on
 * any failed assertion so a future CI gate can wire this up cheaply.
 */

import assert from 'node:assert/strict';
import { normalizeSetValue, isBaseCollection, applyGeminiToCombined, normalizeSport } from '../vlmApply';

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

// ── normalizeSetValue ────────────────────────────────────────────────────

check('strips brand prefix on Topps Series One', () => {
  assert.equal(normalizeSetValue('Topps Series One', 'Topps'), 'Series One');
});
check('strips brand prefix on Topps Series Two', () => {
  assert.equal(normalizeSetValue('Topps Series Two', 'Topps'), 'Series Two');
});
check('strips year+brand prefix on 2026 Topps Series One', () => {
  assert.equal(normalizeSetValue('2026 Topps Series One', 'Topps'), 'Series One');
});
check('strips year+brand prefix on 2024 Panini NBA Hoops', () => {
  assert.equal(normalizeSetValue('2024 Panini NBA Hoops', 'Panini'), 'NBA Hoops');
});
check('preserves disambiguator-only "Series One"', () => {
  assert.equal(normalizeSetValue('Series One', 'Topps'), 'Series One');
});
check('preserves multi-word disambiguators that share a brand prefix once stripped', () => {
  assert.equal(normalizeSetValue('Topps Stadium Club', 'Topps'), 'Stadium Club');
});
check('returns empty when set is exactly the brand', () => {
  assert.equal(normalizeSetValue('Topps', 'Topps'), '');
});
check('returns empty for empty input', () => {
  assert.equal(normalizeSetValue('', 'Topps'), '');
  assert.equal(normalizeSetValue('   ', 'Topps'), '');
});
check('does not strip arbitrary leading words', () => {
  // "Heritage" alone (brand prefix already absent) survives intact.
  assert.equal(normalizeSetValue('Heritage', 'Topps'), 'Heritage');
  // A non-brand leading word is preserved — only the actual brand is stripped.
  assert.equal(normalizeSetValue('Bowman Chrome', 'Topps'), 'Bowman Chrome');
});
check('case-insensitive brand match', () => {
  assert.equal(normalizeSetValue('TOPPS Series One', 'Topps'), 'Series One');
  assert.equal(normalizeSetValue('topps series two', 'Topps'), 'series two');
});
check('handles brand with no trailing space (no false strip)', () => {
  // "ToppsSeries" should NOT be stripped — the regex requires a space.
  assert.equal(normalizeSetValue('ToppsSeries', 'Topps'), 'ToppsSeries');
});
check('returns trimmed value when brand is empty', () => {
  assert.equal(normalizeSetValue('  Series One  ', ''), 'Series One');
});
check('Donruss Optic flagship-style', () => {
  assert.equal(normalizeSetValue('Donruss Optic', 'Donruss'), 'Optic');
});

// ── isBaseCollection ─────────────────────────────────────────────────────

check('isBaseCollection treats null/empty as base', () => {
  assert.equal(isBaseCollection(null), true);
  assert.equal(isBaseCollection(undefined), true);
  assert.equal(isBaseCollection(''), true);
  assert.equal(isBaseCollection('   '), true);
});
check('isBaseCollection accepts "Base Set" / "Base" / sentinels', () => {
  assert.equal(isBaseCollection('Base Set'), true);
  assert.equal(isBaseCollection('base set'), true);
  assert.equal(isBaseCollection('Base'), true);
  assert.equal(isBaseCollection('None'), true);
  assert.equal(isBaseCollection('None detected'), true);
});
check('isBaseCollection rejects insert/subset names', () => {
  assert.equal(isBaseCollection('Premium Stock'), false);
  assert.equal(isBaseCollection('Stars of MLB'), false);
  assert.equal(isBaseCollection('Series One'), false); // a set name slipped into collection
  assert.equal(isBaseCollection('Topps Series One'), false);
});

// ── PRODUCT_LINES whitelist gate ─────────────────────────────────────────

check('drops non-whitelisted Upper Deck set, falls back to brand', () => {
  const combined: any = { brand: 'Upper Deck' };
  applyGeminiToCombined(combined, { set: 'Future Stock' } as any);
  assert.equal(combined.set, 'Upper Deck');
  assert.equal(combined._geminiSubset, 'Future Stock');
});

check('keeps whitelisted Topps set "Heritage"', () => {
  const combined: any = { brand: 'Topps' };
  applyGeminiToCombined(combined, { set: 'Heritage' } as any);
  assert.equal(combined.set, 'Heritage');
});

check('preserves behavior for non-whitelisted brand (Fleer → no gate)', () => {
  const combined: any = { brand: 'Fleer' };
  applyGeminiToCombined(combined, { set: 'Ultra' } as any);
  assert.equal(combined.set, 'Ultra');
});

check('does not clobber existing subset descriptor', () => {
  const combined: any = { brand: 'Upper Deck' };
  applyGeminiToCombined(combined, { set: 'Future Stock', subset: 'Team Leaders' } as any);
  assert.equal(combined.set, 'Upper Deck');
  // gemini.subset takes precedence at the bottom of applyGeminiToCombined,
  // and the gate refuses to overwrite an existing _geminiSubset.
  assert.equal(combined._geminiSubset, 'Team Leaders');
});

// ── normalizeSport ───────────────────────────────────────────────────────

check('normalizeSport maps lowercase known sport to canonical case', () => {
  assert.equal(normalizeSport('baseball'), 'Baseball');
});
check('normalizeSport maps UPPERCASE known sport to canonical case', () => {
  assert.equal(normalizeSport('FOOTBALL'), 'Football');
});
check('normalizeSport falls back to sentence-case for unknown sport', () => {
  assert.equal(normalizeSport('Cricket'), 'Cricket');
  assert.equal(normalizeSport('cricket'), 'Cricket');
});
check('normalizeSport returns empty for empty/whitespace input', () => {
  assert.equal(normalizeSport(''), '');
  assert.equal(normalizeSport('   '), '');
});
check('normalizeSport trims surrounding whitespace', () => {
  assert.equal(normalizeSport('  Hockey  '), 'Hockey');
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
