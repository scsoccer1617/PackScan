/**
 * Standalone assert-based tests for the `_vlmEmptyIdentity` provenance gate
 * added to bulk-scan's confidence evaluation. Run via:
 *
 *   npx tsx server/__tests__/confidenceGate.vlmEmptyIdentity.test.ts
 *
 * Background — bulk-39/40 audit (`empty_gemini_fallback_audit.md`) showed
 * three cards persisted with confidently-wrong identities (1992 Fleer Ultra
 * Ripken → 2026 Ultra #11, 1989 Topps Canseco → 1997 Topps #246, 1987
 * Topps Valenzuela → 1987 Topps #580 Krukow). In every case Gemini returned
 * empty year/brand/player but the legacy combiner / CardDB surname-salvage
 * loop fabricated a complete-looking tuple, and the gate auto-saved with
 * composite=100. The new flag distinguishes the two and forces review.
 */

import assert from 'node:assert/strict';
import { evaluateConfidence } from '../bulkScan/confidenceGate';

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

// A "complete-looking" analysis blob — all four core fields populated,
// no ambiguity flags. Without the new gate this auto-saves with
// composite=100. The bulk-39/40 failure rows look exactly like this.
const completeAnalysis = {
  brand: 'Topps',
  year: 1997,
  cardNumber: '246',
  playerFirstName: 'Jose',
  playerLastName: 'Canseco',
};

check('flag forces review even when all core fields populated', () => {
  const out = evaluateConfidence({
    analysis: { ...completeAnalysis, _vlmEmptyIdentity: true },
    pairingWarnings: [],
    cardDbAvailable: false,
  });
  assert.equal(out.verdict, 'review');
  assert.ok(
    out.reasons.includes('vlm_empty_identity'),
    `expected reasons to include 'vlm_empty_identity', got: ${out.reasons.join(', ')}`,
  );
});

check('flag is the ONLY reason when other fields are clean', () => {
  const out = evaluateConfidence({
    analysis: { ...completeAnalysis, _vlmEmptyIdentity: true },
    pairingWarnings: [],
    cardDbAvailable: false,
  });
  // Only the new reason should be present — nothing else is wrong.
  assert.deepEqual(out.reasons, ['vlm_empty_identity']);
});

check('without the flag, behavior is unchanged from baseline', () => {
  const out = evaluateConfidence({
    analysis: { ...completeAnalysis },
    pairingWarnings: [],
    cardDbAvailable: false,
  });
  assert.equal(out.verdict, 'auto_save');
  assert.deepEqual(out.reasons, []);
  assert.equal(out.confidenceScore, 100);
});

check('flag stacks with other reasons (does not mask them)', () => {
  const out = evaluateConfidence({
    analysis: {
      ...completeAnalysis,
      _vlmEmptyIdentity: true,
      _cardNumberLowConfidence: true,
    },
    pairingWarnings: [],
    cardDbAvailable: false,
  });
  assert.equal(out.verdict, 'review');
  assert.ok(out.reasons.includes('vlm_empty_identity'));
  assert.ok(out.reasons.includes('card_number_low_confidence'));
});

check('flag false / undefined behaves the same — no false-positive review', () => {
  for (const value of [false, undefined, null, 0]) {
    const out = evaluateConfidence({
      analysis: { ...completeAnalysis, _vlmEmptyIdentity: value as any },
      pairingWarnings: [],
      cardDbAvailable: false,
    });
    assert.equal(out.verdict, 'auto_save', `value=${String(value)} should auto_save`);
    assert.ok(
      !out.reasons.includes('vlm_empty_identity'),
      `value=${String(value)} should not push vlm_empty_identity`,
    );
  }
});

check('flag drops composite score below 100 even with all fields populated', () => {
  const out = evaluateConfidence({
    analysis: { ...completeAnalysis, _vlmEmptyIdentity: true },
    pairingWarnings: [],
    cardDbAvailable: false,
  });
  assert.ok(out.confidenceScore < 100, `expected <100, got ${out.confidenceScore}`);
});

check('cardDb corroboration on top of empty-identity still routes review', () => {
  // The salvage loop in dualSideOCR.ts can align legacy fields to a real
  // (brand, year, #) tuple in the catalog (the Canseco → 1997/#246 case),
  // so cardDbCorroborated=true on its own is no longer a free pass.
  const out = evaluateConfidence({
    analysis: { ...completeAnalysis, _vlmEmptyIdentity: true },
    pairingWarnings: [],
    cardDbAvailable: true,
    cardDbCorroborated: true,
  });
  assert.equal(out.verdict, 'review');
  assert.ok(out.reasons.includes('vlm_empty_identity'));
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
