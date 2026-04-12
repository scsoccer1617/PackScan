import axios from 'axios';
import { getFoilSearchTerm } from './foilVariantDetector';
import { getEbayAccessToken, clearCachedToken } from './ebayTokenManager';

const EBAY_BROWSE_API_URL = 'https://api.ebay.com/buy/browse/v1';

function normalizeCollectionForSearch(collection: string): string {
  return collection
    .replace(/\bSeries Two\b/gi, 'Series 2')
    .replace(/\bSeries One\b/gi, 'Series 1')
    .replace(/\bSeries Three\b/gi, 'Series 3');
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
  for (const color of colors) {
    if (variant.toLowerCase().startsWith(color.toLowerCase())) return color;
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
const CACHE_DURATION = 30000;       // 30 second cache for successful results
const ERROR_CACHE_DURATION = 120000; // 2 minute cache for errors/empty results (prevents rate-limit hammering)

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
  'refractor', 'xfractor', 'foilboard',
  'holo', 'holographic', 'rainbow', 'parallel',
  'mojo', 'sparkle', 'glitter', 'laser',
  'fractal', 'pulsar', 'atomic', 'silk',
  'crackle', 'shimmer',
  'aqua foil', 'blue foil', 'red foil', 'green foil', 'gold foil',
  'purple foil', 'orange foil', 'pink foil', 'silver foil', 'rainbow foil'
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
  serialNumber?: string
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
        score -= 60;
        console.log(`  ↳ Parallel penalty (-60): base card but title contains parallel/foil keyword`);
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
  _isRetry?: boolean
): Promise<EbayResponse> {
  try {
    // Require at least one auth credential
    const hasCredentials = process.env.EBAY_OAUTH_TOKEN ||
      process.env.EBAY_BROWSE_TOKEN ||
      (process.env.EBAY_APP_ID && process.env.EBAY_CERT_ID);
    if (!hasCredentials) {
      console.warn('No eBay credentials found (EBAY_OAUTH_TOKEN, EBAY_BROWSE_TOKEN, or APP_ID+CERT_ID required).');
      return { averageValue: 0, results: [] };
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

    const searchCollection = collection ? normalizeCollectionForSearch(collection) : '';
    
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
    
    const buildKeywords = (opts: { includeVariant?: boolean; includeCardNumber?: boolean; includeSerial?: boolean } = {}): string => {
      const { includeVariant = true, includeCardNumber = true, includeSerial = true } = opts;
      const parts: string[] = [];
      
      if (year > 0) parts.push(String(year));
      if (brand) parts.push(brand);
      if (searchCollection) parts.push(searchCollection);
      parts.push(playerName);
      
      if (includeCardNumber && cardNumber) {
        parts.push(/^\d+$/.test(cardNumber) ? `#${cardNumber}` : cardNumber);
      }
      
      if (includeVariant && variantKeyword) {
        parts.push(variantKeyword);
      }
      
      if (includeSerial && serialSuffix) {
        parts.push(serialSuffix);
      }
      
      return parts.filter(Boolean).join(' ');
    }
    
    let keywords = buildKeywords();
    console.log('Searching eBay active listings with keywords:', keywords);

    const safePlayerName = playerName || '';
    let results: EbaySearchResult[] = [];
    const dataType = 'current';
    const fallbackSearchUrl = getEbaySearchUrl(safePlayerName, cardNumber, brand, year, collection, '', isNumbered, foilType, serialNumber);

    // eBay Browse API — requires OAuth Bearer token
    // Token priority: EBAY_OAUTH_TOKEN (user token) → client credentials flow → EBAY_BROWSE_TOKEN (static)
    const BROWSE_API = 'https://api.ebay.com/buy/browse/v1/item_summary/search';

    const getBrowseToken = async (): Promise<string> => {
      // getEbayAccessToken: tries client credentials (APP_ID + CERT_ID) first,
      // then falls back to EBAY_BROWSE_TOKEN static value.
      // Skip EBAY_OAUTH_TOKEN — it requires user-level auth which may expire.
      return getEbayAccessToken();
    };

    const mapBrowseItem = (item: any): EbaySearchResult => ({
      title: item.title || '',
      price: parseFloat(item.price?.value || item.buyingOptions?.[0]?.price?.value || '0'),
      currency: item.price?.currency || 'USD',
      url: item.itemWebUrl || '',
      imageUrl: item.thumbnailImages?.[0]?.imageUrl || item.image?.imageUrl || '',
      condition: item.condition || '',
      endTime: item.itemEndDate || ''
    });

    const callBrowseApi = async (query: string): Promise<EbaySearchResult[]> => {
      const token = await getBrowseToken();
      const resp = await axios.get(BROWSE_API, {
        params: {
          q: query,
          category_ids: '213',
          limit: '10',
          sort: 'bestMatch'
        },
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });
      const items: any[] = resp.data?.itemSummaries || [];
      console.log(`Browse API raw response: total=${resp.data?.total ?? 'unknown'}, items=${items.length}`);
      return items
        .map(mapBrowseItem)
        .filter(r => r.price > 0);
    };

    try {
      results = await callBrowseApi(keywords);
      console.log(`Browse API (specific query) returned ${results.length} active listings`);

      if (results.length === 0) {
        // Try a broader query without card number, variant, or serial suffix
        const broaderKeywords = buildKeywords({ includeCardNumber: false, includeVariant: false, includeSerial: false });
        if (broaderKeywords && broaderKeywords !== keywords) {
          results = await callBrowseApi(broaderKeywords);
          console.log(`Browse API (broader query) returned ${results.length} active listings`);
        }
      }
    } catch (browseError: any) {
      const status = browseError.response?.status;
      const errBody = browseError.response?.data;
      console.log(`Browse API unavailable (HTTP ${status ?? 'no-response'}): ${browseError.message}`);
      if (errBody) console.log('Browse API error details:', JSON.stringify(errBody));
      const errorResp = {
        averageValue: 0,
        results: [],
        searchUrl: fallbackSearchUrl,
        errorMessage: 'Price data currently unavailable',
        dataType: 'current' as const
      };
      searchCache.set(cacheKey, { data: errorResp, timestamp: Date.now(), isError: true });
      return errorResp;
    }

    if (results.length === 0) {
      const emptyResp = {
        averageValue: 0,
        results: [],
        searchUrl: fallbackSearchUrl,
        errorMessage: 'No active listings found',
        dataType: 'current' as const
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
      serialNumber
    );
    
    // Only use top 5 results for display and calculation
    const topResults = prioritizedResults.slice(0, 5);
    
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
      dataType: 'current' as const,
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
  
  // Encode for URL — active listings (no LH_Complete/LH_Sold filters)
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(keywords)}&_sacat=213`;
}