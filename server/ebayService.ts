import axios from 'axios';
import { getFoilSearchTerm } from './foilVariantDetector';

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
  const playerLast = playerName.split(' ').slice(-1)[0].toLowerCase();
  
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

function getEbayBrowseToken(): string {
  return process.env.EBAY_BROWSE_TOKEN || '';
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
}

/**
 * Search eBay for completed/sold items matching card criteria
 */
// Simple cache to reduce API calls
const searchCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_DURATION = 30000; // 30 second cache to allow fresh searches

// Clear cache function for debugging
export function clearEbayCache() {
  searchCache.clear();
  console.log('eBay search cache cleared');
}

// Clear cache immediately on module load to start fresh
clearEbayCache();

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
  foilType?: string
): EbaySearchResult[] {
  return results.map(result => {
    const title = result.title.toLowerCase();
    let score = 0;
    const matchedElements: string[] = [];
    
    // Player name match (highest priority - 100 points)
    const playerFirstName = playerName.split(' ')[0].toLowerCase();
    const playerLastName = playerName.split(' ').slice(1).join(' ').toLowerCase();
    
    if (title.includes(playerFirstName) && title.includes(playerLastName)) {
      score += 100;
      matchedElements.push('full name');
    } else if (title.includes(playerLastName)) {
      score += 75;
      matchedElements.push('last name');
    } else if (title.includes(playerFirstName)) {
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
  variant?: string
): Promise<EbayResponse> {
  try {
    const ebayAppId = getEbayAppId();
    const ebayBrowseToken = getEbayBrowseToken();
    if (!ebayAppId || !ebayBrowseToken) {
      console.warn('eBay Browse API credentials not set. Cannot fetch card values.');
      return { averageValue: 0, results: [] };
    }

    // Create cache key from search parameters including foil type and serial number
    const cacheKey = `${playerName}-${cardNumber}-${brand}-${year}-${collection || ''}-${isNumbered || ''}-${foilType || ''}-${serialNumber || ''}-${variant || ''}`;
    const cached = searchCache.get(cacheKey);
    
    // Return cached result if still valid and not an error
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION && cached.data.results?.length > 0) {
      console.log('Returning cached eBay Browse API results for:', cacheKey);
      return cached.data;
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
    console.log('Searching eBay for SOLD listings with keywords:', keywords);

    // Try Finding API first for sold listings (most valuable data)
    let response;
    let usingFindingAPI = true;
    
    try {
      const findingUrl = 'https://svcs.ebay.com/services/search/FindingService/v1';
      const findingParams = {
        'OPERATION-NAME': 'findCompletedItems',
        'SERVICE-VERSION': '1.0.0',
        'SECURITY-APPNAME': ebayAppId,
        'GLOBAL-ID': 'EBAY-US',
        'RESPONSE-DATA-FORMAT': 'JSON',
        'keywords': keywords,
        'paginationInput.entriesPerPage': '5',
        'itemFilter(0).name': 'SoldItemsOnly',
        'itemFilter(0).value': 'true',
        'sortOrder': 'EndTimeSoonest'
      };

      response = await axios.get(findingUrl, { 
        params: findingParams,
        timeout: 10000
      });
      
      console.log('Successfully using Finding API for sold listings');
      
    } catch (findingError: any) {
      console.log('Finding API failed, falling back to Browse API for current listings');
      usingFindingAPI = false;
      
      // Fallback to Browse API for current marketplace data
      const browseUrl = `${EBAY_BROWSE_API_URL}/item_summary/search`;
      const browseParams = {
        q: keywords,
        limit: 10,
        filter: 'buyingOptions:{AUCTION|FIXED_PRICE},deliveryCountry:US,conditionIds:{1000|1500|2000|2500|3000|4000|5000|6000}',
        sort: 'price',
        fieldgroups: 'EXTENDED',
        category_ids: '213'
      };

      response = await axios.get(browseUrl, { 
        params: browseParams,
        headers: {
          'Authorization': `Bearer ${ebayBrowseToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });
    }
    const data = response.data;
    let results: EbaySearchResult[] = [];
    let totalValue = 0;
    let itemCount = 0;
    let dataType = usingFindingAPI ? 'sold' : 'current';

    if (usingFindingAPI) {
      console.log('Processing Finding API sold listings data');
      
      // Check for Finding API errors
      if (data && data.errorMessage) {
        console.log('Finding API Error details:', JSON.stringify(data.errorMessage, null, 2));
        const error = data.errorMessage[0]?.error?.[0];
        const errorMessage = `eBay API error: ${error?.message?.[0] || 'Unknown error'}`;
        
        const searchUrl = getEbaySearchUrl(playerName, cardNumber, brand, year, collection, '', isNumbered, foilType, serialNumber);
        return { 
          averageValue: 0, 
          results: [],
          searchUrl,
          errorMessage,
          dataType: 'sold' as const
        };
      }

      // Process Finding API sold listings
      if (
        data && 
        data.findCompletedItemsResponse && 
        data.findCompletedItemsResponse[0] && 
        data.findCompletedItemsResponse[0].searchResult && 
        data.findCompletedItemsResponse[0].searchResult[0] && 
        data.findCompletedItemsResponse[0].searchResult[0].item
      ) {
        const items = data.findCompletedItemsResponse[0].searchResult[0].item;
        
        results = items.map((item: any) => {
          let price = 0;
          if (item.sellingStatus && item.sellingStatus[0] && item.sellingStatus[0].currentPrice && item.sellingStatus[0].currentPrice[0]) {
            price = parseFloat(item.sellingStatus[0].currentPrice[0].__value__);
            totalValue += price;
            itemCount++;
          }
          
          let imageUrl = '';
          if (item.galleryURL && item.galleryURL[0]) {
            imageUrl = item.galleryURL[0];
          }
          
          let condition = '';
          if (item.condition && item.condition[0] && item.condition[0].conditionDisplayName) {
            condition = item.condition[0].conditionDisplayName[0];
          }
          
          return {
            title: item.title ? item.title[0] : '',
            price: price,
            currency: item.sellingStatus && item.sellingStatus[0] && item.sellingStatus[0].currentPrice && item.sellingStatus[0].currentPrice[0]['@currencyId'] ? 
              item.sellingStatus[0].currentPrice[0]['@currencyId'] : 'USD',
            url: item.viewItemURL ? item.viewItemURL[0] : '',
            imageUrl: imageUrl,
            condition: condition,
            endTime: item.listingInfo && item.listingInfo[0] && item.listingInfo[0].endTime ? 
              item.listingInfo[0].endTime[0] : ''
          };
        });
      }
    } else {
      console.log('Processing Browse API current listings data');
      
      // Check for Browse API errors
      if (data.errors && data.errors.length > 0) {
        console.log('Browse API Error details:', JSON.stringify(data.errors, null, 2));
        const error = data.errors[0];
        const errorMessage = `eBay API error: ${error.message || 'Unknown error'}`;
        
        const searchUrl = getEbaySearchUrl(playerName, cardNumber, brand, year, collection, '', isNumbered, foilType, serialNumber);
        return { 
          averageValue: 0, 
          results: [],
          searchUrl,
          errorMessage,
          dataType: 'current' as const
        };
      }

      // Process Browse API current listings
      if (data && data.itemSummaries && Array.isArray(data.itemSummaries)) {
        const items = data.itemSummaries;
        
        results = items.map((item: any) => {
          let price = 0;
          if (item.price && item.price.value) {
            price = parseFloat(item.price.value);
            totalValue += price;
            itemCount++;
          }
          
          let imageUrl = '';
          if (item.image && item.image.imageUrl) {
            imageUrl = item.image.imageUrl;
          } else if (item.thumbnailImages && item.thumbnailImages.length > 0) {
            imageUrl = item.thumbnailImages[0].imageUrl;
          }
          
          let condition = '';
          if (item.condition) {
            condition = item.condition;
          } else if (item.conditionId) {
            const conditionMap: { [key: string]: string } = {
              '1000': 'New',
              '1500': 'New other',
              '1750': 'New with defects',
              '2000': 'Manufacturer refurbished',
              '2500': 'Seller refurbished',
              '3000': 'Used',
              '4000': 'Very good',
              '5000': 'Good',
              '6000': 'Acceptable',
              '7000': 'For parts or not working'
            };
            condition = conditionMap[item.conditionId] || 'Unknown';
          }
          
          return {
            title: item.title || '',
            price: price,
            currency: item.price?.currency || 'USD',
            url: item.itemWebUrl || '',
            imageUrl: imageUrl,
            condition: condition,
            endTime: item.itemEndDate || ''
          };
        });
      }
    }

    const detectedColor = extractColorFromVariant(variantKeyword || undefined);
    const shouldDiscoverVariant = detectedColor && variantKeyword && !variantKeyword.toLowerCase().includes('crackle') && !variantKeyword.toLowerCase().includes('shimmer') && !variantKeyword.toLowerCase().includes('ice');
    
    if (results.length > 0 && shouldDiscoverVariant) {
      console.log('=== ALWAYS-ON VARIANT DISCOVERY (have results, checking for more specific variant) ===');
      const titles = results.map(r => r.title);
      const discoveredVariant = discoverVariantFromListings(titles, detectedColor);
      
      if (discoveredVariant && discoveredVariant !== variantKeyword) {
        console.log(`Discovered more specific variant from existing results: "${discoveredVariant}" (was "${variantKeyword}")`);
        variantKeyword = discoveredVariant;
        
        const refinedKeywords = buildKeywords();
        console.log('Refined search with discovered variant:', refinedKeywords);
        
        try {
          const browseUrl = `${EBAY_BROWSE_API_URL}/item_summary/search`;
          const refinedParams = {
            q: refinedKeywords,
            limit: 10,
            filter: 'buyingOptions:{AUCTION|FIXED_PRICE},deliveryCountry:US',
            sort: 'price',
            fieldgroups: 'EXTENDED',
            category_ids: '213'
          };
          
          const refinedResponse = await axios.get(browseUrl, {
            params: refinedParams,
            headers: {
              'Authorization': `Bearer ${getEbayBrowseToken()}`,
              'Accept': 'application/json',
            },
            timeout: 15000
          });
          
          if (refinedResponse.data?.itemSummaries && refinedResponse.data.itemSummaries.length > 0) {
            results = refinedResponse.data.itemSummaries.map((item: any) => ({
              title: item.title || '',
              price: parseFloat(item.price?.value || '0'),
              currency: item.price?.currency || 'USD',
              url: item.itemWebUrl || '',
              imageUrl: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || '',
              condition: item.condition || '',
              endTime: item.itemEndDate || ''
            }));
            dataType = 'current';
            console.log(`Refined search with discovered variant returned ${results.length} results`);
          }
        } catch (refinedError: any) {
          console.log('Refined variant search failed:', refinedError.message);
        }
      } else {
        console.log(`No more specific variant found in listing titles (current: "${variantKeyword}")`);
      }
    }
    
    if (results.length > 0 && !variantKeyword && isNumbered) {
      console.log('=== BLIND VARIANT DISCOVERY (numbered card, no variant detected, scanning listing titles) ===');
      const titles = results.map(r => r.title);
      const blindVariant = discoverVariantFromTitlesBlind(titles, playerName);
      
      if (blindVariant) {
        console.log(`Blind discovery found variant: "${blindVariant}" from eBay listing titles`);
        variantKeyword = blindVariant;
        
        const refinedKeywords = buildKeywords();
        console.log('Refined search with blind-discovered variant:', refinedKeywords);
        
        try {
          const browseUrl = `${EBAY_BROWSE_API_URL}/item_summary/search`;
          const refinedParams = {
            q: refinedKeywords,
            limit: 10,
            filter: 'buyingOptions:{AUCTION|FIXED_PRICE},deliveryCountry:US',
            sort: 'price',
            fieldgroups: 'EXTENDED',
            category_ids: '213'
          };
          
          const refinedResponse = await axios.get(browseUrl, {
            params: refinedParams,
            headers: {
              'Authorization': `Bearer ${getEbayBrowseToken()}`,
              'Accept': 'application/json',
            },
            timeout: 15000
          });
          
          if (refinedResponse.data?.itemSummaries && refinedResponse.data.itemSummaries.length > 0) {
            results = refinedResponse.data.itemSummaries.map((item: any) => ({
              title: item.title || '',
              price: parseFloat(item.price?.value || '0'),
              currency: item.price?.currency || 'USD',
              url: item.itemWebUrl || '',
              imageUrl: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || '',
              condition: item.condition || '',
              endTime: item.itemEndDate || ''
            }));
            dataType = 'current';
            console.log(`Blind variant refined search returned ${results.length} results`);
          }
        } catch (refinedError: any) {
          console.log('Blind variant refined search failed:', refinedError.message);
        }
      } else {
        console.log('No variant keywords found in listing titles');
      }
    }

    if (results.length === 0) {
      console.log('No results with initial query, trying broader discovery search...');
      
      const discoveryKeywords = buildKeywords({ includeVariant: false, includeCardNumber: false });
      console.log('Discovery search keywords:', discoveryKeywords);
      
      let discoveryResults: EbaySearchResult[] = [];
      try {
        const browseUrl = `${EBAY_BROWSE_API_URL}/item_summary/search`;
        const discoveryParams = {
          q: discoveryKeywords,
          limit: 20,
          filter: 'buyingOptions:{AUCTION|FIXED_PRICE},deliveryCountry:US',
          sort: 'price',
          fieldgroups: 'EXTENDED',
          category_ids: '213'
        };
        
        const discoveryResponse = await axios.get(browseUrl, {
          params: discoveryParams,
          headers: {
            'Authorization': `Bearer ${getEbayBrowseToken()}`,
            'Accept': 'application/json',
          },
          timeout: 15000
        });
        
        if (discoveryResponse.data?.itemSummaries) {
          discoveryResults = discoveryResponse.data.itemSummaries.map((item: any) => ({
            title: item.title || '',
            price: parseFloat(item.price?.value || '0'),
            currency: item.price?.currency || 'USD',
            url: item.itemWebUrl || '',
            imageUrl: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || '',
            condition: item.condition || '',
            endTime: item.itemEndDate || ''
          }));
        }
      } catch (discoveryError: any) {
        console.log('Discovery search failed:', discoveryError.message);
      }
      
      if (discoveryResults.length > 0) {
        const titles = discoveryResults.map(r => r.title);
        const discoveredVariant = discoverVariantFromListings(titles, detectedColor);
        
        if (discoveredVariant && discoveredVariant !== variantKeyword) {
          console.log(`Discovered more specific variant: "${discoveredVariant}" (was "${variantKeyword}")`);
          variantKeyword = discoveredVariant;
          
          const refinedKeywords = buildKeywords();
          console.log('Refined search with discovered variant:', refinedKeywords);
          
          try {
            const browseUrl = `${EBAY_BROWSE_API_URL}/item_summary/search`;
            const refinedParams = {
              q: refinedKeywords,
              limit: 10,
              filter: 'buyingOptions:{AUCTION|FIXED_PRICE},deliveryCountry:US',
              sort: 'price',
              fieldgroups: 'EXTENDED',
              category_ids: '213'
            };
            
            const refinedResponse = await axios.get(browseUrl, {
              params: refinedParams,
              headers: {
                'Authorization': `Bearer ${getEbayBrowseToken()}`,
                'Accept': 'application/json',
              },
              timeout: 15000
            });
            
            if (refinedResponse.data?.itemSummaries && refinedResponse.data.itemSummaries.length > 0) {
              results = refinedResponse.data.itemSummaries.map((item: any) => ({
                title: item.title || '',
                price: parseFloat(item.price?.value || '0'),
                currency: item.price?.currency || 'USD',
                url: item.itemWebUrl || '',
                imageUrl: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || '',
                condition: item.condition || '',
                endTime: item.itemEndDate || ''
              }));
              dataType = 'current';
              console.log(`Refined search returned ${results.length} results`);
            }
          } catch (refinedError: any) {
            console.log('Refined search failed:', refinedError.message);
          }
        }
        
        if (results.length === 0) {
          results = discoveryResults;
          dataType = 'current';
          console.log(`Using discovery results: ${results.length} listings found`);
        }
      }
    }

    const prioritizedResults = prioritizeListingsByCardMatch(
      results, 
      playerName, 
      cardNumber, 
      brand, 
      year, 
      collection, 
      foilType
    );
    
    // Only use top 5 results for display and calculation
    const topResults = prioritizedResults.slice(0, 5);
    
    // Calculate average value based on the top 5 displayed results only
    const displayedTotal = topResults.reduce((sum, item) => sum + item.price, 0);
    const averageValue = topResults.length > 0 ? Math.floor((displayedTotal / topResults.length) * 100) / 100 : 0;

    const result = {
      averageValue,
      results: topResults,
      searchUrl: getEbaySearchUrl(playerName, cardNumber, brand, year, collection, '', isNumbered, variantKeyword || foilType, serialNumber),
      dataType: dataType as 'sold' | 'current',
      discoveredVariant: variantKeyword !== (variant || foilType || '') ? variantKeyword : undefined
    };

    // Cache the successful result
    searchCache.set(cacheKey, { data: result, timestamp: Date.now() });

    return result;
  } catch (error: any) {
    console.error('Error searching eBay Browse API:', error.message);
    console.error('Error response status:', error.response?.status);
    console.error('Error response data:', JSON.stringify(error.response?.data, null, 2));
    
    // Check for specific eBay Browse API error messages
    let errorMessage = 'eBay Browse API error - check credentials';
    
    if (error.response?.data?.errors && Array.isArray(error.response.data.errors)) {
      const ebayError = error.response.data.errors[0];
      if (ebayError?.errorId === 1001 || ebayError?.errorId === '1001') {
        errorMessage = 'eBay OAuth token has expired. Please update your EBAY_BROWSE_TOKEN with a fresh token from eBay Developer Console.';
      } else if (ebayError?.message) {
        errorMessage = `eBay API error: ${ebayError.message}`;
      }
    } else if (error.response?.status === 401) {
      errorMessage = 'eBay OAuth token has expired. Please generate a new EBAY_BROWSE_TOKEN from eBay Developer Console.';
    } else if (error.response?.status === 403) {
      errorMessage = 'eBay API access forbidden - OAuth token may lack Browse API permissions';
    } else if (error.response?.status === 429) {
      errorMessage = 'eBay API rate limit exceeded - please try again later';
    }
    
    // Return search URL as fallback when API fails
    const searchUrl = getEbaySearchUrl(playerName, cardNumber, brand, year, collection, '', isNumbered, foilType, serialNumber);
    return { 
      averageValue: 0, 
      results: [],
      searchUrl,
      errorMessage,
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
  if (foilType) parts.push(foilType);
  
  let keywords = parts.filter(Boolean).join(' ');
  
  // Add serial number suffix for serialized cards (e.g., "/399" instead of "numbered")
  if (isNumbered && serialNumber && serialNumber.includes('/')) {
    // Extract serial number suffix from serialNumber parameter
    const serialMatch = serialNumber.match(/\/(\d+)$/);
    if (serialMatch) {
      keywords += ` /${serialMatch[1]}`;
    } else {
      keywords += ' numbered';
    }
  } else if (isNumbered) {
    keywords += ' numbered';
  }
  
  // Add foil variant for special finishes to get accurate pricing
  if (foilType) {
    const foilSearchTerm = getFoilSearchTerm(foilType);
    if (foilSearchTerm) {
      keywords += ` ${foilSearchTerm}`;
    }
  }
  
  // Encode for URL
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(keywords)}&_sacat=0&LH_Complete=1&LH_Sold=1`;
}