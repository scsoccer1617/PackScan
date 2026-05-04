/**
 * PR K — unit tests for the unified ebayCompsSummary helper.
 * Run via:
 *
 *   npx tsx server/__tests__/ebayCompsSummary.test.ts
 *
 * Covers:
 *  - mean calc (canonical)
 *  - median calc (deprecated diagnostic, still computed)
 *  - itemPrice = price.value (NO shipping fold-in)
 *  - precision filter: card # + last name in title
 *  - empty pool returns nulls
 *  - listings array is included and capped by pool size
 *  - ensureBinFilter helper: appends LH_BIN=1, idempotent, handles
 *    URLs with and without an existing query string
 */

import assert from 'node:assert/strict';
import {
  median,
  mean,
  itemPrice,
  computeSummary,
  ensureBinFilter,
  appendBaseScanNegatives,
  buildBrowseQuery,
} from '../ebayCompsSummary';

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

// ── mean / median primitives ────────────────────────────────────────────────

check('mean: simple', () => {
  assert.equal(mean([2, 4, 6]), 4);
});

check('mean: single element', () => {
  assert.equal(mean([42]), 42);
});

check('mean: empty returns null', () => {
  assert.equal(mean([]), null);
});

check('median: odd-length pool', () => {
  assert.equal(median([1, 5, 3]), 3);
});

check('median: even-length pool averages middle two', () => {
  assert.equal(median([10, 20, 30, 40]), 25);
});

check('median: empty pool returns null', () => {
  assert.equal(median([]), null);
});

// ── itemPrice (PR K: no shipping fold-in) ──────────────────────────────────

check('itemPrice: returns price.value, no shipping fold-in', () => {
  const item = {
    price: { value: '10.00' },
    shippingOptions: [{ shippingCost: { value: '4.50' } }],
  };
  // Pre-PR-K this would have been 14.5; PR K drops shipping.
  assert.equal(itemPrice(item), 10);
});

check('itemPrice: missing price → 0', () => {
  assert.equal(itemPrice({}), 0);
  assert.equal(itemPrice({ price: { value: '0' } }), 0);
});

// ── computeSummary ─────────────────────────────────────────────────────────

check('computeSummary: filters by card # + last name, computes mean (canonical)', () => {
  const items = [
    {
      title: '2025 Topps #193 Nolan Arenado',
      itemWebUrl: 'https://example.com/1',
      price: { value: '10.00', currency: 'USD' },
      shippingOptions: [{ shippingCost: { value: '5.00' } }],
    }, // 10 (PR K: shipping ignored)
    {
      title: '2025 Topps #193 Nolan Arenado RC',
      itemWebUrl: 'https://example.com/2',
      price: { value: '20.00', currency: 'USD' },
    }, // 20
    {
      title: '2025 Topps #193 Arenado SP',
      itemWebUrl: 'https://example.com/3',
      price: { value: '30.00', currency: 'USD' },
    }, // 30
    // Filtered out — wrong card number
    { title: '2025 Topps #194 Nolan Arenado', price: { value: '999' } },
    // Filtered out — wrong last name
    { title: '2025 Topps #193 Mike Trout', price: { value: '999' } },
  ];
  const summary = computeSummary(items, 'q', {
    requireCardNumber: '193',
    requirePlayerLastName: 'Arenado',
  });
  assert.equal(summary.count, 3);
  assert.equal(summary.mean, 20); // (10 + 20 + 30) / 3
  assert.equal(summary.median, 20);
  assert.equal(summary.currency, 'USD');
  // Listings array is included and contains the 3 survivors.
  assert.equal(summary.listings.length, 3);
  assert.equal(summary.listings[0].price, 10);
  assert.equal(summary.listings[0].url, 'https://example.com/1');
  // Mean equals sum(listings.price) / listings.length.
  const sum = summary.listings.reduce((s, l) => s + l.price, 0);
  assert.equal(summary.mean, sum / summary.listings.length);
});

check('computeSummary: empty pool returns nulls + empty listings', () => {
  const summary = computeSummary([], 'q');
  assert.equal(summary.count, 0);
  assert.equal(summary.mean, null);
  assert.equal(summary.median, null);
  assert.deepEqual(summary.listings, []);
});

check('computeSummary: drops zero-priced items', () => {
  const items = [
    { title: 'a', price: { value: '0' } },
    { title: 'b', price: { value: '10' } },
  ];
  const summary = computeSummary(items, 'q');
  assert.equal(summary.count, 1);
  assert.equal(summary.mean, 10);
});

check('computeSummary: card # filter strips leading #', () => {
  const items = [
    { title: 'has 42 in title', price: { value: '10' } },
    { title: 'no number', price: { value: '20' } },
  ];
  const summary = computeSummary(items, 'q', { requireCardNumber: '#42' });
  assert.equal(summary.count, 1);
  assert.equal(summary.mean, 10);
});

check('computeSummary: listings.length <= raw items, never exceeds incoming pool', () => {
  // The Browse fetch caps at limit=10; the helper does not invent
  // listings beyond the input. Asserts the bound holds when given more
  // than 10 raw items (computeSummary itself doesn't slice — slicing
  // happens at the Browse `limit=10`; this just confirms we don't grow
  // the survivor set past the input).
  const items = Array.from({ length: 12 }, (_, i) => ({
    title: `card #99 player ${i}`,
    price: { value: `${i + 1}` },
  }));
  const summary = computeSummary(items, 'q');
  assert.ok(summary.listings.length <= items.length);
  assert.equal(summary.listings.length, 12);
});

// ── ensureBinFilter ────────────────────────────────────────────────────────

check('ensureBinFilter: appends LH_BIN=1 to a URL with no query string', () => {
  assert.equal(
    ensureBinFilter('https://www.ebay.com/sch/i.html'),
    'https://www.ebay.com/sch/i.html?LH_BIN=1',
  );
});

check('ensureBinFilter: appends LH_BIN=1 to a URL with an existing query string', () => {
  assert.equal(
    ensureBinFilter('https://www.ebay.com/sch/i.html?_nkw=foo&_sop=10'),
    'https://www.ebay.com/sch/i.html?_nkw=foo&_sop=10&LH_BIN=1',
  );
});

check('ensureBinFilter: idempotent when LH_BIN=1 is already present', () => {
  const url = 'https://www.ebay.com/sch/i.html?_nkw=foo&LH_BIN=1';
  assert.equal(ensureBinFilter(url), url);
});

check('ensureBinFilter: preserves other LH_BIN values without doubling', () => {
  // If someone passes LH_BIN=0 we don't override it — we just don't
  // add a second LH_BIN. (Belt-and-suspenders: callers shouldn't
  // construct LH_BIN=0, but if they do we don't make it worse.)
  const url = 'https://www.ebay.com/sch/i.html?LH_BIN=0';
  assert.equal(ensureBinFilter(url), url);
});

check('ensureBinFilter: empty / null input → empty string', () => {
  assert.equal(ensureBinFilter(''), '');
  assert.equal(ensureBinFilter(null), '');
  assert.equal(ensureBinFilter(undefined), '');
});

// ── PR M / PR N: buildBrowseQuery + appendBaseScanNegatives ──────────────

// PR N replaces PR M's bare `-set` token with three multi-word phrase
// exclusions. The other 6 PR M tokens are unchanged.
const PR_M_KEPT_TOKENS = ['-PSA', '-BGS', '-SGC', '-CGC', '-graded', '-lot'];
const PR_N_PHRASES = ['-"complete your set"', '-"complete set"', '-"set break"'];
const ALL_BASE_TOKENS = [...PR_M_KEPT_TOKENS, ...PR_N_PHRASES];

check('buildBrowseQuery: includes the 6 kept PR M negatives when excludeParallels is undefined (default)', () => {
  const q = buildBrowseQuery('2026 Topps Series One #1 Judge');
  for (const tok of PR_M_KEPT_TOKENS) assert.ok(q.includes(tok), `missing ${tok} in ${q}`);
});

check('buildBrowseQuery: includes the 6 kept PR M negatives when excludeParallels is true', () => {
  const q = buildBrowseQuery('q', { excludeParallels: true });
  for (const tok of PR_M_KEPT_TOKENS) assert.ok(q.includes(tok), `missing ${tok} in ${q}`);
});

check('buildBrowseQuery: includes the 3 PR N phrase exclusions', () => {
  const q = buildBrowseQuery('q');
  for (const phrase of PR_N_PHRASES) {
    assert.ok(q.includes(phrase), `missing ${phrase} in ${q}`);
  }
});

check('buildBrowseQuery: PR N — does NOT contain the standalone `-set` token (PR M regression fix)', () => {
  // PR M's broad `-set` filtered out legitimate "Base Set" listings.
  // PR N replaced it with surgical phrases. The query must not contain
  // a bare `-set` token any more.
  const q = buildBrowseQuery('q');
  // A bare `-set` would appear as the substring `-set ` (followed by a
  // space) or at end-of-string. Both `-"set break"` (PR N phrase) and
  // legitimate substrings like `-set"` survive — only the standalone
  // hyphen-set with whitespace boundaries should be absent.
  assert.equal(/(^|\s)-set(\s|$)/.test(q), false, `bare -set token still in ${q}`);
});

check('buildBrowseQuery: PR N regression — query for a Base Set scan does NOT exclude the word "set"', () => {
  // A user scanning a "1992 Topps Base Set #156 Kenny Lofton" card
  // should produce a query whose negatives target only spam phrases.
  // The Browse `q` must still be willing to MATCH "Base Set" listings
  // (Browse does NOT auto-exclude words inside negative phrases when
  // those phrases are quoted multi-word). We assert the query does not
  // contain a bare `-set` and that the legitimate "Base Set" string
  // appears nowhere in the negative chain.
  const q = buildBrowseQuery('1992 Topps Base Set #156 Kenny Lofton');
  // The literal "Base Set" from the raw query is in `q` (positive part).
  assert.ok(q.includes('Base Set'), 'positive query should preserve "Base Set"');
  // No bare `-set` exclusion would clash with "Base Set" matching.
  assert.equal(/(^|\s)-set(\s|$)/.test(q), false, 'bare -set must not appear');
  // The PR N spam phrases are present.
  for (const phrase of PR_N_PHRASES) {
    assert.ok(q.includes(phrase), `missing ${phrase} in ${q}`);
  }
});

check('buildBrowseQuery: omits all base negatives when excludeParallels === false', () => {
  const q = buildBrowseQuery('q', { excludeParallels: false });
  for (const tok of ALL_BASE_TOKENS) assert.ok(!q.includes(tok), `unexpected ${tok} in ${q}`);
  // Sanity: the raw query is preserved verbatim (no chain at all).
  assert.equal(q, 'q');
});

check('buildBrowseQuery: preserves pre-PR-M base negatives alongside the new tokens', () => {
  const q = buildBrowseQuery('q');
  // Spot-check a couple of pre-PR-M tokens to make sure we didn't drop them.
  assert.ok(q.includes('-autograph'));
  assert.ok(q.includes('-refractor'));
  assert.ok(q.includes('-parallel'));
});

check('buildBrowseQuery: empty input returns empty string', () => {
  assert.equal(buildBrowseQuery(''), '');
  assert.equal(buildBrowseQuery('   '), '');
});

check('appendBaseScanNegatives: appends all kept PR M tokens + PR N phrases to _nkw', () => {
  const url = 'https://www.ebay.com/sch/i.html?_nkw=2026+Topps+Series+One&_sop=10&LH_BIN=1';
  const out = appendBaseScanNegatives(url);
  for (const tok of ALL_BASE_TOKENS) {
    const enc = encodeURIComponent(tok).replace(/%20/g, '+');
    assert.ok(
      out.includes(enc) || out.includes(tok),
      `missing ${tok} (encoded: ${enc}) in ${out}`,
    );
  }
  // Other params untouched and order preserved.
  assert.ok(out.includes('_sop=10'));
  assert.ok(out.includes('LH_BIN=1'));
  assert.ok(out.startsWith('https://www.ebay.com/sch/i.html?_nkw='));
});

check('appendBaseScanNegatives: PR N — does NOT add a bare `-set` token to _nkw', () => {
  const url = 'https://www.ebay.com/sch/i.html?_nkw=2026+Topps+Series+One';
  const out = appendBaseScanNegatives(url);
  const nkw = out.split('?')[1].split('&').find((p) => p.startsWith('_nkw='))!;
  // After splitting on `+`, no fragment should equal `-set` (the bare
  // PR M token). Note `-%22set+break%22` is split into `-%22set` and
  // `break%22` by `+`-split, but that's fine — neither equals `-set`.
  const fragments = nkw.split('+');
  assert.equal(fragments.includes('-set'), false, `bare -set fragment in ${nkw}`);
});

check('appendBaseScanNegatives: PR N — strips legacy bare `-set` from a #269-era URL and adds new phrases', () => {
  // A URL written by the previous PR (#269) would already contain `+-set`
  // somewhere in `_nkw`. PR N's helper must strip that token (so the URL
  // converges to the new chain) AND append the three phrase exclusions.
  const seeded =
    'https://www.ebay.com/sch/i.html?_nkw=2026+Topps+-PSA+-BGS+-SGC+-CGC+-graded+-lot+-set&_sop=10';
  const out = appendBaseScanNegatives(seeded);
  const nkw = out.split('?')[1].split('&').find((p) => p.startsWith('_nkw='))!;

  // Bare -set must be gone.
  const fragments = nkw.split('+');
  assert.equal(fragments.includes('-set'), false, `bare -set still in ${nkw}`);

  // The 6 kept PR M tokens are still there exactly once each.
  for (const tok of PR_M_KEPT_TOKENS) {
    const enc = encodeURIComponent(tok).replace(/%20/g, '+');
    const matches = nkw.split(enc).length - 1;
    assert.equal(matches, 1, `${tok} appears ${matches} times in ${nkw}`);
  }

  // The 3 new phrase exclusions are appended (encoded form).
  for (const phrase of PR_N_PHRASES) {
    const enc = encodeURIComponent(phrase).replace(/%20/g, '+');
    assert.ok(nkw.includes(enc), `missing ${phrase} (encoded: ${enc}) in ${nkw}`);
  }

  // Other params untouched.
  assert.ok(out.includes('_sop=10'));
});

check('appendBaseScanNegatives: idempotent — running twice equals running once', () => {
  const url = 'https://www.ebay.com/sch/i.html?_nkw=foo&_sop=10';
  const once = appendBaseScanNegatives(url);
  const twice = appendBaseScanNegatives(once);
  assert.equal(twice, once);
});

check('appendBaseScanNegatives: idempotent against the legacy #269-era URL after one converge', () => {
  // First pass: strip legacy -set, add PR N phrases. Second pass: same.
  const seeded =
    'https://www.ebay.com/sch/i.html?_nkw=foo+-PSA+-BGS+-SGC+-CGC+-graded+-lot+-set';
  const once = appendBaseScanNegatives(seeded);
  const twice = appendBaseScanNegatives(once);
  assert.equal(twice, once);
});

check('appendBaseScanNegatives: idempotent vs already-encoded space (%20)', () => {
  // Pre-existing %20-encoded chain — second pass must not re-add tokens.
  const seeded =
    'https://www.ebay.com/sch/i.html?_nkw=foo%20-PSA%20-BGS%20-SGC%20-CGC%20-graded%20-lot';
  const out = appendBaseScanNegatives(seeded);
  const nkw = out.split('?')[1].split('&').find((p) => p.startsWith('_nkw='))!;
  for (const tok of PR_M_KEPT_TOKENS) {
    // tok is e.g. `-PSA` → look for both `+-PSA` and `%20-PSA` count.
    const re = new RegExp(`(\\+|%20)${tok.replace(/[-]/g, '\\-')}(?=\\+|%20|$)`, 'gi');
    const matches = nkw.match(re) || [];
    assert.equal(matches.length, 1, `${tok} appears ${matches.length} times in ${nkw}`);
  }
});

check('appendBaseScanNegatives: empty / null / undefined → empty string', () => {
  assert.equal(appendBaseScanNegatives(''), '');
  assert.equal(appendBaseScanNegatives(null), '');
  assert.equal(appendBaseScanNegatives(undefined), '');
});

check('appendBaseScanNegatives: URL with no query string returned unchanged', () => {
  // No _nkw to mutate — leave the URL alone.
  const url = 'https://www.ebay.com/sch/i.html';
  assert.equal(appendBaseScanNegatives(url), url);
});

check('appendBaseScanNegatives: URL with query but no _nkw returned unchanged', () => {
  const url = 'https://www.ebay.com/sch/i.html?_sop=10&LH_BIN=1';
  assert.equal(appendBaseScanNegatives(url), url);
});

check('appendBaseScanNegatives: preserves hash fragment', () => {
  const url = 'https://www.ebay.com/sch/i.html?_nkw=foo&_sop=10#anchor';
  const out = appendBaseScanNegatives(url);
  assert.ok(out.endsWith('#anchor'));
  assert.ok(out.includes('-PSA'));
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
