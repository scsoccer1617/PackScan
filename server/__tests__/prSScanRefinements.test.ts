/**
 * PR S — Tests for the three streaming-scan refinements that landed
 * after PR R: sequenced field reveal, Set+Collection in headers, and
 * de-duplication of the streaming-confirm + post-completion modals.
 *
 * The reducers / pure helpers under test are mirrored from the
 * components so this file exercises the same logic without spinning
 * up React.
 *
 * Coverage:
 *  - Item 1: shouldRevealFieldAt sequences fields in reading order;
 *    reduced-motion bypass reveals all fields immediately.
 *  - Item 2: describeFields renders Year · Brand · Set · Collection
 *    · # · Player. buildResultHeaderDescription does the same on the
 *    final-result page using the cardData shape.
 *  - Item 3: decideStreamingPostScan returns the correct branch for
 *    each (streamingConfirmAnswered, parallelConfirmedInStream) pair
 *    so the legacy modal is skipped on streaming-No / streaming-Yes
 *    but still fires when the modal never answered.
 *
 * Run via:
 *   npx tsx server/__tests__/prSScanRefinements.test.ts
 */

import assert from 'node:assert/strict';
import {
  shouldRevealFieldAt,
  SCAN_INFO_HEADER_FIELD_ORDER,
} from '../../client/src/components/ScanInfoHeader';
import { describeFields } from '../../client/src/pages/Scan';
import {
  buildResultHeaderDescription,
  decideStreamingPostScan,
} from '../../client/src/pages/ScanResult';

let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

// ── Item 1: sequenced field reveal ──────────────────────────────────────
check(
  'shouldRevealFieldAt: reveals fields in order as revealedCount grows',
  () => {
    // revealedCount = 0 → no fields revealed
    for (let i = 0; i < SCAN_INFO_HEADER_FIELD_ORDER.length; i++) {
      assert.equal(
        shouldRevealFieldAt({ fieldIndex: i, revealedCount: 0 }),
        false,
      );
    }
    // revealedCount = 3 → fields 0,1,2 revealed; 3,4,5 hidden
    assert.equal(shouldRevealFieldAt({ fieldIndex: 0, revealedCount: 3 }), true);
    assert.equal(shouldRevealFieldAt({ fieldIndex: 2, revealedCount: 3 }), true);
    assert.equal(shouldRevealFieldAt({ fieldIndex: 3, revealedCount: 3 }), false);
    assert.equal(shouldRevealFieldAt({ fieldIndex: 5, revealedCount: 3 }), false);
  },
);

check(
  'shouldRevealFieldAt: revealedCount === total reveals every field',
  () => {
    const total = SCAN_INFO_HEADER_FIELD_ORDER.length;
    for (let i = 0; i < total; i++) {
      assert.equal(
        shouldRevealFieldAt({ fieldIndex: i, revealedCount: total }),
        true,
      );
    }
  },
);

check(
  'SCAN_INFO_HEADER_FIELD_ORDER matches the locked reading order',
  () => {
    assert.deepEqual(
      [...SCAN_INFO_HEADER_FIELD_ORDER],
      ['year', 'brand', 'set', 'collection', 'cardNumber', 'player'],
    );
  },
);

// Reduced-motion bypass — modeled as: the component sets
// revealedCount = total in one step (skipping the stagger). Here we
// just assert the helper agrees that "all revealed" === "all visible".
check(
  'reduced-motion path: all fields visible when revealedCount = total',
  () => {
    const total = SCAN_INFO_HEADER_FIELD_ORDER.length;
    const visible = SCAN_INFO_HEADER_FIELD_ORDER.map((_, i) =>
      shouldRevealFieldAt({ fieldIndex: i, revealedCount: total }),
    );
    assert.deepEqual(visible, [true, true, true, true, true, true]);
  },
);

// ── Item 2: Set + Collection in headers ─────────────────────────────────
check(
  'describeFields: locked format Year · Brand · Set · Collection · # · Player',
  () => {
    assert.equal(
      describeFields({
        year: 2025,
        brand: 'Topps',
        set: 'Update Series',
        collection: 'Base Set',
        cardNumber: 'US49',
        player: 'Michael Petersen',
      }),
      '2025 · Topps · Update Series · Base Set · #US49 · Michael Petersen',
    );
  },
);

check(
  'describeFields: Set never collapsed to Collection (regression for IMG_5309)',
  () => {
    // The IMG_5309 bug rendered "Topps · Base Set · #US49" — collection
    // was substituted into the set slot. With the locked format both
    // values appear in their own slots.
    const out = describeFields({
      year: 2025,
      brand: 'Topps',
      set: 'Update Series',
      collection: 'Base Set',
      cardNumber: 'US49',
      player: 'Michael Petersen',
    });
    assert.ok(
      out.includes('Update Series'),
      `expected "Update Series" in description, got: ${out}`,
    );
    assert.ok(
      out.includes('Base Set'),
      `expected "Base Set" (Collection) in description, got: ${out}`,
    );
    // And the order must be Set BEFORE Collection.
    assert.ok(
      out.indexOf('Update Series') < out.indexOf('Base Set'),
      `expected Set before Collection, got: ${out}`,
    );
  },
);

check(
  'describeFields: empty Set/Collection slots are dropped, not double-rendered',
  () => {
    assert.equal(
      describeFields({
        year: 2025,
        brand: 'Topps',
        set: 'Update Series',
        // collection missing
        cardNumber: 'US49',
        player: 'Michael Petersen',
      }),
      '2025 · Topps · Update Series · #US49 · Michael Petersen',
    );
    assert.equal(
      describeFields({
        year: 2025,
        brand: 'Topps',
        // set + collection missing
        cardNumber: 'US49',
        player: 'Michael Petersen',
      }),
      '2025 · Topps · #US49 · Michael Petersen',
    );
  },
);

check(
  'buildResultHeaderDescription: locked format on the final-result page',
  () => {
    assert.equal(
      buildResultHeaderDescription({
        year: 2025,
        brand: 'Topps',
        set: 'Update Series',
        collection: 'Base Set',
        cardNumber: 'US49',
        playerFirstName: 'Michael',
        playerLastName: 'Petersen',
      }),
      '2025 · Topps · Update Series · Base Set · #US49 · Michael Petersen',
    );
  },
);

check(
  'buildResultHeaderDescription: regression — collection NOT substituted into set slot',
  () => {
    // IMG_5309 reproduced: Set="Update Series" was missing and the
    // header rendered "Topps · Base Set · …". With the helper, Set
    // and Collection occupy two distinct slots.
    const out = buildResultHeaderDescription({
      year: 2025,
      brand: 'Topps',
      set: 'Update Series',
      collection: 'Base Set',
      cardNumber: 'US49',
      playerFirstName: 'Michael',
      playerLastName: 'Petersen',
    });
    const setIdx = out.indexOf('Update Series');
    const colIdx = out.indexOf('Base Set');
    assert.ok(setIdx >= 0 && colIdx >= 0 && setIdx < colIdx);
  },
);

check(
  'buildResultHeaderDescription: playerOverride wins when supplied',
  () => {
    assert.equal(
      buildResultHeaderDescription(
        {
          year: 2025,
          brand: 'Topps',
          set: 'Update Series',
          collection: 'Base Set',
          cardNumber: 'US49',
          playerFirstName: 'Michael',
          playerLastName: 'Petersen',
        },
        'Bench / Yastrzemski',
      ),
      '2025 · Topps · Update Series · Base Set · #US49 · Bench / Yastrzemski',
    );
  },
);

check(
  'buildResultHeaderDescription: null/undefined cardData yields empty string',
  () => {
    assert.equal(buildResultHeaderDescription(null), '');
    assert.equal(buildResultHeaderDescription(undefined), '');
  },
);

// ── Item 3: dedupe streaming + post-completion confirm modals ───────────
check(
  'decideStreamingPostScan: streaming Yes → skipToPricing',
  () => {
    assert.equal(
      decideStreamingPostScan({
        streamingConfirmAnswered: true,
        parallelConfirmedInStream: true,
      }),
      'skipToPricing',
    );
  },
);

check(
  'decideStreamingPostScan: streaming No → openFreetext (skip Yes/No re-prompt)',
  () => {
    assert.equal(
      decideStreamingPostScan({
        streamingConfirmAnswered: true,
        parallelConfirmedInStream: false,
      }),
      'openFreetext',
    );
  },
);

check(
  'decideStreamingPostScan: streaming modal never answered → fallback to legacy',
  () => {
    assert.equal(
      decideStreamingPostScan({
        streamingConfirmAnswered: false,
        parallelConfirmedInStream: null,
      }),
      'fallback',
    );
  },
);

check(
  'decideStreamingPostScan: defensive — answered=false ignores stale parallelConfirmed',
  () => {
    // If the flag plumbing somehow desyncs (e.g. answered=false but a
    // stale true got captured), still return fallback. Only a true
    // streaming-answer should suppress the legacy flow.
    assert.equal(
      decideStreamingPostScan({
        streamingConfirmAnswered: false,
        parallelConfirmedInStream: true,
      }),
      'fallback',
    );
    assert.equal(
      decideStreamingPostScan({
        streamingConfirmAnswered: false,
        parallelConfirmedInStream: false,
      }),
      'fallback',
    );
  },
);

check(
  'decideStreamingPostScan: answered=true with null answer → fallback (defensive)',
  () => {
    // Defensive: an "answered=true but null" tuple shouldn't happen
    // (the Scan.tsx wiring only flips answered=true once Yes/No
    // resolves), but the helper falls through rather than crashes.
    assert.equal(
      decideStreamingPostScan({
        streamingConfirmAnswered: true,
        parallelConfirmedInStream: null,
      }),
      'fallback',
    );
  },
);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll PR S streaming-scan refinements tests passed.');
