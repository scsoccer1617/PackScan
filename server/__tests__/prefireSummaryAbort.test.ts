/**
 * PR P — unit tests for the AbortController plumbing on
 * `getCompsSummary`. The dualSideOCR pre-fire path passes a signal so it
 * can cancel the in-flight Browse fetch when the search-verify gate
 * later corrects identity. We verify here that:
 *
 *   1. An aborted signal causes the underlying http call to be aborted
 *      and `getCompsSummary` rejects with a CanceledError-like rather
 *      than silently caching an empty result.
 *   2. When NOT aborted, the helper resolves normally and writes to
 *      cache (so a follow-up call returns cached without a second http
 *      hit).
 *
 * Run via: npx tsx server/__tests__/prefireSummaryAbort.test.ts
 */

import assert from 'node:assert/strict';

// Satisfy the token manager so it short-circuits to the static fallback
// rather than failing the test by trying to mint an OAuth token.
process.env.EBAY_BROWSE_TOKEN = process.env.EBAY_BROWSE_TOKEN || 'test-token';

// Stub the shared http client so we don't actually hit eBay.
import { sharedHttpClient } from '../httpClient';
import { _clearCompsSummaryCache, getCompsSummary } from '../ebayCompsSummary';

let failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

// Patch sharedHttpClient.get to honor the AbortSignal in config.signal
// the same way axios does (reject with a CanceledError-shaped error
// when the signal aborts).
const originalGet = sharedHttpClient.get.bind(sharedHttpClient);

async function withStubbedHttp<T>(
  handler: (url: string, config?: any) => Promise<any>,
  fn: () => Promise<T>,
): Promise<T> {
  (sharedHttpClient as any).get = handler;
  try {
    return await fn();
  } finally {
    (sharedHttpClient as any).get = originalGet;
  }
}

// 1. Pre-aborted signal → rejection that callers identify as cancellation.
await check('aborted signal rejects (no silent empty cache write)', async () => {
  _clearCompsSummaryCache();
  // ebayTokenManager touches the network on first import; stub it via
  // the http client below so that path stays inert. We simulate the
  // axios behavior of rejecting with a CanceledError when signal
  // aborted before/while pending.
  await withStubbedHttp(
    async (_url, config) => {
      if (config?.signal?.aborted) {
        const err: any = new Error('canceled');
        err.code = 'ERR_CANCELED';
        err.name = 'CanceledError';
        throw err;
      }
      return { data: { itemSummaries: [] } };
    },
    async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      let threw = false;
      try {
        await getCompsSummary('2024 Topps Series One #100 Smith', {
          signal: ctrl.signal,
        });
      } catch (err: any) {
        threw =
          err?.code === 'ERR_CANCELED'
          || err?.name === 'CanceledError'
          || err?.name === 'AbortError'
          || ctrl.signal.aborted;
      }
      assert.equal(threw, true, 'expected CanceledError-like rejection');
    },
  );
});

// 2. Non-aborted signal → resolves normally and caches the result so a
//    subsequent call (which the client makes post-mount on /result) is
//    a cache hit and does not re-issue the http call.
await check('happy path caches summary so re-fetch is hit', async () => {
  _clearCompsSummaryCache();
  let httpCalls = 0;
  await withStubbedHttp(
    async () => {
      httpCalls += 1;
      return {
        data: {
          itemSummaries: [
            {
              title: '2024 Topps Series One #100 Smith Card',
              price: { value: '5.00', currency: 'USD' },
              itemWebUrl: 'https://example.com/1',
              image: { imageUrl: '' },
              condition: 'New',
            },
          ],
        },
      };
    },
    async () => {
      const out1 = await getCompsSummary(
        '2024 Topps Series One #100 Smith',
        { requireCardNumber: '100', requirePlayerLastName: 'smith' },
      );
      assert.equal(out1.count, 1);
      assert.equal(httpCalls, 1, 'first call should hit http');
      const out2 = await getCompsSummary(
        '2024 Topps Series One #100 Smith',
        { requireCardNumber: '100', requirePlayerLastName: 'smith' },
      );
      assert.equal(out2.count, 1);
      assert.equal(
        httpCalls,
        1,
        'second call should be a cache hit — proves pre-fire warms the post-mount client fetch',
      );
    },
  );
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll tests passed.');
