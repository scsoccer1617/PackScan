/**
 * eBay Browse API search for the Gemini-authority picker (PR #162).
 *
 * Replaces the old SCP-driven catalog overlay with a live eBay search keyed
 * off Gemini's emitted fields. The picker calls /api/picker/ebay-search with
 * the final query string the user confirmed (or edited) and gets back two
 * tabs of listings:
 *   - Active     — Browse API /buy/browse/v1/item_summary/search
 *   - Sold       — best-effort. Browse API doesn't expose sold/completed
 *                  listings under the basic Client Credentials scope, so the
 *                  Sold tab returns an empty list with `available: false`.
 *                  TODO: switch to Marketplace Insights API when access is
 *                  unlocked.
 *
 * The module is intentionally separate from ebayService.ts to keep the
 * picker query path simple — no waterfall, no graded-tier logic, just one
 * query string in, listings out. ebayService.ts continues to power the
 * /result page's price-tier breakdown.
 */

import axios from 'axios';
import { getEbayAccessToken } from './ebayTokenManager';

export interface PickerListing {
  title: string;
  price: number;
  currency: string;
  url: string;
  imageUrl: string;
  condition: string;
}

export interface PickerSearchResponse {
  query: string;
  active: PickerListing[];
  sold: PickerListing[];
  /** When false, the Sold tab is best-effort unavailable (current eBay
   *  scope doesn't expose completed listings). The picker shows a small
   *  "Sold data not available" notice instead of an empty grid. */
  soldAvailable: boolean;
}

const BROWSE_SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
// Trading cards category — keeps the search inside the cards leaf so a
// player name like "Russell Wilson" doesn't pull authentic-jersey hits.
const SPORTS_CARDS_CATEGORY = '213';

function mapItem(item: any): PickerListing {
  return {
    title: item.title || '',
    price: parseFloat(item.price?.value || '0'),
    currency: item.price?.currency || 'USD',
    url: item.itemWebUrl || '',
    imageUrl: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || '',
    condition: item.condition || '',
  };
}

/**
 * Build a picker search query from final-form fields. Skips empty parts so
 * the query stays compact ("2025 Topps Series One #193 Nolan Arenado Pink
 * Polka Dot") without trailing whitespace artefacts.
 */
export function buildPickerQuery(parts: {
  year?: number | string | null;
  brand?: string | null;
  set?: string | null;
  cardNumber?: string | null;
  player?: string | null;
  parallel?: string | null;
}): string {
  const segments: string[] = [];
  if (parts.year != null && String(parts.year).trim()) {
    segments.push(String(parts.year).trim());
  }
  if (parts.brand && parts.brand.trim()) segments.push(parts.brand.trim());
  if (parts.set && parts.set.trim()) segments.push(parts.set.trim());
  if (parts.cardNumber && String(parts.cardNumber).trim()) {
    const num = String(parts.cardNumber).trim();
    segments.push(num.startsWith('#') ? num : `#${num}`);
  }
  if (parts.player && parts.player.trim()) segments.push(parts.player.trim());
  if (parts.parallel && parts.parallel.trim()) segments.push(parts.parallel.trim());
  return segments.join(' ').replace(/\s{2,}/g, ' ').trim();
}

export async function pickerSearch(
  rawQuery: string,
  opts?: { limit?: number },
): Promise<PickerSearchResponse> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 10, 50));
  const query = (rawQuery || '').replace(/\s{2,}/g, ' ').trim();
  if (!query) {
    return { query: '', active: [], sold: [], soldAvailable: false };
  }

  let active: PickerListing[] = [];
  try {
    const token = await getEbayAccessToken();
    const resp = await axios.get(BROWSE_SEARCH_URL, {
      params: {
        q: query,
        category_ids: SPORTS_CARDS_CATEGORY,
        limit,
        sort: 'newlyListed',
      },
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
      timeout: 20000,
    });
    const rawItems: any[] = resp.data?.itemSummaries ?? [];
    active = rawItems.map(mapItem).filter((i) => i.price > 0 && i.title);
    console.log(`[pickerSearch] active: ${active.length}/${rawItems.length} for "${query}"`);
  } catch (err: any) {
    console.warn('[pickerSearch] active search failed:', err?.response?.data || err?.message || err);
  }

  // Sold tab: Browse API under client_credentials scope does not expose
  // completed listings. Returning an empty list with `soldAvailable=false`
  // tells the picker UI to render a "not available" notice instead of
  // pretending the card has no sales.
  // TODO: when Marketplace Insights API access is granted, swap in the
  // /buy/marketplace_insights/v1_beta/item_sales/search call here.
  return { query, active, sold: [], soldAvailable: false };
}
