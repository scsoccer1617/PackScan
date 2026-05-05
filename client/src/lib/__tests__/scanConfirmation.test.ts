/**
 * Unit tests for the client-side confirmation helpers.
 *
 * Run via:
 *   npx tsx client/src/lib/__tests__/scanConfirmation.test.ts
 */
import assert from 'node:assert/strict';
import {
  computeConfirmationDiff,
  logScanConfirmation,
  type PredictedFields,
} from '../scanConfirmation';

let failed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok  ${name}`))
    .catch((err) => {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(err?.message || err);
    });
}

(async () => {
  // ── computeConfirmationDiff ───────────────────────────────────────────
  await check('diff: identical returns []', () => {
    const a: PredictedFields = {
      player: 'Ken Griffey Jr', year: 1989, brand: 'Upper Deck',
      set: 'Base', collection: '', cardNumber: '1', variant: '', potentialVariant: 'No',
    };
    assert.deepEqual(computeConfirmationDiff(a, { ...a }), []);
  });

  await check('diff: number vs same string is equal', () => {
    const a: PredictedFields = { year: 2026 };
    const b: PredictedFields = { year: '2026' };
    assert.deepEqual(computeConfirmationDiff(a, b), []);
  });

  await check('diff: trims whitespace', () => {
    assert.deepEqual(
      computeConfirmationDiff({ player: 'Mike Trout' }, { player: '  Mike Trout  ' }),
      [],
    );
  });

  await check('diff: null vs empty string is equal', () => {
    assert.deepEqual(
      computeConfirmationDiff({ brand: null }, { brand: '' }),
      [],
    );
  });

  await check('diff: null vs undefined is equal', () => {
    assert.deepEqual(
      computeConfirmationDiff({ brand: null }, {}),
      [],
    );
  });

  await check('diff: detects changed cardNumber', () => {
    const out = computeConfirmationDiff({ cardNumber: '101' }, { cardNumber: '102' });
    assert.deepEqual(out, ['cardNumber']);
  });

  await check('diff: detects multiple changes', () => {
    const out = computeConfirmationDiff(
      { player: 'A', year: 2020 },
      { player: 'B', year: 2021 },
    );
    assert.deepEqual(out.sort(), ['player', 'year']);
  });

  // ── logScanConfirmation ───────────────────────────────────────────────
  await check('log: returns false on missing scanId', async () => {
    const ok = await logScanConfirmation({} as any);
    assert.equal(ok, false);
  });

  await check('log: posts JSON with snake_case keys', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    (globalThis as any).fetch = async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response('{}', { status: 202 });
    };

    const ok = await logScanConfirmation({
      scanId: 's1',
      source: 'single_scan',
      predicted: { player: 'A', cardNumber: '7', potentialVariant: 'No' },
      originalConfidence: 0.91,
    });
    assert.equal(ok, true);
    assert.ok(captured, 'fetch should have been called');
    const c = captured!;
    assert.equal(c.url, '/api/scan-confirmations');
    assert.equal(c.init.method, 'POST');
    const body = JSON.parse(String(c.init.body));
    assert.equal(body.scan_id, 's1');
    assert.equal(body.source, 'single_scan');
    assert.equal(body.predicted.card_number, '7');
    assert.equal(body.predicted.potential_variant, 'No');
    assert.equal(body.original_confidence, 0.91);
  });

  await check('log: swallows fetch errors', async () => {
    (globalThis as any).fetch = async () => {
      throw new Error('network down');
    };
    const ok = await logScanConfirmation({
      scanId: 's2',
      source: 'bulk_review',
      predicted: {},
    });
    assert.equal(ok, false);
  });

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall client confirmation tests passed');
})();
