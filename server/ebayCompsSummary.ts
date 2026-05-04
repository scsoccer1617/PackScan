/**
 * PR G — Single source of truth for the comp-price metric.
 *
 * Hits the eBay Browse API directly (limit=100, BIN-only) for a wider
 * pool than the 5-listing picker, applies the same precision filters
 * (card # + last name in title), folds shipping into each price, and
 * returns BOTH median and mean. Median is the canonical metric the UI
 * hero, bulk auto-save, and reprice all consume — replacing three
 * locally-computed mean-of-≤N pipelines that produced different numbers
 * for the same card.
 *
 * The picker (ebayPickerSearch.ts) still ranks and returns the top 5
 * listings the UI displays as the listings strip; this helper does NOT
 * replace that. The two paths intentionally agree on the same query
 * (buildPickerQuery) and the same precision filters but differ on the
 * pool size — picker = top-N for display, summary = wide pool for a
 * stable median.
 */

import { sharedHttpClient } from './httpClient';
import { getEbayAccessToken } from './ebayTokenManager';

const BROWSE_SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const SPORTS_CARDS_CATEGORY = '261328';
// eBay Browse API hard cap is 200; 100 is plenty for a stable median
// without doubling the network/CPU cost. Telemetry-guided default.
const SUMMARY_POOL_SIZE = 100;
// Cache TTL — the picker can fire repeatedly during a burst of scans
// (BR-2 fast-path + per-scan re-fetch + bulk processor + reprice). 60s
// is short enough to track market moves, long enough to absorb bursts.
const CACHE_TTL_MS = 60_000;

export interface CompsSummary {
  median: number | null;
  mean: number | null;
  count: number;
  query: string;
  currency: 'USD';
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
  return `${query}||${cardNum}||${lastName}||${grade}`;
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
 * Pull effective price (item price + shipping) from a Browse API item.
 * Buyers see total cost on the listing card, so the median should
 * reflect that — folding shipping in matches the user's eBay click-
 * through experience.
 */
export function effectivePrice(item: any): number {
  const price = parseFloat(item?.price?.value || '0');
  const ship = parseFloat(item?.shippingOptions?.[0]?.shippingCost?.value || '0');
  return price + (Number.isFinite(ship) ? ship : 0);
}

/**
 * Fetch a wide pool of BIN-only Browse API listings, apply the same
 * precision filters as the picker, and compute median + mean over the
 * survivor pool. Cached ~60s per (query, filters).
 */
export async function getCompsSummary(
  rawQuery: string,
  opts?: CompsSummaryOptions,
): Promise<CompsSummary> {
  const query = (rawQuery || '').replace(/\s{2,}/g, ' ').trim();
  if (!query) {
    return { median: null, mean: null, count: 0, query: '', currency: 'USD' };
  }

  const key = cacheKey(query, opts);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
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
        // through URL so the median tracks what the buyer would pay
        // for an immediate purchase, not auction min bids.
        filter: 'buyingOptions:{FIXED_PRICE}',
      },
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
      timeout: 20000,
    });
    const items: any[] = resp.data?.itemSummaries ?? [];
    result = computeSummary(items, query, opts);
  } catch (err: any) {
    console.warn('[ebayCompsSummary] fetch failed:', err?.response?.data || err?.message || err);
    result = { median: null, mean: null, count: 0, query, currency: 'USD' };
  }

  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result });
  return result;
}

/**
 * Pure function: filter raw Browse items by precision rules + price > 0,
 * fold in shipping, compute median/mean. Exported for unit testing.
 */
export function computeSummary(
  rawItems: any[],
  query: string,
  opts?: CompsSummaryOptions,
): CompsSummary {
  const cardNum = (opts?.requireCardNumber || '').trim().replace(/^#/, '').toLowerCase();
  const lastName = (opts?.requirePlayerLastName || '').trim().toLowerCase();
  const grade = (opts?.requireGrade || '').trim().toLowerCase();

  const prices: number[] = [];
  for (const item of rawItems) {
    const title = (item?.title || '').toLowerCase();
    if (!title) continue;
    if (cardNum && !title.includes(cardNum)) continue;
    if (lastName && !title.includes(lastName)) continue;
    if (grade && !title.includes(grade)) continue;
    const eff = effectivePrice(item);
    if (eff > 0) prices.push(eff);
  }

  return {
    median: median(prices),
    mean: mean(prices),
    count: prices.length,
    query,
    currency: 'USD',
  };
}

/** Test/debug helper: drop the cache. Not exported on the wire. */
export function _clearCompsSummaryCache(): void {
  cache.clear();
}
