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

import { sharedHttpClient } from './httpClient';
import { getEbayAccessToken } from './ebayTokenManager';

export interface PickerListing {
  title: string;
  price: number;
  currency: string;
  url: string;
  imageUrl: string;
  condition: string;
  /** Per-listing relevance score (PR #178). Diagnostic only — surfaced in
   *  the response so callers can show / log the ranking decision. */
  _relevanceScore?: number;
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

// Number of candidates pulled from eBay before scoring + top-5 cap. Wider
// pool gives the ranker a real choice; the API hard caps at 200.
const CANDIDATE_POOL_SIZE = 25;
const TOP_N = 5;

// Parallel/insert keywords used to penalize titles that introduce
// finishes the scanned card didn't have. PR #178 replaced the old
// `-"keyword"` server-side exclusions with this scoring approach because
// negative-keyword filtering was both too aggressive (zeroed out base
// "Topps Chrome" results) and too loose (Purple parallels still slipped
// through for Jokic #101). Generic colors stay out of the list — Red Sox,
// Blue Jays, Reds etc would otherwise penalize legitimate base hits.
const PARALLEL_KEYWORDS = [
  // Specific colored parallels (rare in team names; common as parallel
  // qualifiers). Purple included now — base scans no longer get zeroed
  // out because this is a soft penalty, not a hard exclusion.
  'Pink', 'Teal', 'Bronze', 'Gold', 'Silver', 'Purple',
  // Finishes (Chrome deliberately omitted — set-name collision with
  // "Topps Chrome" / "Bowman Chrome" product lines)
  'Refractor', 'Prizm', 'Diamante', 'Holo', 'Holographic', 'Mojo', 'Wave',
  'Shimmer', 'Crackle', 'Foilboard', 'Rainbow',
  // Special parallels
  'Atomic', 'Disco', 'Hyper', 'Mosaic', 'Optic', 'Variation', 'SP', 'SSP',
  'SuperFractor', 'Lava', 'Tiger', 'Dragon', 'Fireworks', 'Pulsar',
  'Negative', 'Inverted',
  // Premium/numbered
  'Auto', 'Autograph', 'Patch', 'Relic', 'Jersey', 'Numbered',
  // Print runs (eBay tokenizes /150 as standalone)
  '/150', '/99', '/75', '/50', '/25', '/10', '/5', '/1',
  // Black Friday / holiday / Fanatics inserts
  'Blackout', 'Friday Exclusive', 'Fanatics Exclusive', 'Logo Foil',
];

const PARALLEL_PENALTY = -15;
const SCORE_CARD_NUMBER = 10;
const SCORE_LAST_NAME = 5;
const SCORE_FIRST_NAME = 3;
const SCORE_BRAND = 5;
const SCORE_SET = 5;
const SCORE_YEAR = 3;
const SCORE_SCANNED_PARALLEL = 8;

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when the keyword appears in `text` as a whole word
 * (case-insensitive). For tokens that contain regex metacharacters like
 * `/150` we rely on character-class boundaries — \b doesn't match between
 * `/` and a digit, so we fall back to a substring check.
 */
function titleContains(text: string, keyword: string): boolean {
  if (!keyword) return false;
  const lower = text.toLowerCase();
  const kwLower = keyword.toLowerCase();
  // Print-run tokens (`/150`) and other punctuation-led keywords don't
  // play nice with \b. Substring is precise enough — `/150` won't appear
  // inside an unrelated word.
  if (/^[^a-z0-9]/i.test(keyword) || /[^a-z0-9]$/i.test(keyword)) {
    return lower.includes(kwLower);
  }
  const re = new RegExp(`\\b${escapeRegex(kwLower)}\\b`, 'i');
  return re.test(text);
}

interface ScoreContext {
  cardNumber?: string | null;
  playerFirstName?: string | null;
  playerLastName?: string | null;
  brand?: string | null;
  set?: string | null;
  year?: number | string | null;
  scannedParallel?: string | null;
}

interface ScoreBreakdown {
  score: number;
  parts: string[];
}

function scoreTitle(title: string, ctx: ScoreContext): ScoreBreakdown {
  let score = 0;
  const parts: string[] = [];

  const cardNum = (ctx.cardNumber || '').toString().trim().replace(/^#/, '');
  if (cardNum && titleContains(title, cardNum)) {
    score += SCORE_CARD_NUMBER;
    parts.push(`+${SCORE_CARD_NUMBER} card#`);
  }

  const lastName = (ctx.playerLastName || '').trim();
  if (lastName && titleContains(title, lastName)) {
    score += SCORE_LAST_NAME;
    parts.push(`+${SCORE_LAST_NAME} lastName`);
  }

  const firstName = (ctx.playerFirstName || '').trim();
  if (firstName && titleContains(title, firstName)) {
    score += SCORE_FIRST_NAME;
    parts.push(`+${SCORE_FIRST_NAME} firstName`);
  }

  const brand = (ctx.brand || '').trim();
  if (brand && titleContains(title, brand)) {
    score += SCORE_BRAND;
    parts.push(`+${SCORE_BRAND} brand`);
  }

  const setName = (ctx.set || '').trim();
  if (setName && titleContains(title, setName)) {
    score += SCORE_SET;
    parts.push(`+${SCORE_SET} set`);
  }

  const yearStr = ctx.year != null ? String(ctx.year).trim() : '';
  if (yearStr && titleContains(title, yearStr)) {
    score += SCORE_YEAR;
    parts.push(`+${SCORE_YEAR} year`);
  }

  // Treat the scanned parallel as a positive signal — when the user
  // confirmed "Refractor", a Refractor listing should rank above a base.
  // Using the same word-list we penalize against keeps the model symmetric.
  const scannedParallelLower = (ctx.scannedParallel || '').trim().toLowerCase();
  const scannedTokens = new Set<string>();
  if (scannedParallelLower) {
    for (const kw of PARALLEL_KEYWORDS) {
      if (titleContains(scannedParallelLower, kw)) {
        scannedTokens.add(kw.toLowerCase());
      }
    }
    // If the scanned parallel didn't match any of our known keywords
    // (e.g. "Pink Polka Dot"), still credit a title that contains the
    // scanned phrase verbatim.
    if (titleContains(title, scannedParallelLower)) {
      score += SCORE_SCANNED_PARALLEL;
      parts.push(`+${SCORE_SCANNED_PARALLEL} scannedParallel`);
    }
  }

  // Penalize each parallel keyword that appears in the title but is NOT
  // part of the scanned parallel. This is the core of the relevance fix
  // — a Purple Refractor listing matched against a base scan loses 30
  // points and falls off the top-5 even though no `-keyword` was sent.
  let unmatched = 0;
  for (const kw of PARALLEL_KEYWORDS) {
    if (scannedTokens.has(kw.toLowerCase())) continue;
    if (titleContains(title, kw)) {
      score += PARALLEL_PENALTY;
      unmatched += 1;
    }
  }
  if (unmatched > 0) {
    parts.push(`${PARALLEL_PENALTY * unmatched} parallel×${unmatched}`);
  }

  return { score, parts };
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

// Generic placeholder set names that Gemini may emit for vintage base cards
// — these never appear in eBay listing titles and only add noise to search.
const GENERIC_SET_NAMES = new Set(['base set', 'base', 'base cards']);

/**
 * Normalize the `set` field for the picker query. Drops generic placeholders
 * ("Base Set"), strips redundant brand/year-brand prefixes, and returns ''
 * when nothing useful remains. Mirrors the logic that the older
 * getEbaySearchUrl path in ebayService.ts has via GENERIC_COLLECTION_NAMES +
 * normalizeSetForSearch, plus an extra rule for Gemini's "1987 Topps" pattern
 * on vintage Topps base cards.
 */
function normalizeSet(set: string, brand: string): string {
  let s = (set || '').trim();
  if (!s) return '';
  if (GENERIC_SET_NAMES.has(s.toLowerCase())) return '';
  const b = (brand || '').trim();
  if (b && s.toLowerCase().startsWith(b.toLowerCase())) {
    s = s.slice(b.length).trim();
  }
  if (b) {
    const escaped = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const yearBrandRe = new RegExp(`^\\d{4}\\s+${escaped}\\b`, 'i');
    s = s.replace(yearBrandRe, '').trim();
  }
  if (!s || s.toLowerCase() === b.toLowerCase()) return '';
  return s;
}

/**
 * Negative-keyword exclusion chain appended to the picker query when the
 * scan is a *base* card (no foilType / parallel detected). Mirrors the
 * Sheet click-through URL chain in `getEbaySearchUrl` so the avg-price
 * driver and the user-facing eBay link see the same listings.
 *
 * Bug A (PR #209): `buildPickerQuery` previously emitted no exclusions, so
 * the eBay Browse API pulled in foil/parallel/auto/relic listings even for
 * a base scan, inflating the Sheet's avg price relative to the click-
 * through view. Adding `-keyword` tokens to `q` is the supported Browse
 * API behavior and matches the chain the Sheet URL already used.
 *
 * Skipped when `foilType` is non-empty — a parallel scan WANTS to find
 * parallel comps. Adding `-parallel` would zero those out.
 */
const PICKER_EXCLUSION_CHAIN = [
  '-autograph', '-signed', '-parallel', '-refractor', '-xfractor',
  '-rainbow', '-mojo', '-holo', '-relic', '-memorabilia',
  '-"game-used"', '-"game used"', '-patch', '-jersey',
].join(' ');

/**
 * Subsets that name multiple players on a single card (Team Leaders,
 * Combos, etc.). When the scan's subset matches, the picker drops the
 * `requirePlayerLastName` precision filter — those listings rarely
 * include any one of the players' surnames, so requiring it would zero
 * out otherwise-valid comps. See Bug B (PR #209).
 */
const MULTI_PLAYER_SUBSET_PATTERNS = [
  /\bteam leaders\b/i,
  /\bleaders\b/i,
  /\bcombos?\b/i,
  /\bduo\b/i,
  /\btrio\b/i,
  /\bbattery\s*mates\b/i,
];

export function isMultiPlayerSubset(subset: string | null | undefined): boolean {
  const s = (subset || '').trim();
  if (!s) return false;
  return MULTI_PLAYER_SUBSET_PATTERNS.some((re) => re.test(s));
}

/**
 * Build a picker search query from final-form fields. Skips empty parts so
 * the query stays compact ("2025 Topps Series One #193 Nolan Arenado Pink
 * Polka Dot") without trailing whitespace artefacts.
 *
 * Pass `subset` separately so multi-player subsets (Team Leaders, Combos,
 * …) are AND'd into the query without overwriting the `player` slot. See
 * Bug B (PR #209).
 *
 * Pass `excludeParallels: true` (the default for base scans — caller
 * should set it from `!parts.parallel`) to append the parallel/foil
 * exclusion chain. Skipped automatically when `parts.parallel` is non-
 * empty, since a parallel scan wants parallel comps.
 */
export function buildPickerQuery(parts: {
  year?: number | string | null;
  brand?: string | null;
  set?: string | null;
  cardNumber?: string | null;
  player?: string | null;
  parallel?: string | null;
  subset?: string | null;
  excludeParallels?: boolean;
}): string {
  const segments: string[] = [];
  if (parts.year != null && String(parts.year).trim()) {
    segments.push(String(parts.year).trim());
  }
  if (parts.brand && parts.brand.trim()) segments.push(parts.brand.trim());
  const normalizedSet = parts.set
    ? normalizeSet(String(parts.set), String(parts.brand || ''))
    : '';
  if (normalizedSet) segments.push(normalizedSet);
  if (parts.cardNumber && String(parts.cardNumber).trim()) {
    const num = String(parts.cardNumber).trim().replace(/^#/, '');
    segments.push(num);
  }
  if (parts.player && parts.player.trim()) {
    segments.push(parts.player.trim());
  }
  if (parts.subset && parts.subset.trim()) {
    segments.push(parts.subset.trim());
  }
  if (parts.parallel && parts.parallel.trim()) segments.push(parts.parallel.trim());
  // Negative-keyword exclusions for base scans only. A scan with a non-
  // empty `parallel` is itself a parallel/insert and should match parallel
  // listings, so we suppress the chain in that case regardless of the
  // caller's `excludeParallels` flag.
  const wantExclusions = parts.excludeParallels !== false
    && !(parts.parallel && parts.parallel.trim());
  if (wantExclusions) {
    segments.push(PICKER_EXCLUSION_CHAIN);
  }
  return segments.join(' ').replace(/\s{2,}/g, ' ').trim();
}

export interface PickerSearchOptions {
  /** Max listings returned to the caller. Capped at TOP_N (5) regardless
   *  of caller — the relevance ranker is the gate, not the eBay limit. */
  limit?: number;
  /** Card number to require in result titles (case-insensitive). When
   *  present, listings whose titles don't contain this exact substring
   *  are dropped before scoring. Strip leading `#` before passing. */
  requireCardNumber?: string | null;
  /** Player last name to require in result titles (case-insensitive).
   *  Listings missing the surname are dropped — eBay's keyword search is
   *  fuzzy and lets through "Drake (something else)" or "Drake Maye" when
   *  the scanned card was Drake Powell. */
  requirePlayerLastName?: string | null;
  /** The parallel name the picker captured (or empty for base). Drives
   *  the ranker: parallel keywords NOT in this string get penalized in
   *  candidate titles, while keywords that ARE in it become positive
   *  signals. Pass null/empty for base cards. */
  scannedParallel?: string | null;
  /** Brand for relevance scoring (e.g. "Topps", "Panini"). +5 when
   *  matched in candidate title. */
  brand?: string | null;
  /** Set for relevance scoring (e.g. "Series One", "Prizm"). +5 when
   *  matched in candidate title. */
  set?: string | null;
  /** Year for relevance scoring. +3 when matched in candidate title. */
  year?: number | string | null;
  /** Player first name for relevance scoring. +3 when matched in
   *  candidate title (last name is +5 and also acts as a hard filter). */
  playerFirstName?: string | null;
}

export async function pickerSearch(
  rawQuery: string,
  opts?: PickerSearchOptions,
): Promise<PickerSearchResponse> {
  const requestedLimit = Math.max(1, Math.min(opts?.limit ?? TOP_N, TOP_N));
  const query = (rawQuery || '').replace(/\s{2,}/g, ' ').trim();
  if (!query) {
    return { query: '', active: [], sold: [], soldAvailable: false };
  }

  let active: PickerListing[] = [];
  try {
    const token = await getEbayAccessToken();
    const resp = await sharedHttpClient.get(BROWSE_SEARCH_URL, {
      params: {
        q: query,
        category_ids: SPORTS_CARDS_CATEGORY,
        // Pull a wider candidate pool so the ranker has something to
        // choose from. eBay's relevance/best-match still drives initial
        // recall; we just rerank locally.
        limit: CANDIDATE_POOL_SIZE,
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

    // Score every surviving candidate, then sort by score desc, price asc.
    const scoreCtx: ScoreContext = {
      cardNumber: opts?.requireCardNumber ?? null,
      playerFirstName: opts?.playerFirstName ?? null,
      playerLastName: opts?.requirePlayerLastName ?? null,
      brand: opts?.brand ?? null,
      set: opts?.set ?? null,
      year: opts?.year ?? null,
      scannedParallel: opts?.scannedParallel ?? null,
    };
    type Scored = { listing: PickerListing; score: number; parts: string[] };
    const scored: Scored[] = mapped.map((listing) => {
      const breakdown = scoreTitle(listing.title, scoreCtx);
      return { listing, score: breakdown.score, parts: breakdown.parts };
    });
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.listing.price || 0) - (b.listing.price || 0);
    });

    const top = scored.slice(0, requestedLimit);
    if (top.length > 0) {
      console.log(`[pickerSearch] ranked top ${top.length}/${scored.length} for "${query}":`);
      top.forEach((s, idx) => {
        const breakdown = s.parts.length > 0 ? s.parts.join(' ') : '(no signals)';
        console.log(
          `  ${idx + 1}. score=${s.score} $${s.listing.price.toFixed(2)} | ${s.listing.title}\n     [${breakdown}]`,
        );
      });
    } else {
      console.log(`[pickerSearch] ranked top 0/0 for "${query}" — no candidates after precision filter`);
    }

    active = top.map((s) => ({ ...s.listing, _relevanceScore: s.score }));
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
