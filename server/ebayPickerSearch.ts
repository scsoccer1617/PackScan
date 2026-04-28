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
// eBay's "Sports Trading Cards" leaf category. Tighter than 213 (which
// covers Pokémon, MTG, non-sports). Switch back to 213 if PackScan ever
// supports non-sports cards.
const SPORTS_CARDS_CATEGORY = '261328';

// Parallel/insert keywords to exclude from base-card eBay searches. When
// the picker captured no parallel, the identity query (year + brand + #
// + player) matches the base AND every parallel — pulling parallel
// listings into the average and inflating estimated value. These keywords
// are eBay-tokenized as `-"keyword"` exclusions and re-checked client-
// side via word-boundary regex. The list is intentionally aggressive;
// downside is that base-card titles that legitimately contain a team
// name with a color word ("Red Sox", "Blackhawks") may also be filtered
// — see PR body trade-off note.
const PARALLEL_EXCLUSION_KEYWORDS = [
  // Color parallels
  'Gold', 'Silver', 'Black', 'Red', 'Blue', 'Green', 'Orange', 'Pink', 'Purple', 'Teal', 'Yellow', 'Bronze',
  // Finishes
  'Refractor', 'Prizm', 'Diamante', 'Holo', 'Holographic', 'Chrome', 'Mojo', 'Wave', 'Shimmer', 'Crackle',
  // Special parallels
  'Atomic', 'Disco', 'Hyper', 'Mosaic', 'Optic', 'Variation', 'SP', 'SSP',
  // Premium/numbered
  'Auto', 'Autograph', 'Patch', 'Relic', 'Jersey', 'Numbered',
  // Print runs (eBay tokenizes -/150 as exclusion)
  '/150', '/99', '/75', '/50', '/25', '/10', '/5', '/1',
  // Black Friday / holiday inserts
  'Blackout', 'Friday Exclusive',
];

/**
 * A scanned card is "base" when the picker captured no parallel — either
 * an empty string, null/undefined, or a known sentinel left over from the
 * pre-PR #168 normalization layer (defense in depth).
 */
function isBaseCard(parallel?: string | null): boolean {
  if (parallel == null) return true;
  const normalized = parallel.trim().toLowerCase();
  if (!normalized) return true;
  const baseSentinels = new Set([
    'none detected',
    'none',
    'base',
    'base set',
    'n/a',
    'na',
    'no parallel',
  ]);
  return baseSentinels.has(normalized);
}

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
    // Strip leading # if present, then quote so eBay treats it as a
    // required phrase. Card numbers like "80BK-68" or "8B-28" are sparse
    // enough that quoted phrase matching dramatically tightens results.
    const num = String(parts.cardNumber).trim().replace(/^#/, '');
    segments.push(`"${num}"`);
  }
  if (parts.player && parts.player.trim()) {
    // Quote player name so "Drake Powell" doesn't match listings with
    // just "Drake" or just "Powell" in the title.
    segments.push(`"${parts.player.trim()}"`);
  }
  if (parts.parallel && parts.parallel.trim()) segments.push(parts.parallel.trim());
  return segments.join(' ').replace(/\s{2,}/g, ' ').trim();
}

export interface PickerSearchOptions {
  limit?: number;
  /** Card number to require in result titles (case-insensitive). When
   *  present, listings whose titles don't contain this exact substring
   *  are dropped from `active`. Strip leading `#` before passing. */
  requireCardNumber?: string | null;
  /** Player last name to require in result titles (case-insensitive).
   *  Listings missing the surname are dropped — eBay's keyword search is
   *  fuzzy and lets through "Drake (something else)" or "Drake Maye" when
   *  the scanned card was Drake Powell. */
  requirePlayerLastName?: string | null;
  /** The parallel name the picker captured (or empty for base). Used to
   *  decide whether to apply parallel-keyword exclusions in the eBay
   *  query. When this is empty/null/sentinel, the card is treated as
   *  base and parallel listings are filtered out. */
  scannedParallel?: string | null;
}

export async function pickerSearch(
  rawQuery: string,
  opts?: PickerSearchOptions,
): Promise<PickerSearchResponse> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 10, 50));
  let query = (rawQuery || '').replace(/\s{2,}/g, ' ').trim();
  if (!query) {
    return { query: '', active: [], sold: [], soldAvailable: false };
  }

  // When the scanned card is base, append eBay negative-keyword filters
  // so listings with parallel/insert keywords are excluded server-side.
  // Necessary because card identity alone (year + brand + # + player)
  // matches base AND every parallel of that card — see PR body for the
  // Jokic #101 example where 4/5 returned listings were parallels.
  const isBase = isBaseCard(opts?.scannedParallel);
  if (isBase) {
    const exclusions = PARALLEL_EXCLUSION_KEYWORDS.map((kw) => `-"${kw}"`).join(' ');
    query = `${query} ${exclusions}`;
    console.log(`[pickerSearch] base-card detected — appended ${PARALLEL_EXCLUSION_KEYWORDS.length} parallel exclusions`);
  }

  let active: PickerListing[] = [];
  try {
    const token = await getEbayAccessToken();
    const resp = await axios.get(BROWSE_SEARCH_URL, {
      params: {
        q: query,
        category_ids: SPORTS_CARDS_CATEGORY,
        limit,
        // No sort param → eBay defaults to best-match (relevance).
      },
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
      timeout: 20000,
    });
    const rawItems: any[] = resp.data?.itemSummaries ?? [];
    let mapped = rawItems.map(mapItem).filter((i) => i.price > 0 && i.title);

    // Tighten precision: require both card number and last name in title.
    // eBay's keyword `q` is fuzzy by design — quoted phrases narrow the
    // server-side match, and this client-side post-filter catches the
    // long-tail loose hits that still come through.
    const cardNum = (opts?.requireCardNumber || '').trim().replace(/^#/, '').toLowerCase();
    const lastName = (opts?.requirePlayerLastName || '').trim().toLowerCase();
    if (cardNum || lastName) {
      const before = mapped.length;
      mapped = mapped.filter((item) => {
        const title = item.title.toLowerCase();
        if (cardNum && !title.includes(cardNum)) return false;
        if (lastName && !title.includes(lastName)) return false;
        return true;
      });
      console.log(`[pickerSearch] precision-filter: ${mapped.length}/${before} kept (cardNum="${cardNum}", lastName="${lastName}")`);
    }

    // Defense-in-depth: even with `-keyword` server-side exclusions,
    // listings that put parallel keywords in non-title fields can slip
    // through. For base cards, also drop any title containing a parallel
    // keyword via word-boundary regex.
    if (isBase && mapped.length > 0) {
      const beforeBase = mapped.length;
      const exclusionRegex = new RegExp(
        '\\b(' +
          PARALLEL_EXCLUSION_KEYWORDS.map((kw) =>
            kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          ).join('|') +
          ')\\b',
        'i',
      );
      mapped = mapped.filter((item) => !exclusionRegex.test(item.title));
      console.log(`[pickerSearch] base-card title-filter: ${mapped.length}/${beforeBase} kept`);
    }
    active = mapped;
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
