/**
 * PR #252 — Conditional subset drop decision tests.
 *
 *   npx tsx server/__tests__/subsetDropDecision.test.ts
 *
 * Repo has no vitest/jest config (mirrors `vlmApply.coercion.test.ts`),
 * so this lives on `node:assert/strict`. Exits non-zero on any failed
 * assertion so a future CI gate can wire it up cheaply.
 *
 * Covers the rule from `subset_origin_trace.md` §5:
 *
 *   Drop subset ⇔ (single-player) AND (subset arrived via the
 *   `vlmApply.ts:248-254` non-whitelisted-set fallback path).
 *
 *   Keep subset for: multi-player cards (Team Leaders, Record Breakers),
 *   single-player cards with a direct `gemini.subset` field, no-subset
 *   cards, and cards with an empty/unknown player layout.
 */

import assert from 'node:assert/strict';
import { decideSubsetDrop } from '../subsetDropDecision';
import { applyGeminiToCombined } from '../vlmApply';
import { buildPickerQuery } from '../ebayPickerSearch';

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

// ── Maddux scenario (bulk-38-1020) ──────────────────────────────────────
//
// 1995 UD Collector's Choice #60 Greg Maddux — single player, subset came
// from the non-whitelisted Gemini.set ("All-Star Special Edition" → not on
// the Upper Deck PRODUCT_LINES whitelist, salvaged into `_geminiSubset` by
// `vlmApply.ts:248-254`). Drop must fire; the resulting picker query must
// not contain the All-Star tokens.
check('Maddux: 1 player + fallback path → drop fires', () => {
  const decision = decideSubsetDrop({
    playerCount: 1,
    subset: 'All-Star Special Edition',
    subsetSource: 'vlmApply-fallback',
  });
  assert.equal(decision.useSubsetInComps, false);
  assert.equal(decision.subsetSource, 'vlmApply-fallback');
  assert.equal(decision.subsetDroppedReason, 'single-player+fallback');
});

check('Maddux: dropped subset is omitted from buildPickerQuery output', () => {
  // What the server actually does at the call site: feeds empty string to
  // the picker when `useSubsetInComps=false`.
  const queryWithDrop = buildPickerQuery({
    year: '1995',
    brand: 'Upper Deck',
    set: "Collector's Choice Special Edition",
    cardNumber: '60',
    player: 'Greg Maddux',
    subset: '', // dropped
    parallel: '',
    excludeParallels: true,
  });
  const queryKept = buildPickerQuery({
    year: '1995',
    brand: 'Upper Deck',
    set: "Collector's Choice Special Edition",
    cardNumber: '60',
    player: 'Greg Maddux',
    subset: 'All-Star Special Edition',
    parallel: '',
    excludeParallels: true,
  });
  assert.ok(
    !/All-Star/i.test(queryWithDrop),
    `expected "All-Star" omitted, got: ${queryWithDrop}`
  );
  assert.ok(
    /All-Star/i.test(queryKept),
    `sanity: kept-subset query should still contain "All-Star": ${queryKept}`
  );
});

// ── Team Leaders (multi-player) ─────────────────────────────────────────
//
// 1981 Topps Reds Team Leaders — 2+ players, subset is the only
// disambiguator. Drop MUST NOT fire regardless of source path; subset must
// survive into the picker query.
check('Team Leaders: 2 players → drop does NOT fire (fallback path)', () => {
  const decision = decideSubsetDrop({
    playerCount: 2,
    subset: 'Team Leaders',
    subsetSource: 'vlmApply-fallback',
  });
  assert.equal(decision.useSubsetInComps, true);
  assert.equal(decision.subsetSource, 'vlmApply-fallback');
  assert.equal(decision.subsetDroppedReason, null);
});

check('Team Leaders: 3 players → drop does NOT fire (gemini-direct)', () => {
  const decision = decideSubsetDrop({
    playerCount: 3,
    subset: 'Team Leaders',
    subsetSource: 'gemini-direct',
  });
  assert.equal(decision.useSubsetInComps, true);
  assert.equal(decision.subsetSource, 'gemini-direct');
  assert.equal(decision.subsetDroppedReason, null);
});

check('Team Leaders: query includes subset when kept', () => {
  const query = buildPickerQuery({
    year: '1981',
    brand: 'Topps',
    set: 'Topps',
    cardNumber: '666',
    player: 'Team Leaders Reds',
    subset: 'Team Leaders',
    parallel: '',
    excludeParallels: true,
  });
  assert.ok(/Team Leaders/i.test(query), `expected "Team Leaders" present, got: ${query}`);
});

// ── Direct Gemini subset on a single-player card ────────────────────────
//
// Whitelisted path (Gemini's dedicated `subset` JSON field) is trusted
// even on a single-player card. The drop must NOT fire.
check('1 player + gemini-direct path → drop does NOT fire', () => {
  const decision = decideSubsetDrop({
    playerCount: 1,
    subset: 'Top Prospect',
    subsetSource: 'gemini-direct',
  });
  assert.equal(decision.useSubsetInComps, true);
  assert.equal(decision.subsetSource, 'gemini-direct');
  assert.equal(decision.subsetDroppedReason, null);
});

// ── No subset at all ────────────────────────────────────────────────────
check('1 player, no subset → no-op, telemetry records source=null', () => {
  const decision = decideSubsetDrop({
    playerCount: 1,
    subset: '',
    subsetSource: null,
  });
  assert.equal(decision.useSubsetInComps, true);
  assert.equal(decision.subsetSource, null);
  assert.equal(decision.subsetDroppedReason, null);
});

check('1 player, undefined subset → no-op', () => {
  const decision = decideSubsetDrop({
    playerCount: 1,
    subset: undefined,
    subsetSource: null,
  });
  assert.equal(decision.useSubsetInComps, true);
  assert.equal(decision.subsetSource, null);
  assert.equal(decision.subsetDroppedReason, null);
});

// ── Edge: empty player list ─────────────────────────────────────────────
//
// A scan where `players[]` is empty (vintage multi-player descriptor-only
// cards, or a partial Gemini parse) — preserve subset rather than risk
// collapsing a query whose layout we never observed.
check('Empty player list → drop does NOT fire (subset preserved)', () => {
  const decision = decideSubsetDrop({
    playerCount: 0,
    subset: 'All-Star',
    subsetSource: 'vlmApply-fallback',
  });
  assert.equal(decision.useSubsetInComps, true);
  assert.equal(decision.subsetDroppedReason, null);
});

// ── Source-tag wiring: vlmApply must stamp the discriminator ────────────
//
// These bolt the unit-level decision tests to the actual upstream that
// produces the source. If `applyGeminiToCombined` ever stops tagging the
// fallback path, `decideSubsetDrop` would silently see `subsetSource=null`
// and the Maddux drop would never fire. Catch that here.
check('vlmApply: fallback path stamps _geminiSubsetSource = vlmApply-fallback', () => {
  const combined: any = { brand: 'Upper Deck' };
  applyGeminiToCombined(combined, { set: 'Future Stock' } as any);
  assert.equal(combined._geminiSubset, 'Future Stock');
  assert.equal(combined._geminiSubsetSource, 'vlmApply-fallback');
});

check('vlmApply: dedicated subset field stamps _geminiSubsetSource = gemini-direct', () => {
  const combined: any = { brand: 'Topps' };
  applyGeminiToCombined(combined, { subset: 'Team Leaders' } as any);
  assert.equal(combined._geminiSubset, 'Team Leaders');
  assert.equal(combined._geminiSubsetSource, 'gemini-direct');
});

check('vlmApply: gemini-direct overwrites vlmApply-fallback when both fire', () => {
  // Non-whitelisted set + dedicated subset on the same emit → direct wins
  // (it runs after the fallback in the function body).
  const combined: any = { brand: 'Upper Deck' };
  applyGeminiToCombined(combined, {
    set: 'Future Stock',
    subset: 'Team Leaders',
  } as any);
  assert.equal(combined._geminiSubset, 'Team Leaders');
  assert.equal(combined._geminiSubsetSource, 'gemini-direct');
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
