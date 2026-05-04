/**
 * Variant-detection regex unit tests.
 *
 *   npx tsx server/__tests__/variantDetection.test.ts
 *
 * Repo has no vitest/jest config (mirrors `subsetDropDecision.test.ts`),
 * so this lives on `node:assert/strict`. Exits non-zero on any failed
 * assertion so a future CI gate can wire it up cheaply.
 *
 * Covers the spec at /home/user/workspace/variant_detection_spec.md:
 * threshold = any single matched listing flips to Yes, plus the one
 * acknowledged-false-positive case ("Starting Pitcher SP") and a
 * negative-control case the user provided ("Andy Van Slyke #18 Pirates").
 */

import assert from 'node:assert/strict';
import { detectPotentialVariant } from '../variantDetection';

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err: any) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(err?.stack ?? err);
  }
}

// Each scarcity / variation / error term should fire on its own.
const positives: Array<[string, string]> = [
  ['SP scarcity code', '2024 Topps Chrome #150 Aaron Judge SP'],
  ['SSP scarcity code', '2024 Topps Chrome #150 Aaron Judge SSP'],
  ['SSSP scarcity code', '2024 Topps Chrome #150 Aaron Judge SSSP'],
  ['USSP scarcity code', '2024 Topps Chrome #150 Aaron Judge USSP'],
  ['case hit phrase', '2024 Bowman Chrome Case Hit Auto'],
  ['ssp case hit phrase', '2024 Topps SSP Case Hit Variation'],
  ['photo variation', '2023 Topps #1 Mike Trout Photo Variation'],
  ['image variation', '2022 Topps Image Variation Vladimir Guerrero'],
  ['action variation', 'Action Variation Aaron Judge 2024'],
  ['nickname variation', 'Nickname Variation Shohei Ohtani 2024'],
  ['variation generic', '1989 Donruss Diamond Kings Variation'],
  ['variant generic', 'Topps Chrome Refractor Variant'],
  ['gimmick', '2010 Topps Gimmick Card Manny Ramirez'],
  ['error', 'Donruss Error Card Frank Thomas RC'],
  ['corrected', 'Donruss Corrected Card Frank Thomas RC'],
];

for (const [label, title] of positives) {
  check(`positive: ${label}`, () => {
    const r = detectPotentialVariant([title]);
    assert.equal(r.isPotentialVariant, true, `expected match on "${title}"`);
    assert.equal(r.matchedListingCount, 1);
    assert.ok(r.matchedTerms.length > 0);
  });
}

// Acknowledged-false-positive case: SP as "Starting Pitcher" is in the
// vocab and the user accepts the noise (spec §"False positives").
check('false-positive: Starting Pitcher SP still fires', () => {
  const r = detectPotentialVariant(['Starting Pitcher SP Topps Card']);
  assert.equal(r.isPotentialVariant, true);
  assert.ok(r.matchedTerms.includes('sp'));
});

// Empty input: not a variant, empty arrays.
check('empty input → all defaults', () => {
  const r = detectPotentialVariant([]);
  assert.deepEqual(r, {
    isPotentialVariant: false,
    matchedTerms: [],
    matchedListingCount: 0,
  });
});

// Negative control from the spec / user examples — should NOT fire.
check('negative: Andy Van Slyke base card', () => {
  const r = detectPotentialVariant(['Andy Van Slyke #18 Pirates']);
  assert.equal(r.isPotentialVariant, false);
  assert.equal(r.matchedTerms.length, 0);
  assert.equal(r.matchedListingCount, 0);
});

// Multi-listing: only one of N listings matches → Yes (threshold A).
check('multi-listing: any-single-match flips to Yes', () => {
  const titles = [
    'Andy Van Slyke #18 Pirates',
    'Topps Chrome #1 Mookie Betts',
    '2024 Topps Chrome #150 Aaron Judge SSP',
    'Albert Pujols Cardinals 2003',
  ];
  const r = detectPotentialVariant(titles);
  assert.equal(r.isPotentialVariant, true);
  assert.equal(r.matchedListingCount, 1);
  assert.ok(r.matchedTerms.includes('ssp'));
});

// Multi-listing: two listings match different terms.
check('multi-listing: two listings, two distinct terms', () => {
  const titles = [
    '1989 Donruss Frank Thomas Error Card RC',
    'Topps Chrome Photo Variation Mike Trout',
    'Andy Van Slyke #18 Pirates',
  ];
  const r = detectPotentialVariant(titles);
  assert.equal(r.isPotentialVariant, true);
  assert.equal(r.matchedListingCount, 2);
  assert.ok(r.matchedTerms.includes('error'));
  assert.ok(r.matchedTerms.includes('photo variation'));
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll variantDetection tests passed.');
