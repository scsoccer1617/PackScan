import axios from 'axios';
import { getFoilSearchTerm } from './foilVariantDetector';

function normalizeCollectionForSearch(collection: string): string {
  return collection
    .replace(/\bSeries Two\b/gi, 'Series 2')
    .replace(/\bSeries One\b/gi, 'Series 1')
    .replace(/\bSeries Three\b/gi, 'Series 3');
}

// Generic collection names that eBay sellers never write in listing titles
// — including them in search queries only hurts results.
const GENERIC_COLLECTION_NAMES = new Set(['base set', 'base', 'base cards']);

// Normalize the product "set" name for eBay search.
// Strips brand prefix if redundant (e.g. "Topps Series One" + brand "Topps" → "Series 1").
function normalizeSetForSearch(set: string, brand: string): string {
  let s = set.trim();
  if (brand && s.toLowerCase().startsWith(brand.toLowerCase())) {
    s = s.slice(brand.length).trim();
  }
  return normalizeCollectionForSearch(s);
}

const NUMBER_WORD_TO_DIGIT: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};

function normalizeProductLineText(s: string): string {
  return (s || '')
    .toLowerCase()
    .split(/\s+/)
    .map(w => NUMBER_WORD_TO_DIGIT[w] || w)
    .join(' ');
}

function indicatorBelongsToOurCard(
  indicator: string,
  collection?: string,
  set?: string
): boolean {
  const ind = normalizeProductLineText(indicator);
  const coll = normalizeProductLineText(collection || '');
  const st   = normalizeProductLineText(set || '');
  if (!ind) return false;
  const indWords = ind.split(/\s+/).filter(Boolean);
  if (indWords.length === 0) return false;
  const hasInCollection = !!coll && indWords.every(w => coll.split(/\s+/).includes(w));
  const hasInSet        = !!st   && indWords.every(w => st.split(/\s+/).includes(w));
  return hasInCollection || hasInSet;
}

function discoverVariantFromListings(titles: string[], detectedColor: string | null): string | null {
  if (!detectedColor) return null;
  
  const colorLower = detectedColor.toLowerCase();
  const variantCounts: Record<string, number> = {};
  
  const variantDescriptors = new Set([
    'foil', 'crackle', 'ice', 'shimmer', 'refractor', 'chrome', 'prizm',
    'parallel', 'mojo', 'wave', 'sparkle', 'glitter', 'holo', 'rainbow',
    'atomic', 'sapphire', 'optic', 'mosaic', 'flash', 'laser', 'speckle',
    'mega', 'hyper', 'ultra', 'mini', 'diamond', 'crystal', 'silk',
    'xfractor', 'scope', 'velocity', 'fractal', 'pulsar', 'orbit'
  ]);
  
  for (const title of titles) {
    const titleLower = title.toLowerCase();
    const colorIdx = titleLower.indexOf(colorLower);
    if (colorIdx === -1) continue;
    
    const afterColor = titleLower.substring(colorIdx + colorLower.length).trim();
    const words = afterColor.split(/\s+/);
    
    const descriptors: string[] = [];
    for (const word of words) {
      const cleanWord = word.replace(/[^a-z]/g, '');
      if (cleanWord && variantDescriptors.has(cleanWord)) {
        descriptors.push(cleanWord);
      } else {
        break;
      }
    }
    
    if (descriptors.length > 0) {
      const variantName = descriptors
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      const fullVariant = `${detectedColor} ${variantName}`;
      variantCounts[fullVariant] = (variantCounts[fullVariant] || 0) + 1;
    }
  }
  
  const sorted = Object.entries(variantCounts).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    console.log(`Discovered variant "${sorted[0][0]}" from ${sorted[0][1]} eBay listing(s)`);
    return sorted[0][0];
  }
  return null;
}

function discoverVariantFromTitlesBlind(titles: string[], playerName: string): string | null {
  const nameParts = (playerName || '').trim().split(' ').filter(Boolean);
  const playerLast = nameParts[nameParts.length - 1]?.toLowerCase() || '';
  
  const variantPatterns = [
    /\b(aqua\s+crackle\s+foil)\b/i,
    /\b(aqua\s+ice\s+foil)\b/i,
    /\b(aqua\s+shimmer\s+foil)\b/i,
    /\b(aqua\s+foil)\b/i,
    /\b(blue\s+crackle\s+foil)\b/i,
    /\b(blue\s+foil)\b/i,
    /\b(green\s+foil)\b/i,
    /\b(gold\s+foil)\b/i,
    /\b(red\s+foil)\b/i,
    /\b(purple\s+foil)\b/i,
    /\b(orange\s+foil)\b/i,
    /\b(pink\s+foil)\b/i,
    /\b(silver\s+foil)\b/i,
    /\b(rainbow\s+foil)\b/i,
    /\b(chrome\s+refractor)\b/i,
    /\b(gold\s+refractor)\b/i,
    /\b(black\s+refractor)\b/i,
    /\b(refractor)\b/i,
    /\b(xfractor)\b/i,
    /\b(prizm)\b/i,
    /\b(holo)\b/i,
    /\b(mojo)\b/i,
  ];
  
  const variantCounts: Record<string, number> = {};
  
  for (const title of titles) {
    const titleLower = title.toLowerCase();
    if (!titleLower.includes(playerLast)) continue;
    
    for (const pattern of variantPatterns) {
      const match = title.match(pattern);
      if (match) {
        const variant = match[1].split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        variantCounts[variant] = (variantCounts[variant] || 0) + 1;
        break;
      }
    }
  }
  
  const sorted = Object.entries(variantCounts).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    console.log(`Blind variant discovery found "${sorted[0][0]}" from ${sorted[0][1]} listing(s) matching player`);
    return sorted[0][0];
  }
  return null;
}

function extractColorFromVariant(variant: string | undefined): string | null {
  if (!variant) return null;
  const colors = ['Aqua', 'Blue', 'Green', 'Red', 'Gold', 'Silver', 'Purple', 'Orange', 'Pink'];
  // Prefer the color at the start (e.g. "Green Foil")
  for (const color of colors) {
    if (variant.toLowerCase().startsWith(color.toLowerCase())) return color;
  }
  // Fall back to color anywhere in the name (e.g. "Holiday Green Leaf" → "Green")
  for (const color of colors) {
    if (new RegExp(`\\b${color}\\b`, 'i').test(variant)) return color;
  }
  return null;
}

function getEbayAppId(): string {
  return process.env.EBAY_APP_ID || '';
}


// Interface for eBay search results
interface EbaySearchResult {
  title: string;
  price: number;
  currency: string;
  url: string;
  imageUrl: string;
  condition: string;
  endTime: string;
}

// Interface for the complete response
interface EbayResponse {
  averageValue: number;
  results: EbaySearchResult[];
  searchUrl?: string;
  errorMessage?: string;
  dataType?: 'sold' | 'current';
  discoveredVariant?: string;
  discoveredCollection?: string;
}

/**
 * Search eBay for completed/sold items matching card criteria
 */
// Simple cache to reduce API calls
const searchCache = new Map<string, { data: any; timestamp: number; isError?: boolean }>();
const CACHE_DURATION = 300000;       // 5 minute cache for successful results
const ERROR_CACHE_DURATION = 300000; // 5 minute cache for errors/empty results (prevents hammering)

// Clear cache function for debugging
export function clearEbayCache() {
  searchCache.clear();
  console.log('eBay search cache cleared');
}

// Clear cache immediately on module load to start fresh
clearEbayCache();

// Keywords that signal a parallel/special version — used to penalise base-card searches.
// Deliberately excludes product-line names that appear in BASE card titles too
// (e.g. "chrome" in "Bowman Chrome", "prizm" in "Panini Prizm", "optic"/"mosaic" as set names).
const PARALLEL_KEYWORDS = [
  'refractor', 'xfractor', 'x-fractor', 'foilboard',
  'holo', 'holographic', 'rainbow', 'parallel',
  'mojo', 'sparkle', 'glitter', 'laser',
  'fractal', 'pulsar', 'atomic', 'silk',
  'crackle', 'shimmer', 'sepia', 'sapphire',
  'wave', 'waves', 'velocity', 'fast break', 'cracked ice',
  'aqua foil', 'blue foil', 'red foil', 'green foil', 'gold foil',
  'purple foil', 'orange foil', 'pink foil', 'silver foil', 'rainbow foil',
  'black foil', 'rose gold',
];

// Keywords that signal an autograph — used to penalise non-auto searches
const AUTO_KEYWORDS = [
  'auto', 'autograph', 'autographed', 'signed', 'signature', 'on-card'
];

/**
 * Prioritize eBay listings based on how well they match the card information
 * Higher scores = better matches = higher priority
 */
function prioritizeListingsByCardMatch(
  results: EbaySearchResult[],
  playerName: string,
  cardNumber: string,
  brand: string,
  year: number,
  collection?: string,
  foilType?: string,
  isAutographed?: boolean,
  serialNumber?: string,
  set?: string
): EbaySearchResult[] {
  return results.map(result => {
    const title = result.title.toLowerCase();
    let score = 0;
    const matchedElements: string[] = [];
    
    // Player name match (highest priority - 100 points)
    const nameParts = (playerName || '').trim().split(' ').filter(Boolean);
    const playerFirstName = nameParts[0]?.toLowerCase() || '';
    const playerLastName = nameParts.slice(1).join(' ').toLowerCase();

    if (playerFirstName && playerLastName && title.includes(playerFirstName) && title.includes(playerLastName)) {
      score += 100;
      matchedElements.push('full name');
    } else if (playerLastName && title.includes(playerLastName)) {
      score += 75;
      matchedElements.push('last name');
    } else if (playerFirstName && title.includes(playerFirstName)) {
      score += 50;
      matchedElements.push('first name');
    }
    
    // Card number match (high priority - 75 points if exact match)
    if (cardNumber && cardNumber.trim()) {
      // Look for exact card number match with common formats
      const cardNumRegex = new RegExp(`\\b${cardNumber}\\b|#${cardNumber}\\b|${cardNumber}\\s|\\s${cardNumber}\\b`, 'i');
      if (cardNumRegex.test(title)) {
        score += 75;
        matchedElements.push(`card #${cardNumber}`);
      }
    }
    
    // Year match (high priority - 60 points)
    if (year && year > 0) {
      const yearStr = year.toString();
      // Look for year in common formats: "2023", "2023-24", "23-24"
      if (title.includes(yearStr) || title.includes(`${yearStr}-${(year + 1).toString().slice(-2)}`)) {
        score += 60;
        matchedElements.push(`year ${yearStr}`);
      }
    }
    
    // Brand match (medium priority - 40 points)
    if (brand && title.includes(brand.toLowerCase())) {
      score += 40;
      matchedElements.push(`brand ${brand}`);
    }
    
    // Collection match (medium priority - 30 points)
    if (collection && title.includes(collection.toLowerCase())) {
      score += 30;
      matchedElements.push(`collection ${collection}`);
    }

    // Penalize listings from a DIFFERENT collection/product line when one is specified.
    // e.g. searching "Bowman Chrome" should not return "Sapphire Edition" or "Draft" listings.
    // Skip generic collection names (e.g. "Base Set") that shouldn't trigger filtering.
    if (collection && !['base set', 'base', 'base cards'].includes(collection.toLowerCase())) {
      const collLower = collection.toLowerCase();
      const COLLECTION_INDICATORS = [
        'chrome', 'sapphire', 'sapphire edition', 'draft',
        'heritage', 'sterling', 'platinum', 'finest', 'stadium club',
        'gallery', 'select', 'optic', 'prizm', 'mosaic', 'donruss',
        'series 1', 'series 2', 'series 3', 'update', 'traded',
        'opening day', 'big league', 'archives', 'allen & ginter',
        'allen and ginter', 'gypsy queen', 'tier one', 'luminaries',
        'definitive', 'dynasty', 'tribute', 'museum', 'inception',
        'gold label', 'five star', 'national treasures', 'immaculate',
        'flawless', 'noir', 'spectra', 'obsidian', 'clearly authentic',
        '1st edition', 'first edition', 'mega box', 'holiday',
        'bowman chrome', 'topps chrome', 'bowman draft', 'bowman sterling',
      ];
      for (const indicator of COLLECTION_INDICATORS) {
        // Skip indicators that describe OUR card's product line (collection OR set).
        // E.g. card collection="Baseball Stars Autographs" set="Series Two" should NOT
        // treat "series 2" in a listing title as a wrong-collection signal — that's
        // exactly the product set this card lives in.
        if (indicatorBelongsToOurCard(indicator, collection, set)) continue;
        const re = new RegExp(`\\b${indicator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i');
        if (re.test(title)) {
          score -= 80;
          console.log(`  ↳ Wrong-collection penalty (-80): searching "${collection}" but title has "${indicator}"`);
          break;
        }
      }
    }
    
    // Foil type match (medium priority - 50 points for special variants)
    if (foilType) {
      const foilSearchTerm = getFoilSearchTerm(foilType).toLowerCase();
      if (foilSearchTerm && title.includes(foilSearchTerm)) {
        score += 50;
        matchedElements.push(`foil ${foilType}`);
      }
      
      // Also check for common foil terminology
      const foilKeywords = ['holo', 'foil', 'chrome', 'refractor', 'laser', 'prizm'];
      for (const keyword of foilKeywords) {
        if (title.includes(keyword)) {
          score += 25;
          matchedElements.push(`foil variant`);
          break;
        }
      }

      // Penalize listings with a DIFFERENT parallel variant than what we searched for.
      // e.g. searching "Aqua Foil" but listing says "Aqua Crackle Foil" — different parallel.
      if (foilSearchTerm) {
        const foilWords = foilSearchTerm.split(/\s+/);
        const wrongParallelQualifiers = [
          'crackle', 'shimmer', 'ice', 'lava', 'mosaic', 'wave', 'sparkle',
          'glitter', 'mojo', 'prism', 'atomic', 'mega', 'super', 'hyper',
          'chrome', 'silk', 'satin', 'marble', 'camo', 'speckle', 'snow',
          'fire', 'electric', 'neon', 'fluorescent', 'frost', 'arctic',
          'sapphire', 'ruby', 'emerald', 'diamond', 'platinum', 'titanium',
          'border', 'refractor', 'xfractor', 'leaf', 'vintage', 'retro',
          'candy', 'holiday', 'independence'
        ];
        for (const qualifier of wrongParallelQualifiers) {
          if (!foilWords.includes(qualifier) && new RegExp(`\\b${qualifier}\\b`, 'i').test(title)) {
            score -= 100;
            console.log(`  ↳ Wrong-parallel penalty (-100): searching "${foilSearchTerm}" but title has "${qualifier}"`);
            break;
          }
        }
      }
    }
    
    // Penalize generic listings (reduce score)
    const genericPhrases = [
      'you pick', 'choose', 'select', 'various', 'multiple', 
      'lot of', 'mixed lot', 'random', 'grab bag'
    ];
    
    for (const phrase of genericPhrases) {
      if (title.includes(phrase)) {
        score -= 30;
        break;
      }
    }
    
    // Penalize very different years (major penalty)
    if (year && year > 0) {
      const yearMatches = title.match(/\b(19|20)\d{2}\b/g);
      if (yearMatches) {
        const listingYears = yearMatches.map(y => parseInt(y));
        const hasCorrectYear = listingYears.some(y => Math.abs(y - year) <= 1);
        if (!hasCorrectYear) {
          score -= 50; // Major penalty for wrong year
        }
      }
    }

    // Penalize autograph/signed listings when the card is not an autograph
    if (!isAutographed) {
      const hasAuto = AUTO_KEYWORDS.some(kw => {
        // Use word-boundary check: "auto" in "automatic" should not trigger
        const re = new RegExp(`\\b${kw}\\b`, 'i');
        return re.test(title);
      });
      if (hasAuto) {
        score -= 80;
        console.log(`  ↳ Auto penalty (-80): title contains autograph keyword`);
      }
    }

    // For base cards (no foilType), penalize listings that mention any parallel/foil keyword
    const isBaseCard = !foilType || foilType.trim() === '';
    if (isBaseCard) {
      const hasParallel = PARALLEL_KEYWORDS.some(kw => {
        const re = new RegExp(`\\b${kw}\\b`, 'i');
        return re.test(title);
      });
      if (hasParallel) {
        score -= 200;
        console.log(`  ↳ Parallel penalty (-200): base card but title contains parallel/foil keyword`);
      }

      // "Chrome" is a parallel for many products (e.g. Stadium Club Chrome) but is a
      // base product line for others (Topps Chrome, Bowman Chrome). Penalise dynamically:
      // only if our card's set/brand isn't itself a *Chrome product line AND the title
      // adds "chrome" on top of the set name.
      const ownLine = `${(brand || '').toLowerCase()} ${(set || '').toLowerCase()} ${(collection || '').toLowerCase()}`;
      const ownIsChromeLine = /\bchrome\b/.test(ownLine);
      if (!ownIsChromeLine && /\bchrome\b/i.test(title)) {
        score -= 200;
        console.log(`  ↳ Chrome-parallel penalty (-200): our card isn't a Chrome product line but title contains "chrome"`);
      }
    }

    // For numbered cards, penalize listings with a different serial limit in the title
    if (serialNumber) {
      const ownSerial = serialNumber.match(/\/(\d+)/)?.[1];
      if (ownSerial) {
        // Find all /NNN patterns in the listing title
        const titleSerials = [...title.matchAll(/\/(\d+)/g)].map(m => m[1]);
        if (titleSerials.length > 0 && !titleSerials.includes(ownSerial)) {
          score -= 40;
          console.log(`  ↳ Serial mismatch penalty (-40): card is /${ownSerial} but listing shows /${titleSerials.join(', /')}`);
        }
      }
    }

    console.log(`Listing "${result.title}" scored ${score} points (matched: ${matchedElements.join(', ') || 'none'})`);
    
    return { ...result, matchScore: score };
  }).sort((a, b) => (b as any).matchScore - (a as any).matchScore);
}

export async function searchCardValues(
  playerName: string,
  cardNumber: string,
  brand: string,
  year: number,
  collection?: string,
  condition?: string,
  isNumbered?: boolean,
  foilType?: string,
  serialNumber?: string,
  variant?: string,
  isAutographed?: boolean,
  _isRetry?: boolean,
  set?: string
): Promise<EbayResponse> {
  try {
    // Strip middle names before any eBay query — sellers virtually always
    // list cards with just "First Last" (e.g. "Bruce Sutter"), not the
    // player's full legal name ("Howard Bruce Sutter"). Keeping the middle
    // name in the keywords causes eBay to return zero matches even when
    // the card is widely sold. We keep the first and last tokens; if the
    // input is already 1 or 2 tokens we leave it alone.
    const stripMiddleNames = (name: string): string => {
      const tokens = (name || '').trim().split(/\s+/).filter(Boolean);
      if (tokens.length <= 2) return tokens.join(' ');
      // Generational suffixes (Jr, Sr, II, III, IV) belong with the last
      // name on eBay listings — keep them attached. e.g.
      // "Cal Joseph Ripken Jr" → "Cal Ripken Jr", not "Cal Jr".
      const suffixRe = /^(jr|sr|ii|iii|iv|v)\.?$/i;
      const last = tokens[tokens.length - 1];
      if (suffixRe.test(last) && tokens.length >= 3) {
        return `${tokens[0]} ${tokens[tokens.length - 2]} ${last}`;
      }
      return `${tokens[0]} ${last}`;
    };
    const originalPlayerName = playerName;
    playerName = stripMiddleNames(playerName);
    if (playerName !== originalPlayerName) {
      console.log(`[eBay] Stripped middle name(s) for search: "${originalPlayerName}" → "${playerName}"`);
    }
    // Create cache key from search parameters including foil type and serial number
    const cacheKey = `${playerName}-${cardNumber}-${brand}-${year}-${collection || ''}-${isNumbered || ''}-${foilType || ''}-${serialNumber || ''}-${variant || ''}`;
    const cached = searchCache.get(cacheKey);
    
    // Return cached result if still valid
    if (cached) {
      const maxAge = cached.isError ? ERROR_CACHE_DURATION : CACHE_DURATION;
      if ((Date.now() - cached.timestamp) < maxAge) {
        console.log(`Returning cached eBay results for: ${cacheKey} (isError=${cached.isError})`);
        return cached.data;
      }
    }

    const rawCollection = collection || '';
    // Use the product set name ("Series 1") for eBay searches when available,
    // because that's what sellers actually write in listing titles.
    // Fall back to collection only if it's not a generic placeholder like "Base Set".
    const searchSet = set ? normalizeSetForSearch(set, brand) : '';
    const collectionForSearch = !GENERIC_COLLECTION_NAMES.has(rawCollection.toLowerCase())
      ? normalizeCollectionForSearch(rawCollection)
      : '';
    // Prefer set (product name) over collection (subset name) in queries
    const searchCollection = searchSet || collectionForSearch;
    
    let serialSuffix = '';
    if (isNumbered && serialNumber) {
      const serialMatch = serialNumber.match(/\/(\d+)$/);
      if (serialMatch) {
        serialSuffix = `/${serialMatch[1]}`;
      }
    }
    
    let variantKeyword = '';
    if (variant && variant.trim()) {
      variantKeyword = variant;
    } else if (foilType) {
      variantKeyword = foilType;
    }
    
    const isBaseCard = !foilType || foilType.trim() === '';
    const isAuto     = !!isAutographed;

    // Build eBay negative-keyword exclusions.
    // These are prefixed with "-" and appended to the query so eBay filters them
    // at the API level, well before our scoring step.
    const buildNegativeKeywords = (): string => {
      const excludes: string[] = [];

      // Always exclude autograph/signed listings for non-auto cards
      if (!isAuto) {
        excludes.push('-autograph', '-signed');
      }

      // Exclude parallel-indicator terms for base cards.
      // We deliberately skip standalone colours (blue, gold, etc.) to avoid
      // accidentally excluding team-colour references in listing titles.
      if (isBaseCard) {
        excludes.push('-parallel', '-refractor', '-xfractor', '-rainbow', '-mojo', '-holo');
      }

      return excludes.join(' ');
    };

    // Color keyword extracted from the foilType for use in intermediate fallback searches.
    // e.g. "Holiday Green Leaf" → "Green", "Blue Crackle Foil" → "Blue"
    const foilColorKeyword = extractColorFromVariant(foilType || undefined) ?? '';

    const buildKeywords = (opts: { includeVariant?: boolean; variantOverride?: string; includeCardNumber?: boolean; includeSerial?: boolean; includeNegatives?: boolean } = {}): string => {
      const { includeVariant = true, variantOverride, includeCardNumber = true, includeSerial = true, includeNegatives = true } = opts;
      const parts: string[] = [];
      
      if (year > 0) parts.push(String(year));
      if (brand) parts.push(brand);
      if (searchCollection) parts.push(searchCollection);
      parts.push(playerName);
      
      if (includeCardNumber && cardNumber) {
        parts.push(/^\d+$/.test(cardNumber) ? `#${cardNumber}` : cardNumber);
      }
      
      const effectiveVariant = variantOverride !== undefined ? variantOverride : (includeVariant ? variantKeyword : '');
      if (effectiveVariant) {
        parts.push(effectiveVariant);
      }
      
      if (includeSerial && serialSuffix) {
        parts.push(serialSuffix);
      }

      if (includeNegatives) {
        const neg = buildNegativeKeywords();
        if (neg) parts.push(neg);
      }
      
      return parts.filter(Boolean).join(' ');
    }
    
    let keywords = buildKeywords();
    console.log('Searching eBay sold listings with keywords:', keywords);

    const safePlayerName = playerName || '';
    let results: EbaySearchResult[] = [];
    let dataType: 'sold' | 'current' = 'sold';
    const fallbackSearchUrl = getEbaySearchUrl(safePlayerName, cardNumber, brand, year, collection, '', isNumbered, foilType, serialNumber);

    // Use eBay Finding API (findCompletedItems) to get sold listings.
    // This API is accessible from Replit servers (unlike the web UI which hits Akamai bot protection).
    // The Finding API is "legacy" but still functional for this use case.
    const callEbaySoldSearch = async (query: string): Promise<EbaySearchResult[]> => {
      const appId = getEbayAppId();
      if (!appId) {
        console.log('[eBay Finding API] No APP_ID configured');
        return [];
      }

      // Strip negative keyword tokens (e.g. "-autograph") — the Finding API
      // doesn't support them, and our scoring/hard-filter handles this filtering.
      const cleanQuery = query.replace(/-\S+/g, '').replace(/\s{2,}/g, ' ').trim();

      const params: Record<string, string> = {
        'OPERATION-NAME': 'findCompletedItems',
        'SERVICE-VERSION': '1.0.0',
        'SECURITY-APPNAME': appId,
        'RESPONSE-DATA-FORMAT': 'JSON',
        'REST-PAYLOAD': '',
        'keywords': cleanQuery,
        'categoryId': '213',
        'itemFilter(0).name': 'SoldItemsOnly',
        'itemFilter(0).value': 'true',
        'paginationInput.entriesPerPage': '20',
        'sortOrder': 'EndTimeSoonest'
      };

      const resp = await axios.get('https://svcs.ebay.com/services/search/FindingService/v1', {
        params,
        timeout: 20000
      });

      const data = resp.data;
      const ack = data?.findCompletedItemsResponse?.[0]?.ack?.[0];
      const rawItems: any[] = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];

      if (ack && ack !== 'Success' && ack !== 'Warning') {
        const errorMsg = data?.findCompletedItemsResponse?.[0]?.errorMessage?.[0]?.error?.[0]?.message?.[0] || ack;
        console.log(`[eBay Finding API] Non-success ACK: ${ack} — ${errorMsg}`);
        return [];
      }

      const items: EbaySearchResult[] = rawItems.map((item: any) => {
        const title = item.title?.[0] || '';
        const priceVal = item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__;
        const price = priceVal ? parseFloat(priceVal) : 0;
        const currency = item.sellingStatus?.[0]?.currentPrice?.[0]?.['@currencyId'] || 'USD';
        const url = item.viewItemURL?.[0] || '';
        const imageUrl = item.galleryURL?.[0] || '';
        const condition = item.condition?.[0]?.conditionDisplayName?.[0] || '';
        const endTime = item.listingInfo?.[0]?.endTime?.[0] || '';
        return { title, price, currency, url, imageUrl, condition, endTime };
      }).filter(i => i.price > 0 && i.title);

      console.log(`[eBay Finding API] ACK: ${ack}, returned ${rawItems.length} items, ${items.length} valid for: "${cleanQuery}"`);
      return items;
    };

    // eBay Browse API fallback: returns active listings when the Finding API is rate-limited.
    // Uses OAuth Client Credentials (EBAY_APP_ID + EBAY_CERT_ID).
    const callEbayBrowseSearch = async (query: string): Promise<EbaySearchResult[]> => {
      const { getEbayAccessToken } = await import('./ebayTokenManager.js');
      const token = await getEbayAccessToken();
      const cleanQuery = query.replace(/-\S+/g, '').replace(/\s{2,}/g, ' ').trim();

      const resp = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
        params: {
          q: cleanQuery,
          category_ids: '213',
          limit: 20,
          sort: 'newlyListed'
        },
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
        },
        timeout: 20000
      });

      const rawItems: any[] = resp.data?.itemSummaries || [];
      const items: EbaySearchResult[] = rawItems.map((item: any) => ({
        title: item.title || '',
        price: parseFloat(item.price?.value || '0'),
        currency: item.price?.currency || 'USD',
        url: item.itemWebUrl || '',
        imageUrl: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || '',
        condition: item.condition || '',
        endTime: item.itemEndDate || ''
      })).filter(i => i.price > 0 && i.title);

      console.log(`[eBay Browse API] returned ${rawItems.length} items, ${items.length} valid for: "${cleanQuery}"`);
      return items;
    };

    // Returns true if the error is a rate-limit from the Finding API
    const isFindingApiRateLimit = (err: any): boolean => {
      const body = err?.response?.data;
      const errorId = body?.errorMessage?.[0]?.error?.[0]?.errorId?.[0];
      return errorId === '10001' || err?.response?.status === 500;
    };

    // Wraps callEbaySoldSearch with a Browse API fallback on rate-limit
    const callSearchWithFallback = async (query: string): Promise<EbaySearchResult[]> => {
      try {
        return await callEbaySoldSearch(query);
      } catch (findingErr: any) {
        if (isFindingApiRateLimit(findingErr)) {
          console.log('[eBay] Finding API rate-limited — falling back to Browse API (active listings)');
          dataType = 'current';
          return await callEbayBrowseSearch(query);
        }
        throw findingErr;
      }
    };

    try {
      results = await callSearchWithFallback(keywords);

      if (results.length === 0 && !isBaseCard && foilColorKeyword && foilColorKeyword.toLowerCase() !== variantKeyword.toLowerCase()) {
        // Pass 2a (parallel only): full foil name had no results → try just the color keyword
        // e.g. "Holiday Green Leaf" → search with "Green" so eBay returns "Green Foil /99" listings
        const colorKeywords = buildKeywords({ variantOverride: foilColorKeyword });
        if (colorKeywords && colorKeywords !== keywords) {
          results = await callSearchWithFallback(colorKeywords);
          console.log(`Search (color keyword "${foilColorKeyword}" fallback) returned ${results.length} results`);
        }
      }

      if (results.length === 0) {
        // Pass 2b: broader query — drop card number, variant, serial (keep negatives)
        const broaderKeywords = buildKeywords({ includeCardNumber: false, includeVariant: false, includeSerial: false });
        if (broaderKeywords && broaderKeywords !== keywords) {
          results = await callSearchWithFallback(broaderKeywords);
          console.log(`Search (broader query) returned ${results.length} results`);
        }
      }

      if (results.length === 0) {
        // Pass 3: last resort — same as pass 2b but drop negative keywords too
        const broadestKeywords = buildKeywords({ includeCardNumber: false, includeVariant: false, includeSerial: false, includeNegatives: false });
        if (broadestKeywords) {
          results = await callSearchWithFallback(broadestKeywords);
          console.log(`Search (broadest query, no negatives) returned ${results.length} results`);
        }
      }
    } catch (searchError: any) {
      const status = searchError.response?.status;
      console.log(`eBay search unavailable (HTTP ${status ?? 'no-response'}): ${searchError.message}`);
      const errorResp = {
        averageValue: 0,
        results: [],
        searchUrl: fallbackSearchUrl,
        errorMessage: 'Price data currently unavailable',
        dataType: 'sold' as const
      };
      searchCache.set(cacheKey, { data: errorResp, timestamp: Date.now(), isError: true });
      return errorResp;
    }

    if (results.length === 0) {
      const emptyResp = {
        averageValue: 0,
        results: [],
        searchUrl: fallbackSearchUrl,
        errorMessage: dataType === 'sold' ? 'No sold listings found' : 'No active listings found',
        dataType
      };
      searchCache.set(cacheKey, { data: emptyResp, timestamp: Date.now(), isError: true });
      return emptyResp;
    }

    const prioritizedResults = prioritizeListingsByCardMatch(
      results,
      safePlayerName,
      cardNumber,
      brand,
      year,
      collection,
      foilType,
      isAutographed,
      serialNumber,
      set
    );

    // ── Hard post-filter ─────────────────────────────────────────────────────
    // Remove listings that clearly don't match the card type BEFORE picking top 5.
    // This is more reliable than scoring alone because if every eBay result is a
    // parallel, scoring penalties still leave parallels in the top 5.
    const isBaseCardSearch = !foilType || foilType.trim() === '';
    const isNumberedCard   = !!isNumbered;

    // Terms that definitively indicate a parallel/special version (word-boundary matched)
    const HARD_PARALLEL_TERMS = [
      'parallel', 'refractor', 'xfractor', 'rainbow', 'mojo', 'holo', 'holographic',
      'foilboard', 'sparkle', 'glitter', 'prizm', 'laser', 'atomic', 'crackle', 'shimmer',
      'foil',
      // One-word foil compounds — `\bfoil\b` does NOT match "Holofoil" because
      // it's a single token. Add the common compounds explicitly so titles like
      // "2026 Topps Series 1 ... Holofoil & Confetti" get hard-filtered out of
      // a base-card search instead of slipping through with just a -60 penalty.
      'holofoil', 'foilfractor', 'superfractor',
      // Topps "theme" parallels — these names are essentially never used on
      // base cards, only on the holiday/event-themed parallel inserts
      // (Easter, Spring Training, Mother's/Father's Day, Halloween, Holiday,
      // 4th of July, Memorial Day, Independence Day, Black Friday, Cyber
      // Monday, Pride). Confetti / Pattern are texture-named parallels that
      // similarly only ever appear on parallel printings.
      'easter', 'confetti', 'holiday', 'spring training',
      'mothers day', "mother's day", 'fathers day', "father's day",
      'memorial day', 'independence day', 'halloween',
      '4th of july', 'fourth of july', 'black friday', 'cyber monday',
      'pride', 'foil pattern', 'pattern foil',
      // Visual / pattern parallels — these names only ever appear on the
      // themed parallel printings, never on base cards.
      'polka dot', 'polka dots', 'flowers foil', 'easter eggs',
      // Team Color Border / Team Border are Topps parallels (border tinted to
      // team colours). "Short Print" / "SSP" (super short print) likewise only
      // appear on parallel/insert printings. We deliberately do NOT include
      // bare "SP" — it's too short and collides with abbreviations in other
      // contexts (Spring, Special, Sport). "SSP" is unambiguous.
      'team border', 'team color border', 'team colour border',
      'short print', 'ssp',
      'golden mirror', 'mirror foil',
      'gold refractor', 'black refractor', 'blue refractor', 'red refractor',
      'montgomery club'
    ];

    // Named parallel variants — always indicate a parallel, not a team colour.
    // NOTE: Do NOT include product-line names here — "sapphire" (Bowman Chrome Sapphire),
    // "chrome" (Bowman Chrome), "heritage" (Topps Heritage), "vintage" (Topps Vintage)
    // are set names, not parallel colours.
    const PARALLEL_COLORS = [
      'royal blue', 'sky blue', 'ice blue', 'aqua',
      'neon green', 'lime green', 'neon pink', 'hot pink',
      'teal', 'burgundy', 'copper', 'magenta', 'platinum',
      'rose gold', 'emerald', 'ruby', 'amethyst', 'cobalt',
      'arctic', 'electric', 'independence day',
      'jack-o\'-lantern', 'jack o lantern', 'pumpkin', 'camo',
      'camouflage', 'snow', 'lava', 'fire'
    ];

    // Single-word colour names used as Topps/Bowman/Panini parallel names.
    // In eBay titles these typically appear between the set/brand name and the
    // player name (e.g. "2024 Topps Update Yellow Jose Butto").
    // We filter these for base-card searches because if the scan detected no
    // parallel, any colour-named variant is a mismatch.
    const AMBIGUOUS_COLORS = [
      'blue', 'green', 'red', 'gold', 'silver', 'purple',
      'orange', 'pink', 'yellow', 'black', 'white'
    ];

    // Builds a regex that matches a colour word appearing between the
    // brand/set and the player name — the position where parallel names
    // appear in eBay listing titles.
    const playerLast = (safePlayerName || '').split(' ').pop()?.toLowerCase() || '';
    const brandLower = (brand || '').toLowerCase();

    // Terms that definitively indicate an autograph
    const HARD_AUTO_TERMS = ['autograph', 'autographed', 'on-card auto', 'signed'];

    const foilSearchTermLower = foilType ? getFoilSearchTerm(foilType).toLowerCase() : '';
    const foilSearchWords = foilSearchTermLower ? foilSearchTermLower.split(/\s+/) : [];
    const WRONG_PARALLEL_QUALIFIERS = [
      'crackle', 'shimmer', 'ice', 'lava', 'mosaic', 'wave', 'sparkle',
      'glitter', 'mojo', 'prism', 'atomic', 'mega', 'super', 'hyper',
      'chrome', 'silk', 'satin', 'marble', 'camo', 'speckle', 'snow',
      'fire', 'electric', 'neon', 'fluorescent', 'frost', 'arctic',
      'sapphire', 'ruby', 'emerald', 'diamond', 'platinum', 'titanium',
      'border', 'refractor', 'xfractor', 'leaf', 'vintage', 'retro',
      'candy', 'holiday', 'independence',
      // Foil/parallel family keywords commonly used in eBay titles. When the
      // user's selected parallel doesn't include these words, any listing
      // that does is a different parallel and should be filtered.
      'rainbow', 'diamante', 'holo', 'holographic', 'foilboard',
      'sandglitter', 'sapphire', 'prizm', 'optic', 'chromium',
      'sepia', 'negative', 'superfractor',
      // Photo/image-variation cards (e.g. "Golden Mirror Image Variation",
      // "Photo Variation", "Image Swap") are SP variations, not foil parallels.
      // When searching for a specific foil parallel, these should be filtered.
      'mirror image', 'image variation', 'photo variation', 'image swap',
      'sp variation', 'ssp variation', 'variation sp', 'variation ssp',
    ];

    const hardFilter = (r: EbaySearchResult): boolean => {
      const t = r.title.toLowerCase();

      // Filter autographs when card is not autographed
      if (!isAutographed) {
        const hasAuto = HARD_AUTO_TERMS.some(kw => {
          const re = new RegExp(`\\b${kw.replace(/[-]/g, '\\s*')}\\b`, 'i');
          return re.test(t);
        });
        if (hasAuto) return false;
      }

      // Filter wrong-parallel listings when a specific parallel is requested.
      // e.g. searching "Aqua Foil" → filter out "Aqua Crackle Foil" listings.
      if (foilSearchTermLower && !isBaseCardSearch) {
        const hasWrongQualifier = WRONG_PARALLEL_QUALIFIERS.some(q =>
          !foilSearchWords.includes(q) && new RegExp(`\\b${q}\\b`, 'i').test(t)
        );
        // Word-boundary check on the foil term: substring match would let
        // "golden" satisfy a "gold" search and bypass the filter incorrectly.
        const foilTermRe = new RegExp(`\\b${foilSearchTermLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i');
        if (hasWrongQualifier && !foilTermRe.test(t)) {
          console.log(`  ↳ Hard-filtered (wrong parallel): searching "${foilSearchTermLower}" but title="${r.title}"`);
          return false;
        }

        // Filter colour-qualified variants of the user's parallel that the user
        // didn't ask for. e.g. user wants "Diamante Foil" → filter out
        // "Pink Diamante Foil", "Blue Diamante Foil", etc. (sport-agnostic).
        const COLOR_QUALIFIERS = [
          'blue', 'green', 'red', 'gold', 'silver', 'purple', 'orange',
          'pink', 'yellow', 'black', 'white', 'aqua', 'teal', 'rose',
          'sky', 'royal', 'neon', 'hot', 'sapphire', 'ruby', 'emerald',
          'platinum', 'rainbow', 'magenta', 'copper', 'burgundy'
        ];
        const firstFoilWord = foilSearchWords.find(w => !COLOR_QUALIFIERS.includes(w));
        if (firstFoilWord) {
          for (const color of COLOR_QUALIFIERS) {
            if (foilSearchWords.includes(color)) continue;
            const re = new RegExp(`\\b${color}\\s+${firstFoilWord}\\b`, 'i');
            if (re.test(t)) {
              console.log(`  ↳ Hard-filtered (colour-qualified parallel "${color} ${firstFoilWord}"): searching "${foilSearchTermLower}" but title="${r.title}"`);
              return false;
            }
          }
        }
      }

      // Filter wrong-collection listings when a specific collection is set.
      // e.g. searching "Chrome" should not return "Sapphire Edition" or "Draft" results.
      // Use rawCollection (the actual collection name like "Chrome"), NOT searchCollection
      // which may be a generic set name like "Baseball".
      if (rawCollection && !GENERIC_COLLECTION_NAMES.has(rawCollection.toLowerCase())) {
        const HARD_COLLECTION_INDICATORS = [
          'chrome', 'sapphire', 'sapphire edition', 'draft',
          'heritage', 'sterling', 'finest', 'stadium club',
          'gallery', 'select', 'optic', 'prizm', 'mosaic', 'donruss',
          'series 1', 'series 2', 'series 3', 'update', 'traded',
          'opening day', 'big league', 'archives', 'allen & ginter',
          'gypsy queen', 'tier one', 'inception', 'gold label',
          'national treasures', 'immaculate', 'clearly authentic',
          '1st edition', 'bowman chrome', 'topps chrome', 'bowman draft',
        ];
        for (const indicator of HARD_COLLECTION_INDICATORS) {
          // Skip indicators that describe OUR card's own product line (collection OR set).
          // E.g. when collection="Baseball Stars Autographs" and set="Series Two", the
          // indicator "series 2" is OUR card's set, not a foreign collection.
          if (indicatorBelongsToOurCard(indicator, rawCollection, set)) continue;
          const re = new RegExp(`\\b${indicator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i');
          if (re.test(t)) {
            console.log(`  ↳ Hard-filtered (wrong collection): searching "${rawCollection}" but title has "${indicator}" → "${r.title}"`);
            return false;
          }
        }
      }

      // Filter parallels when card is a base card
      if (isBaseCardSearch) {
        const hasParallel = HARD_PARALLEL_TERMS.some(kw => {
          const re = new RegExp(`\\b${kw.replace(/\s+/g, '\\s+')}\\b`, 'i');
          return re.test(t);
        });
        if (hasParallel) return false;

        // Filter serially-numbered listings (e.g. /150, /75, /250) —
        // a non-numbered base card should never match a /NNN print run.
        const serialInTitle = t.match(/\/(\d+)/g);
        const hasSmallSerial = serialInTitle?.some(s => {
          const n = parseInt(s.slice(1), 10);
          return n > 0 && n <= 5000;
        });
        if (!isNumberedCard && hasSmallSerial) return false;

        // Filter named-parallel colour/variant terms (e.g. "Royal Blue", "Sapphire",
        // "Jack-O'-Lantern") — these always indicate a parallel.
        const hasNamedColor = PARALLEL_COLORS.some(kw => {
          const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
          return new RegExp(`\\b${escaped}`, 'i').test(t);
        });
        if (hasNamedColor) {
          console.log(`  ↳ Hard-filtered (named parallel colour): "${r.title}"`);
          return false;
        }

        // Filter ambiguous single-word colours (blue, gold, yellow, etc.).
        // These indicate a parallel when they appear in a "variant position" in the
        // eBay title — typically between the brand/set and the player name, e.g.
        // "2024 Topps Update Yellow Jose Butto".  We detect this by checking if the
        // colour word appears BEFORE the player's last name in the title.
        // Also filter when paired with a serial run (/NNN).
        const colorInVariantPosition = AMBIGUOUS_COLORS.some(c => {
          const colorRe = new RegExp(`\\b${c}\\b`, 'i');
          const colorMatch = colorRe.exec(t);
          if (!colorMatch) return false;
          // If paired with a serial number, always a parallel
          if (hasSmallSerial) return true;
          // Check if colour appears before the player name — variant position
          if (playerLast && playerLast.length > 1) {
            const playerIdx = t.indexOf(playerLast);
            if (playerIdx > 0 && colorMatch.index < playerIdx) {
              // Make sure the colour isn't part of the brand/set itself
              // (e.g. "Gold" in "Gold Label" or "Black" in "Black Gold")
              if (brandLower && colorMatch.index < brandLower.length + 5) return false;
              return true;
            }
          }
          return false;
        });
        if (colorInVariantPosition) {
          console.log(`  ↳ Hard-filtered (colour in variant position): "${r.title}"`);
          return false;
        }

        // Filter Bowman/Topps color-border parallels (e.g. "Blue Border", "Purple Border")
        const COLOR_BORDER = /\b(blue|purple|orange|green|gold|red|yellow|pink|aqua|teal|black|white|silver|copper|burgundy)\s+border\b/i;
        if (COLOR_BORDER.test(t)) return false;
      }

      return true;
    };

    const filtered = prioritizedResults.filter(hardFilter);
    console.log(`Hard filter: ${prioritizedResults.length} → ${filtered.length} results (removed ${prioritizedResults.length - filtered.length} parallel/auto listings)`);

    // Always use filtered results — show fewer correct matches rather than wrong ones
    const candidateResults = filtered;

    // Apply a minimum-score floor so heavily-penalised listings (parallels that
    // slipped through hard-filtering, wrong-collection matches, etc.) don't pad
    // the result list. Better to show 2 correct comps than 5 with parallels mixed in.
    // Threshold is tuned to require at least the player-name match (100) plus
    // some other identifier (year/card #/brand). 150 keeps real base-card matches
    // (which routinely score 215-275) and drops parallel-penalised ones (≤75).
    const MIN_DISPLAY_SCORE = 150;
    const qualifiedResults = candidateResults.filter(r => (r.matchScore ?? 0) >= MIN_DISPLAY_SCORE);
    console.log(`Score floor (≥${MIN_DISPLAY_SCORE}): ${candidateResults.length} → ${qualifiedResults.length} results`);

    // Only use top 5 results for display and calculation
    const topResults = qualifiedResults.slice(0, 5);
    
    // Calculate average value based on the top 5 displayed results only
    const displayedTotal = topResults.reduce((sum, item) => sum + item.price, 0);
    const averageValue = topResults.length > 0 ? Math.floor((displayedTotal / topResults.length) * 100) / 100 : 0;

    let discoveredCollection: string | undefined;
    if (collection && topResults.length >= 2) {
      const titles = topResults.map(r => r.title);
      const collectionLower = collection.toLowerCase();
      const moreSpecificCounts = new Map<string, number>();
      for (const title of titles) {
        const titleLower = title.toLowerCase();
        // Require the leading digit NOT be preceded by a word char or dash (prevents
        // card numbers like "#89B-9" from donating their trailing "9" as a collection prefix)
        const numMatch = titleLower.match(new RegExp(`(?<![\\w-])(\\d+)\\s*${collectionLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        if (numMatch && numMatch[1]) {
          const discoveredNum = numMatch[1];
          if (year && discoveredNum === String(year)) continue;
          // Skip digits that are part of a "Series N" phrase — e.g. "Series 1 Stars of MLB"
          // would otherwise produce "1 Stars of MLB" as the discovered collection.
          const precedingText = titleLower.slice(Math.max(0, numMatch.index! - 10), numMatch.index!);
          if (/series\s*$/.test(precedingText)) continue;
          const specific = `${discoveredNum} ${collection}`;
          moreSpecificCounts.set(specific, (moreSpecificCounts.get(specific) || 0) + 1);
        }
      }
      const entries = Array.from(moreSpecificCounts.entries());
      for (let i = 0; i < entries.length; i++) {
        const specificName = entries[i][0];
        const count = entries[i][1];
        if (count >= 2 && specificName.toLowerCase() !== collectionLower) {
          discoveredCollection = specificName;
          console.log(`Discovered more specific collection from eBay titles: "${discoveredCollection}" (was "${collection}")`);
          break;
        }
      }
    }

    const result = {
      averageValue,
      results: topResults,
      searchUrl: fallbackSearchUrl,
      dataType,
      discoveredCollection
    };

    searchCache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  } catch (error: any) {
    console.error('eBay search error:', error.message);
    return {
      averageValue: 0,
      results: [],
      searchUrl: getEbaySearchUrl(playerName || '', cardNumber, brand, year, collection, '', isNumbered, foilType, serialNumber),
      errorMessage: 'eBay search failed',
      dataType: 'sold' as const
    };
  }
}

/**
 * Build a URL to eBay search for a specific card
 */
export function getEbaySearchUrl(
  playerName: string,
  cardNumber: string,
  brand: string,
  year: number,
  collection?: string,
  condition?: string,
  isNumbered?: boolean,
  foilType?: string,
  serialNumber?: string
): string {
  const searchCollection = collection ? normalizeCollectionForSearch(collection) : '';
  
  const parts: string[] = [];
  if (year > 0) parts.push(String(year));
  if (brand) parts.push(brand);
  if (searchCollection) parts.push(searchCollection);
  parts.push(playerName);
  if (cardNumber) parts.push(/^\d+$/.test(cardNumber) ? `#${cardNumber}` : cardNumber);
  
  let keywords = parts.filter(Boolean).join(' ');
  
  // Add serial number suffix for serialized cards (e.g., "/399" instead of "numbered")
  if (isNumbered && serialNumber && serialNumber.includes('/')) {
    const serialMatch = serialNumber.match(/\/(\d+)$/);
    if (serialMatch) {
      keywords += ` /${serialMatch[1]}`;
    } else {
      keywords += ' numbered';
    }
  } else if (isNumbered) {
    keywords += ' numbered';
  }
  
  // Add foil variant once using normalized search term
  if (foilType) {
    const foilSearchTerm = getFoilSearchTerm(foilType);
    keywords += ` ${foilSearchTerm || foilType}`;
  }
  
  // Encode for URL — sold/completed listings (last 90 days), sorted by most recent
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(keywords)}&_sacat=213&LH_Sold=1&LH_Complete=1&_sop=13`;
}