/**
 * Tests for the /api/scan-confirmations endpoint and its helpers.
 *
 * Run via:
 *   npx tsx server/__tests__/scanConfirmations.test.ts
 */
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  registerScanConfirmationsRoutes,
  resolveReviewer,
  buildConfirmationFromRequest,
} from '../routes/scanConfirmations';
import {
  buildConfirmationRow,
  CONFIRMATION_HEADERS,
} from '../scanConfirmationsLog';

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
  // ── resolveReviewer ──────────────────────────────────────────────────
  await check('resolveReviewer: anonymous when unauth', () => {
    const r = resolveReviewer({} as any);
    assert.equal(r.reviewerRole, 'anonymous');
    assert.equal(r.reviewerId, 'anonymous');
  });

  await check('resolveReviewer: admin when ADMIN_EMAIL match', () => {
    const r = resolveReviewer({ user: { id: 1, email: 'daniel.j.holley@gmail.com' } } as any);
    assert.equal(r.reviewerRole, 'admin');
    assert.equal(r.reviewerId, 'daniel.j.holley@gmail.com');
  });

  await check('resolveReviewer: external when other email', () => {
    const r = resolveReviewer({ user: { id: 2, email: 'someone@else.com' } } as any);
    assert.equal(r.reviewerRole, 'external');
    assert.equal(r.reviewerId, 'someone@else.com');
  });

  await check('resolveReviewer: external user:<id> when no email', () => {
    const r = resolveReviewer({ user: { id: 7 } } as any);
    assert.equal(r.reviewerRole, 'external');
    assert.equal(r.reviewerId, 'user:7');
  });

  // ── buildConfirmationFromRequest ─────────────────────────────────────
  await check('build: rejects missing body', () => {
    const r = buildConfirmationFromRequest(undefined as any, { reviewerId: 'a', reviewerRole: 'admin' });
    assert.equal(r.ok, false);
  });

  await check('build: rejects missing scan_id', () => {
    const r = buildConfirmationFromRequest({ source: 'single_scan' }, {
      reviewerId: 'a', reviewerRole: 'admin',
    });
    assert.equal(r.ok, false);
  });

  await check('build: rejects bad source', () => {
    const r = buildConfirmationFromRequest(
      { scan_id: 's1', source: 'banana' },
      { reviewerId: 'a', reviewerRole: 'admin' },
    );
    assert.equal(r.ok, false);
  });

  await check('build: accepts snake_case predicted', () => {
    const r = buildConfirmationFromRequest(
      {
        scan_id: 's1',
        source: 'single_scan',
        predicted: { player: 'Mike Trout', card_number: '101', potential_variant: 'No' },
      },
      { reviewerId: 'a@b.com', reviewerRole: 'external' },
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.payload.scanId, 's1');
    assert.equal(r.payload.predictedPlayer, 'Mike Trout');
    assert.equal(r.payload.predictedCardNumber, '101');
    assert.equal(r.payload.predictedPotentialVariant, 'No');
    assert.equal(r.payload.source, 'single_scan');
    assert.equal(r.payload.reviewerRole, 'external');
    assert.match(r.payload.confirmationId, /^[0-9a-f]{8}-/);
    assert.match(r.payload.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  await check('build: accepts camelCase predicted', () => {
    const r = buildConfirmationFromRequest(
      {
        scanId: 's2',
        source: 'bulk_review',
        predicted: { cardNumber: '7', potentialVariant: 'Yes' },
      },
      { reviewerId: 'admin', reviewerRole: 'admin' },
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.payload.predictedCardNumber, '7');
    assert.equal(r.payload.predictedPotentialVariant, 'Yes');
    assert.equal(r.payload.source, 'bulk_review');
  });

  // ── buildConfirmationRow column order ────────────────────────────────
  await check('row: column count matches headers', () => {
    const row = buildConfirmationRow({
      confirmationId: 'cid',
      timestamp: '2026-01-01T00:00:00Z',
      scanId: 's',
      reviewerId: 'r',
      reviewerRole: 'admin',
      source: 'single_scan',
    });
    assert.equal(row.length, CONFIRMATION_HEADERS.length);
    assert.equal(row[0], 'cid');
    assert.equal(row[1], '2026-01-01T00:00:00Z');
    assert.equal(row[2], 's');
  });

  await check('row: numbers stringify, nulls become empty', () => {
    const row = buildConfirmationRow({
      confirmationId: 'cid',
      timestamp: 'ts',
      scanId: 's',
      reviewerId: 'r',
      reviewerRole: 'external',
      source: 'bulk_review',
      predictedYear: 2026,
      predictedPlayer: null,
      originalConfidence: 0.876,
    });
    assert.equal(row[CONFIRMATION_HEADERS.indexOf('PredictedYear')], '2026');
    assert.equal(row[CONFIRMATION_HEADERS.indexOf('PredictedPlayer')], '');
    assert.equal(row[CONFIRMATION_HEADERS.indexOf('OriginalConfidence')], '0.88');
  });

  // ── HTTP-level: endpoint returns 202, validates input, fire-and-forget ─
  // We don't connect to Sheets here — without GOOGLE_SERVICE_ACCOUNT_JSON
  // / SCAN_LOG_SHEET_ID, isConfirmationsLogEnabled() is false, so
  // appendConfirmationRow returns immediately and the route stays a
  // pure HTTP test (no real network I/O).
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.SCAN_LOG_SHEET_ID;

  const app = express();
  app.use(express.json());
  registerScanConfirmationsRoutes(app);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  await check('endpoint: 400 on missing scan_id', async () => {
    const res = await fetch(`${base}/api/scan-confirmations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'single_scan' }),
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.ok, false);
  });

  await check('endpoint: 400 on bad source', async () => {
    const res = await fetch(`${base}/api/scan-confirmations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scan_id: 's', source: 'nope' }),
    });
    assert.equal(res.status, 400);
  });

  await check('endpoint: 202 success returns confirmation_id', async () => {
    const res = await fetch(`${base}/api/scan-confirmations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scan_id: 'scan-1',
        source: 'single_scan',
        predicted: { player: 'Mike Trout', year: 2024 },
      }),
    });
    assert.equal(res.status, 202);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.match(json.confirmation_id, /^[0-9a-f]{8}-/);
  });

  await check('endpoint: fire-and-forget returns quickly', async () => {
    const t0 = Date.now();
    const res = await fetch(`${base}/api/scan-confirmations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scan_id: 'scan-2', source: 'bulk_review', predicted: {} }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 202);
    // The endpoint should return well under 500ms even with no Sheets
    // configured — this guards against an accidental `await` slipping
    // back into the handler.
    assert.ok(elapsed < 500, `expected <500ms, got ${elapsed}ms`);
  });

  server.close();
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall scan-confirmation endpoint tests passed');
})();
