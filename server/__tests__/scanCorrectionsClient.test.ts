/**
 * PR Z — unit tests for the client-side scan-corrections helper.
 *
 *   npx tsx server/__tests__/scanCorrectionsClient.test.ts
 *
 * The helper module lives under client/src/lib/scanCorrections.ts but
 * is plain TypeScript (no React, no DOM), so we exercise it directly
 * here with tsx.
 *
 * Covers:
 *  - normalizeForDiff: trim/collapse whitespace, null/undefined/'',
 *    finite numbers, booleans
 *  - computeFieldDiff: ignores no-op + whitespace-only changes,
 *    respects custom field list
 *  - postScanCorrections:
 *      - empty diff returns 0 without hitting fetch
 *      - missing scanId returns 0 without hitting fetch
 *      - successful diff posts the expected JSON shape
 *      - fetch rejection is swallowed (never throws), still returns N
 */

import assert from 'node:assert/strict';
import {
  normalizeForDiff,
  computeFieldDiff,
  postScanCorrections,
} from '../../client/src/lib/scanCorrections';

let failed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  const run = async () => {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err: any) {
      failed += 1;
      console.error(`  FAIL  ${name}`);
      console.error(err?.message ?? err);
    }
  };
  // Tests run sequentially via top-level await on the queue.
  pending.push(run);
}

const pending: Array<() => Promise<void>> = [];

// ── normalizeForDiff ───────────────────────────────────────────────────

check('normalizeForDiff: null / undefined / "" all → ""', () => {
  assert.equal(normalizeForDiff(null), '');
  assert.equal(normalizeForDiff(undefined), '');
  assert.equal(normalizeForDiff(''), '');
});

check('normalizeForDiff: trims and collapses whitespace', () => {
  assert.equal(normalizeForDiff('  hello   world  '), 'hello world');
});

check('normalizeForDiff: finite numbers stringify, NaN → ""', () => {
  assert.equal(normalizeForDiff(2024), '2024');
  assert.equal(normalizeForDiff(NaN), '');
  assert.equal(normalizeForDiff(Infinity), '');
});

check('normalizeForDiff: booleans → "true"/"false"', () => {
  assert.equal(normalizeForDiff(true), 'true');
  assert.equal(normalizeForDiff(false), 'false');
});

// ── computeFieldDiff ───────────────────────────────────────────────────

check('computeFieldDiff: identical maps → []', () => {
  const diff = computeFieldDiff(
    { player: 'A', year: 2024 },
    { player: 'A', year: 2024 },
  );
  assert.deepEqual(diff, []);
});

check('computeFieldDiff: whitespace-only change is ignored', () => {
  const diff = computeFieldDiff(
    { player: 'Mike Trout' },
    { player: '  Mike   Trout  ' },
  );
  assert.deepEqual(diff, []);
});

check('computeFieldDiff: real change emits one entry per field', () => {
  const diff = computeFieldDiff(
    { player: 'A', year: 2023 },
    { player: 'A', year: 2024 },
  );
  assert.deepEqual(diff, [
    { field: 'year', original_value: '2023', corrected_value: '2024' },
  ]);
});

check('computeFieldDiff: respects custom fields list', () => {
  const diff = computeFieldDiff(
    { random: 'x' } as any,
    { random: 'y' } as any,
    ['random'],
  );
  assert.deepEqual(diff, [
    { field: 'random', original_value: 'x', corrected_value: 'y' },
  ]);
});

check('computeFieldDiff: null/undefined/"" treated as equal across types', () => {
  const diff = computeFieldDiff(
    { player: null, year: undefined },
    { player: '', year: '' },
  );
  assert.deepEqual(diff, []);
});

// ── postScanCorrections ────────────────────────────────────────────────

function makeFetchSpy() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = ((url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify({ success: true, count: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

check('postScanCorrections: empty diff returns 0 and does not fetch', async () => {
  const { fetcher, calls } = makeFetchSpy();
  const n = await postScanCorrections(
    {
      scanId: 'abc',
      source: 'single_scan',
      original: { player: 'A' },
      edited: { player: 'A' },
    },
    fetcher,
  );
  assert.equal(n, 0);
  assert.equal(calls.length, 0);
});

check('postScanCorrections: missing scanId returns 0 without fetching', async () => {
  const { fetcher, calls } = makeFetchSpy();
  const n = await postScanCorrections(
    {
      scanId: '',
      source: 'single_scan',
      original: { player: 'A' },
      edited: { player: 'B' },
    },
    fetcher,
  );
  assert.equal(n, 0);
  assert.equal(calls.length, 0);
});

check('postScanCorrections: real diff posts expected JSON', async () => {
  const { fetcher, calls } = makeFetchSpy();
  const n = await postScanCorrections(
    {
      scanId: 'scan-1',
      source: 'bulk_review',
      original: { player: 'A', year: 2023 },
      edited: { player: 'A', year: 2024 },
      frontImageUrl: '/front.jpg',
      originalConfidence: 0.5,
    },
    fetcher,
  );
  assert.equal(n, 1);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, '/api/scan-corrections');
  assert.equal(call.init?.method, 'POST');
  const body = JSON.parse(String(call.init?.body));
  assert.equal(body.scan_id, 'scan-1');
  assert.equal(body.source, 'bulk_review');
  assert.equal(body.front_image_url, '/front.jpg');
  assert.equal(body.original_confidence, 0.5);
  assert.equal(body.corrections.length, 1);
  assert.equal(body.corrections[0].field, 'year');
});

check('postScanCorrections: fetch rejection is swallowed (no throw)', async () => {
  const fetcher = (() => Promise.reject(new Error('network down'))) as unknown as typeof fetch;
  const origWarn = console.warn;
  console.warn = () => {}; // silence the helper's warn for this test
  try {
    const n = await postScanCorrections(
      {
        scanId: 'scan-1',
        source: 'single_scan',
        original: { player: 'A' },
        edited: { player: 'B' },
      },
      fetcher,
    );
    assert.equal(n, 1);
  } finally {
    console.warn = origWarn;
  }
});

// ── runner ─────────────────────────────────────────────────────────────

(async () => {
  for (const fn of pending) await fn();
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall tests passed');
})();
