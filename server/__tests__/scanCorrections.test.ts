/**
 * PR Z — unit tests for the scan-corrections endpoint helpers.
 *
 *   npx tsx server/__tests__/scanCorrections.test.ts
 *
 * Covers:
 *  - resolveReviewer: admin / external / anonymous resolution
 *  - buildCorrectionEvents:
 *      - rejects missing scan_id
 *      - rejects unknown source
 *      - drops no-op corrections (original === corrected after coercion)
 *      - drops corrections with empty/missing field
 *      - emits one row per real diff with UUID + ISO timestamp shape
 */

import assert from 'node:assert/strict';
import {
  resolveReviewer,
  buildCorrectionEvents,
  type ResolvedReviewer,
} from '../routes/scanCorrections';

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(err?.message ?? err);
  }
}

// ── resolveReviewer ────────────────────────────────────────────────────

function fakeReq(opts: {
  authed?: boolean;
  email?: string | null;
  id?: string | number | null;
}): any {
  return {
    isAuthenticated: () => !!opts.authed,
    user: opts.authed
      ? { email: opts.email ?? undefined, id: opts.id ?? undefined }
      : undefined,
  };
}

check('resolveReviewer: unauthenticated → anonymous', () => {
  const r = resolveReviewer(fakeReq({ authed: false }));
  assert.deepEqual(r, { reviewerId: 'anonymous', reviewerRole: 'anonymous' });
});

check('resolveReviewer: missing isAuthenticated fn → anonymous', () => {
  const r = resolveReviewer({} as any);
  assert.deepEqual(r, { reviewerId: 'anonymous', reviewerRole: 'anonymous' });
});

check('resolveReviewer: authed admin email → admin role', () => {
  const r = resolveReviewer(
    fakeReq({ authed: true, email: 'daniel.j.holley@gmail.com' }),
  );
  assert.equal(r.reviewerRole, 'admin');
  assert.equal(r.reviewerId, 'daniel.j.holley@gmail.com');
});

check('resolveReviewer: admin email is case-insensitive', () => {
  const r = resolveReviewer(
    fakeReq({ authed: true, email: 'Daniel.J.Holley@GMAIL.com' }),
  );
  assert.equal(r.reviewerRole, 'admin');
});

check('resolveReviewer: authed non-admin email → external', () => {
  const r = resolveReviewer(
    fakeReq({ authed: true, email: 'someone-else@example.com' }),
  );
  assert.deepEqual(r, {
    reviewerId: 'someone-else@example.com',
    reviewerRole: 'external',
  });
});

check('resolveReviewer: authed with only id → external user:<id>', () => {
  const r = resolveReviewer(fakeReq({ authed: true, id: 42 }));
  assert.deepEqual(r, { reviewerId: 'user:42', reviewerRole: 'external' });
});

check('resolveReviewer: authed but blank user → anonymous', () => {
  const r = resolveReviewer(fakeReq({ authed: true }));
  assert.deepEqual(r, { reviewerId: 'anonymous', reviewerRole: 'anonymous' });
});

// ── buildCorrectionEvents ──────────────────────────────────────────────

const REVIEWER: ResolvedReviewer = {
  reviewerId: 'tester@example.com',
  reviewerRole: 'external',
};
const NOW = new Date('2026-05-05T12:00:00.000Z');

check('buildCorrectionEvents: missing scan_id throws', () => {
  assert.throws(
    () =>
      buildCorrectionEvents(
        { source: 'single_scan', corrections: [] },
        REVIEWER,
        NOW,
      ),
    /scan_id/,
  );
});

check('buildCorrectionEvents: bad source throws', () => {
  assert.throws(
    () =>
      buildCorrectionEvents(
        { scan_id: 'abc', source: 'whatever', corrections: [] },
        REVIEWER,
        NOW,
      ),
    /source/,
  );
});

check('buildCorrectionEvents: empty corrections array yields no events', () => {
  const events = buildCorrectionEvents(
    { scan_id: 'abc', source: 'single_scan', corrections: [] },
    REVIEWER,
    NOW,
  );
  assert.deepEqual(events, []);
});

check('buildCorrectionEvents: drops no-op (original === corrected)', () => {
  const events = buildCorrectionEvents(
    {
      scan_id: 'abc',
      source: 'single_scan',
      corrections: [{ field: 'year', original_value: '2024', corrected_value: '2024' }],
    },
    REVIEWER,
    NOW,
  );
  assert.equal(events.length, 0);
});

check('buildCorrectionEvents: drops corrections with empty field', () => {
  const events = buildCorrectionEvents(
    {
      scan_id: 'abc',
      source: 'single_scan',
      corrections: [
        { field: '', original_value: 'x', corrected_value: 'y' },
        { field: '   ', original_value: 'x', corrected_value: 'y' },
      ],
    },
    REVIEWER,
    NOW,
  );
  assert.equal(events.length, 0);
});

check('buildCorrectionEvents: emits one row per real diff with UUID + ISO ts', () => {
  const events = buildCorrectionEvents(
    {
      scan_id: 'scan-123',
      source: 'bulk_review',
      corrections: [
        { field: 'year', original_value: 2023, corrected_value: 2024 },
        { field: 'player', original_value: 'A', corrected_value: 'B' },
      ],
    },
    REVIEWER,
    NOW,
  );
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(e.scanId, 'scan-123');
    assert.equal(e.source, 'bulk_review');
    assert.equal(e.reviewerId, 'tester@example.com');
    assert.equal(e.reviewerRole, 'external');
    assert.equal(e.timestamp, '2026-05-05T12:00:00.000Z');
    // UUID v4 shape (8-4-4-4-12 hex)
    assert.match(e.correctionId, /^[0-9a-f-]{36}$/i);
  }
  assert.equal(events[0].field, 'year');
  assert.equal(events[0].originalValue, '2023');
  assert.equal(events[0].correctedValue, '2024');
});

check('buildCorrectionEvents: passes through optional context fields', () => {
  const events = buildCorrectionEvents(
    {
      scan_id: 'abc',
      source: 'single_scan',
      front_image_url: 'http://x/front.jpg',
      back_image_url: 'http://x/back.jpg',
      original_confidence: 0.87,
      notes: 'manual',
      corrections: [{ field: 'brand', original_value: 'Topps', corrected_value: 'Bowman' }],
    },
    REVIEWER,
    NOW,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].frontImageUrl, 'http://x/front.jpg');
  assert.equal(events[0].backImageUrl, 'http://x/back.jpg');
  assert.equal(events[0].originalConfidence, 0.87);
  assert.equal(events[0].notes, 'manual');
});

check('buildCorrectionEvents: filters out non-finite confidence', () => {
  const events = buildCorrectionEvents(
    {
      scan_id: 'abc',
      source: 'single_scan',
      original_confidence: NaN as any,
      corrections: [{ field: 'brand', original_value: 'Topps', corrected_value: 'Bowman' }],
    },
    REVIEWER,
    NOW,
  );
  assert.equal(events[0].originalConfidence, null);
});

check('buildCorrectionEvents: ignores non-array corrections gracefully', () => {
  const events = buildCorrectionEvents(
    { scan_id: 'abc', source: 'single_scan', corrections: 'oops' as any },
    REVIEWER,
    NOW,
  );
  assert.deepEqual(events, []);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
