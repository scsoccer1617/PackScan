/**
 * PR K — Unified 10-listing pool, mean price across all surfaces.
 *
 * Single source of truth for the comp-price metric AND for the listings
 * the Price tab renders. Hits the eBay Browse API with limit=10,
 * sort=newlyListed, BIN-only, applies the same precision filters the
 * picker uses (card # + last name in title), drops shipping (item price
 * only), and returns the MEAN over the survivor pool plus the listings
 * themselves so the UI can render the EXACT pool the average was
 * computed from.
 *
 * Pre-PR-K (PR G — PR #263) used limit=100, best-match sort, shipping
 * folded in, and returned MEDIAN as canonical. The Price tab then made
 * a separate `/api/ebay/comps` fetch for display, which produced a
 * different pool — the user observed "Median $2.98 (n=13)" on the hero
 * but only 5 listings rendered in the Price tab. PR K collapses both
 * fetches into this one helper.
 *
 * `median` is still computed and returned for diagnostics / backwards
 * compat, but is deprecated as the canonical metric.
 */

import { sharedHttpClient } from './httpClient';
import { getEbayAccessToken } from './ebayTokenManager';

const BROWSE_SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const SPORTS_CARDS_CATEGORY = '261328';
// PR K: 10 newest BIN listings. Single pool the hero, Price tab, sheet
// column, bulk auto-save, and reprice all read from.
const SUMMARY_POOL_SIZE = 10;
// Cache TTL — the picker can fire repeatedly during a burst of scans
// (BR-2 fast-path + per-scan re-fetch + bulk processor + reprice). 60s
// is short enough to track market moves, long enough to absorb bursts.
const CACHE_TTL_MS = 60_000;

/**
 * Listing shape returned to the UI. Mirrors `ActiveListing` in
 * client/src/components/EbayActiveComps.tsx so the Price tab can drop
 * the existing `/api/ebay/comps` fetch and render summary.listings
 * directly.
 */
export interface SummaryListing {
  title: string;
  price: number;
  currency: string;
  url: string;
  imageUrl: string;
  condition: string;
}

export interface CompsSummary {
  /** PR K canonical: arithmetic mean over the ≤10 pool, item price only. */
  mean: number | null;
  /**
   * @deprecated PR K — preserved for diagnostics and any caller still
   * reading the old field name. Do not use as the displayed metric.
   */
  median: number | null;
  count: number;
  query: string;
  currency: 'USD';
  /** PR K: the actual ≤10 listings the mean was computed from. */
  listings: SummaryListing[];
}

export interface CompsSummaryOptions {
  /** Card number to require in title (case-insensitive). Strip leading
   *  `#` before passing — mirrors ebayPickerSearch.ts:441. */
  requireCardNumber?: string | null;
  /** Player last name to require in title (case-insensitive). Mirrors
   *  ebayPickerSearch.ts:442. */
  requirePlayerLastName?: string | null;
  /** Optional grade phrase ("PSA 10") to require in title. */
  requireGrade?: string | null;
  /**
   * PR K: when true (default), the helper applies the base-card negative
   * keyword chain (`-autograph -refractor -xfractor -rainbow -mojo -holo
   * -relic -memorabilia -"game-used" -"game used" -patch -jersey -auto
   * -autographed -autographs -autos -signed -parallel`) inside the
   * Browse `q` parameter. Set false when scanning a parallel/auto/relic
   * (the user already chose a parallel, so excluding those terms would
   * filter the legitimate target listings out).
   */
  excludeParallels?: boolean;
  /**
   * PR P: optional abort signal so callers that pre-fire the summary
   * (e.g. dualSideOCR.ts kicking off the lookup as soon as parallel
   * detection lands) can cancel the in-flight Browse fetch when the
   * identity later changes (search-verify gate corrects player/year/
   * cardNumber and the pre-fired query goes stale). When the signal
   * aborts before the cache write happens, no cache entry is written
   * — a fresh call with the corrected identity will run normally.
   */
  signal?: AbortSignal;
  /**
   * PR AE: when true, skip the 60s in-memory cache for this call. Used by
   * the reprice route so an edited identity always pulls a fresh Browse
   * pool — a dealer who corrected the year and re-runs Analyze must not
   * see the stale-cached pool from the original (incorrect) identity.
   * The successful response is still written to cache so subsequent
   * non-bypass callers (BR-2 fast-path, ScanResult mount) reuse it.
   */
  bypassCache?: boolean;
}

interface CacheEntry {
  expiresAt: number;
  result: CompsSummary;
}
const cache = new Map<string, CacheEntry>();

function cacheKey(query: string, opts?: CompsSummaryOptions): string {
  const cardNum = (opts?.requireCardNumber || '').trim().replace(/^#/, '').toLowerCase();
  const lastName = (opts?.requirePlayerLastName || '').trim().toLowerCase();
  const grade = (opts?.requireGrade || '').trim().toLowerCase();
  const excl = opts?.excludeParallels !== false ? '1' : '0';
  return `${query}||${cardNum}||${lastName}||${grade}||${excl}`;
}

export function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mean(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

/**
 * PR K: item price only. Shipping fold-in was dropped — the user wants
 * the item-price average across BIN listings, matching what the buyer
 * sees as the headline number on each listing card.
 */
export function itemPrice(item: any): number {
  const price = parseFloat(item?.price?.value || '0');
  return Number.isFinite(price) ? price : 0;
}

/**
 * Base-card negative keyword chain — same set ebayPickerSearch.ts uses
 * when the picker is searching for a base card. Kept here so the
 * summary pool excludes the same junk; otherwise the mean would be
 * dragged up by a foil/refractor/auto sneaking through Browse's
 * default match.
 */
const BASE_NEGATIVE_KEYWORDS =
  '-autograph -refractor -xfractor -rainbow -mojo -holo -relic ' +
  '-memorabilia -"game-used" -"game used" -patch -jersey -auto ' +
  '-autographed -autographs -autos -signed -parallel ' +
  // PR M: graded slabs + multi-card lots. Users reported PSA/BGS/SGC/
  // CGC slabs and "lot of N" listings inflating the mean and
  // cluttering the Price tab on base-card scans. Only applied when
  // excludeParallels !== false — graded/parallel scans want their
  // actual variant.
  '-PSA -BGS -SGC -CGC -graded -lot ' +
  // PR N: surgical "set" exclusions. PR M's single-word `-set` token
  // was too broad — it filtered out legitimate "Base Set" listings
  // (e.g. "1992 Topps Base Set #156 Kenny Lofton"), which is the very
  // pool a base-card scan wants. Replaced with three multi-word
  // phrases that target only the seller-spam patterns:
  //   - "complete your set" — sellers offering single cards as set-fillers
  //   - "complete set"      — sellers selling complete sets (multi-card listings)
  //   - "set break"         — group breaks / box breaks
  '-"complete your set" -"complete set" -"set break"';

/**
 * PR M / PR N: the base-scan negatives layered on top of the pre-PR-M
 * chain. Kept as a separate list so the URL post-process (which has to
 * mutate `_nkw` in an already-built URL) appends exactly the same
 * tokens. PR N replaces PR M's single-word `-set` with three surgical
 * multi-word phrases (see BASE_NEGATIVE_KEYWORDS comment).
 */
const PR_M_BASE_NEGATIVES = [
  '-PSA',
  '-BGS',
  '-SGC',
  '-CGC',
  '-graded',
  '-lot',
  '-"complete your set"',
  '-"complete set"',
  '-"set break"',
];

/**
 * PR N: tokens to STRIP from `_nkw` on the way through (carryover from
 * PR M's overly-broad chain). Running PR N's helper on a #269-era URL
 * with `+-set` in `_nkw` should drop the bare `-set` token, then add
 * the three surgical phrases. Bare hyphen prefix only — the substring
 * match is strict to avoid eating tokens like `-"set break"`.
 */
const PR_N_TOKENS_TO_STRIP = ['-set'];

/**
 * PR K / PR M: build the Browse `q` string. When `excludeParallels` is
 * true (the default — base-card scans), the base negative-keyword chain
 * is concatenated onto the raw query. When false (the caller scanned a
 * known parallel/auto/relic), the raw query is returned unchanged.
 *
 * Exported for unit testing — production code calls `getCompsSummary`.
 */
export function buildBrowseQuery(
  rawQuery: string,
  opts?: CompsSummaryOptions,
): string {
  const baseQuery = (rawQuery || '').replace(/\s{2,}/g, ' ').trim();
  if (!baseQuery) return '';
  const excludeParallels = opts?.excludeParallels !== false;
  return excludeParallels ? `${baseQuery} ${BASE_NEGATIVE_KEYWORDS}` : baseQuery;
}

/**
 * Map a raw Browse `itemSummary` to the listing shape the UI renders.
 */
function toListing(item: any): SummaryListing {
  return {
    title: (item?.title || '').toString(),
    price: itemPrice(item),
    currency: (item?.price?.currency || 'USD').toString(),
    url: (item?.itemWebUrl || '').toString(),
    imageUrl: (item?.image?.imageUrl || item?.thumbnailImages?.[0]?.imageUrl || '').toString(),
    condition: (item?.condition || '').toString(),
  };
}

/**
 * Fetch up to 10 newest-listed BIN-only Browse API listings, apply the
 * same precision filters as the picker, and compute mean over the
 * survivor pool. Cached ~60s per (query, filters).
 */
export async function getCompsSummary(
  rawQuery: string,
  opts?: CompsSummaryOptions,
): Promise<CompsSummary> {
  const baseQuery = (rawQuery || '').replace(/\s{2,}/g, ' ').trim();
  if (!baseQuery) {
    return {
      mean: null,
      median: null,
      count: 0,
      query: '',
      currency: 'USD',
      listings: [],
    };
  }

  const query = buildBrowseQuery(baseQuery, opts);

  const key = cacheKey(query, opts);
  if (!opts?.bypassCache) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
  }

  let result: CompsSummary;
  try {
    const token = await getEbayAccessToken();
    const resp = await sharedHttpClient.get(BROWSE_SEARCH_URL, {
      params: {
        q: query,
        category_ids: SPORTS_CARDS_CATEGORY,
        limit: SUMMARY_POOL_SIZE,
        // BIN-only — matches the LH_BIN=1 in the user's eBay click-
        // through URL so the mean tracks what the buyer would pay for
        // an immediate purchase, not auction min bids.
        filter: 'buyingOptions:{FIXED_PRICE}',
        // PR K: newest listed first, matching the spreadsheet
        // "View on eBay" URL (`_sop=10`) so the pool the buyer sees
        // when they click through equals the pool we averaged.
        sort: 'newlyListed',
      },
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
      timeout: 20000,
      // PR P: pre-fire callers pass an AbortSignal so the in-flight
      // Browse fetch can be cancelled when search-verify later
      // corrects identity. axios honors signal in its config.
      signal: opts?.signal,
    });
    const items: any[] = resp.data?.itemSummaries ?? [];
    result = computeSummary(items, query, opts);
  } catch (err: any) {
    // PR P: aborts come back as ERR_CANCELED / CanceledError. Don't
    // log those at warn (they're expected when a pre-fired identity
    // is invalidated) and don't write the empty placeholder to cache
    // — a follow-up call with the corrected identity must hit eBay
    // for real, not read this canceled-empty result.
    if (
      err?.code === 'ERR_CANCELED'
      || err?.name === 'CanceledError'
      || err?.name === 'AbortError'
      || opts?.signal?.aborted
    ) {
      throw err;
    }
    console.warn('[ebayCompsSummary] fetch failed:', err?.response?.data || err?.message || err);
    result = {
      mean: null,
      median: null,
      count: 0,
      query,
      currency: 'USD',
      listings: [],
    };
  }

  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result });
  return result;
}

/**
 * Pure function: filter raw Browse items by precision rules + price > 0,
 * compute mean (canonical) and median (deprecated diagnostic), and
 * return the survivor listings. Exported for unit testing.
 */
export function computeSummary(
  rawItems: any[],
  query: string,
  opts?: CompsSummaryOptions,
): CompsSummary {
  const cardNum = (opts?.requireCardNumber || '').trim().replace(/^#/, '').toLowerCase();
  const lastName = (opts?.requirePlayerLastName || '').trim().toLowerCase();
  const grade = (opts?.requireGrade || '').trim().toLowerCase();

  const listings: SummaryListing[] = [];
  const prices: number[] = [];
  for (const item of rawItems) {
    const title = (item?.title || '').toLowerCase();
    if (!title) continue;
    if (cardNum && !title.includes(cardNum)) continue;
    if (lastName && !title.includes(lastName)) continue;
    if (grade && !title.includes(grade)) continue;
    const listing = toListing(item);
    if (listing.price > 0) {
      prices.push(listing.price);
      listings.push(listing);
    }
  }

  return {
    mean: mean(prices),
    median: median(prices),
    count: prices.length,
    query,
    currency: 'USD',
    listings,
  };
}

/**
 * PR K: append `LH_BIN=1` to a "View on eBay" search URL so the link
 * the user clicks (in the Sheet, in the bulk reprice flow, etc.)
 * lands them on the same BIN-only pool we computed the mean against.
 *
 * Idempotent: if the URL already contains `LH_BIN=1` (or any
 * `LH_BIN=...`) we return it unchanged. Safe on URLs with or without
 * an existing query string.
 */
export function ensureBinFilter(url: string | null | undefined): string {
  if (!url) return '';
  if (/[?&]LH_BIN=/i.test(url)) return url;
  return url.includes('?') ? `${url}&LH_BIN=1` : `${url}?LH_BIN=1`;
}

/**
 * PR M / PR N: append the base-scan negatives to the `_nkw` query
 * param of an eBay search URL so the "View on eBay" click-through pool
 * matches the picker pool. PR N additionally STRIPS PR M's overly-
 * broad bare `-set` token from `_nkw` (see PR_N_TOKENS_TO_STRIP) so
 * URLs persisted by a #269-era write converge to the new chain.
 *
 * Only call this for BASE scans (caller's responsibility — same gate as
 * `excludeParallels !== false`). Graded/parallel scans must NOT pass
 * their URLs through this transform; they want their actual variant.
 *
 * Idempotent: each token is only appended if not already present in
 * `_nkw`. Running twice produces the same URL as running once. Tokens
 * are joined to the existing `_nkw` value with `+` (eBay accepts both
 * `+` and `%20` as the space encoding). Quoted multi-word phrases use
 * `%22` for the quote characters and `+` for inner spaces. Safe on
 * URLs with or without an existing query string; if the URL has no
 * `_nkw` param at all (unexpected for an eBay search URL) the URL is
 * returned unchanged.
 */
export function appendBaseScanNegatives(url: string | null | undefined): string {
  if (!url) return '';
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return url;
  const head = url.slice(0, qIdx);
  const queryAndHash = url.slice(qIdx + 1);
  const hashIdx = queryAndHash.indexOf('#');
  const queryStr = hashIdx >= 0 ? queryAndHash.slice(0, hashIdx) : queryAndHash;
  const hash = hashIdx >= 0 ? queryAndHash.slice(hashIdx) : '';
  const params = queryStr.split('&');
  let touched = false;
  for (let i = 0; i < params.length; i += 1) {
    const eq = params[i].indexOf('=');
    if (eq < 0) continue;
    const name = params[i].slice(0, eq);
    if (name !== '_nkw') continue;
    const rawValue = params[i].slice(eq + 1);
    let nextValue = rawValue;

    // PR N: strip carryover PR M tokens (currently just bare `-set`)
    // before considering what to append. Match either the `+`-joined
    // or `%20`-joined form, with optional trailing separator. The
    // trailing-separator clause keeps the rest of `_nkw` well-formed
    // when the stripped token wasn't the last entry.
    for (const stripTok of PR_N_TOKENS_TO_STRIP) {
      const encoded = encodeURIComponent(stripTok).replace(/%20/g, '+');
      // `+-set` (mid-string) → ``
      const midPlus = new RegExp(`\\+${escapeRe(encoded)}(?=$|\\+)`, 'gi');
      // `%20-set` (mid-string, %20-encoded form) → ``
      const midPct = new RegExp(`%20${escapeRe(encoded)}(?=$|%20)`, 'gi');
      // Leading occurrence (token is the very first thing in _nkw,
      // unlikely but defensive): drop the trailing separator instead.
      const leadPlus = new RegExp(`^${escapeRe(encoded)}\\+`, 'gi');
      const leadPct = new RegExp(`^${escapeRe(encoded)}%20`, 'gi');
      // Bare token at end with no neighbors.
      const onlyTok = new RegExp(`^${escapeRe(encoded)}$`, 'gi');
      nextValue = nextValue
        .replace(midPlus, '')
        .replace(midPct, '')
        .replace(leadPlus, '')
        .replace(leadPct, '')
        .replace(onlyTok, '');
    }

    // eBay accepts both `+` and `%20` for spaces in `_nkw`, and
    // `%22` for the quote characters around a phrase. Normalize when
    // checking for presence so the idempotency guard catches tokens
    // already encoded either way (e.g. `+-"complete+set"` or
    // `%20-%22complete%20set%22`). decodeURIComponent throws on
    // malformed escapes — fall back to the raw spaces-normalized form
    // if that ever happens.
    let decoded: string;
    try {
      decoded = decodeURIComponent(nextValue.replace(/\+/g, ' ')).toLowerCase();
    } catch {
      decoded = nextValue.replace(/\+/g, ' ').toLowerCase();
    }
    for (const tok of PR_M_BASE_NEGATIVES) {
      if (decoded.includes(tok.toLowerCase())) continue;
      nextValue = `${nextValue}+${encodeURIComponent(tok).replace(/%20/g, '+')}`;
    }
    if (nextValue !== rawValue) {
      params[i] = `${name}=${nextValue}`;
      touched = true;
    }
    break;
  }
  if (!touched) return url;
  return `${head}?${params.join('&')}${hash}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Test/debug helper: drop the cache. Not exported on the wire. */
export function _clearCompsSummaryCache(): void {
  cache.clear();
}
