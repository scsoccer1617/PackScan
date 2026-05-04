/**
 * PR W — regression: result page must render price + "Browse on eBay"
 * URL from the SAME pool the server already computed for chip 3, not
 * from a redundant mount-time fetch through a different eBay code path.
 *
 * Pre-PR-W bug (5 affected scan IDs incl. 1e88718c, 0fb94a97, a5b6d653,
 * e17fb9f6, 16aa7526): chip 3 turned green because the server's
 * `pickerSearch` (best-match relevance) returned ≥1 listing, but the
 * mount-time `/api/ebay/comps/summary` fetch (newlyListed/BIN-only) for
 * the same identity returned 0 — so the result page rendered no price
 * and no eBay search URL even though the chip claimed "verified".
 *
 * The fix: the analyze handler awaits its own `getCompsSummary`
 * pre-fire and binds the result to `data.summary`. EbayActiveComps
 * consumes that as a fast-path: when liveKey === serverKey, render
 * the listings/query/mean directly and skip the mount-time fetch
 * entirely. Same pool, no divergence.
 *
 * This test asserts:
 *   1. `getCompsSummary` returns a stable, well-formed shape callers
 *      can plumb through to the response.
 *   2. The shape carries a non-empty `query` whenever any listing
 *      survives the precision filter — so the result page can build
 *      the "Browse all on eBay" URL even when count===0 isn't the
 *      case (count > 0 means both `mean` and `query` are populated).
 *   3. A pre-fired summary written to cache is what a subsequent
 *      identical call resolves to — the same plumbing the response
 *      now leans on.
 *
 * Run via: npx tsx server/__tests__/prWEbaySummaryFastPath.test.ts
 */

import assert from 'node:assert/strict';

process.env.EBAY_BROWSE_TOKEN = process.env.EBAY_BROWSE_TOKEN || 'test-token';

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

// Simulate the Browse API returning a Gold-parallel listing matching
// the precision filter (cardNum=100, lastName=smith).
const goldListing = {
  title: '2026 Topps Series 1 #100 John Smith Gold Foil /299',
  price: { value: '12.50', currency: 'USD' },
  itemWebUrl: 'https://example.com/gold-1',
  image: { imageUrl: 'https://example.com/img.jpg' },
  condition: 'Near Mint',
};
const goldListing2 = {
  title: '2026 Topps Series One #100 J. Smith Gold Parallel SP',
  price: { value: '17.50', currency: 'USD' },
  itemWebUrl: 'https://example.com/gold-2',
  image: { imageUrl: 'https://example.com/img2.jpg' },
  condition: 'New',
};

await check('summary shape has query + listings + mean for gold scan', async () => {
  _clearCompsSummaryCache();
  await withStubbedHttp(
    async () => ({ data: { itemSummaries: [goldListing, goldListing2] } }),
    async () => {
      const out = await getCompsSummary(
        '2026 Topps Series One #100 John Smith Gold',
        {
          requireCardNumber: '100',
          requirePlayerLastName: 'smith',
          // Gold parallel scan ⇒ excludeParallels=false (no negative chain)
          excludeParallels: false,
        },
      );
      // The shape the response now binds to data.summary.
      assert.equal(typeof out.query, 'string');
      assert.ok(out.query.length > 0, 'query must be non-empty so URL builds');
      assert.equal(out.count, 2, 'both gold listings survive precision filter');
      assert.ok(out.mean !== null, 'mean must be populated');
      assert.equal(out.mean, 15, '(12.50 + 17.50) / 2');
      assert.equal(out.listings.length, 2);
      // currency forwards through so the hero price formatter renders $
      assert.equal(out.currency, 'USD');
    },
  );
});

await check('warm-cache hit eliminates the redundant http roundtrip', async () => {
  _clearCompsSummaryCache();
  let httpCalls = 0;
  await withStubbedHttp(
    async () => {
      httpCalls += 1;
      return { data: { itemSummaries: [goldListing] } };
    },
    async () => {
      const opts = {
        requireCardNumber: '100',
        requirePlayerLastName: 'smith',
        excludeParallels: false,
      };
      const a = await getCompsSummary('2026 Topps Series One #100 John Smith Gold', opts);
      assert.equal(a.count, 1);
      assert.equal(httpCalls, 1);
      // The post-mount client fetch lands on the same key — must be a
      // cache hit. This is what guarantees the chip-3 pool and the
      // result page pool are byte-identical.
      const b = await getCompsSummary('2026 Topps Series One #100 John Smith Gold', opts);
      assert.equal(b.count, 1);
      assert.equal(httpCalls, 1, 'second call must be a cache hit');
      // And the listing details survive identically.
      assert.equal(a.query, b.query);
      assert.equal(a.mean, b.mean);
    },
  );
});

await check('zero-survivor pool keeps query non-empty so URL still builds', async () => {
  // Edge case: Browse returns listings but none survive the precision
  // filter (cardNumber mismatch). Caller still gets a query string back
  // so the "Browse all on eBay" URL renders, even though count===0 and
  // the hero price stays blank. This matches the legacy mount-time
  // behaviour the result page used to depend on.
  _clearCompsSummaryCache();
  await withStubbedHttp(
    async () => ({
      data: {
        itemSummaries: [
          {
            title: '2026 Topps Series 1 #999 Different Player Gold',
            price: { value: '5.00', currency: 'USD' },
            itemWebUrl: 'https://example.com/x',
            image: { imageUrl: '' },
            condition: 'New',
          },
        ],
      },
    }),
    async () => {
      const out = await getCompsSummary(
        '2026 Topps Series One #100 John Smith Gold',
        {
          requireCardNumber: '100',
          requirePlayerLastName: 'smith',
          excludeParallels: false,
        },
      );
      assert.equal(out.count, 0, 'precision filter zeroes the pool');
      assert.equal(out.mean, null);
      assert.ok(out.query.length > 0, 'query still populated for URL');
    },
  );
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll tests passed.');
