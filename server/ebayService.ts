import axios from 'axios';
import { getFoilSearchTerm } from './foilVariantDetector';

// eBay Browse API configuration (modern replacement for Finding API)
const EBAY_APP_ID = process.env.EBAY_APP_ID || '';
const EBAY_BROWSE_TOKEN = process.env.EBAY_BROWSE_TOKEN || '';
const EBAY_BROWSE_API_URL = 'https://api.ebay.com/buy/browse/v1';

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
  serialNumber?: string
): Promise<EbayResponse> {
  try {
    if (!EBAY_APP_ID || !EBAY_BROWSE_TOKEN) {
      console.warn('eBay Browse API credentials not set. Cannot fetch card values.');
      return { averageValue: 0, results: [] };
    }

    // Create cache key from search parameters including foil type and serial number
    const cacheKey = `${playerName}-${cardNumber}-${brand}-${year}-${collection || ''}-${isNumbered || ''}-${foilType || ''}-${serialNumber || ''}`;
    const cached = searchCache.get(cacheKey);
    
    // Return cached result if still valid and not an error
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION && cached.data.results?.length > 0) {
      console.log('Returning cached eBay Browse API results for:', cacheKey);
      return cached.data;
    }

    // Build search query based on card details
    // Note: We intentionally exclude the condition (PSA grade) from the search
    // to get a wider range of results
    
    // Split player name into first and last name for more flexible search
    const nameComponents = playerName.split(' ');
    const lastName = nameComponents.length > 1 ? nameComponents[nameComponents.length - 1] : playerName;
    
    // Special handling for different card types
    let keywords = '';
    
    // Check for Stars of MLB cards
    if (typeof collection === 'string' && collection.toLowerCase().includes('stars of mlb')) {
      // For Stars of MLB cards, use the exact format that works on eBay
      keywords = `${playerName} ${brand} ${collection} ${cardNumber}`;
      console.log('Using Stars of MLB search strategy with card number');
    }
    // Check for Heritage cards
    else if (typeof collection === 'string' && collection.toLowerCase().includes('heritage')) {
      // For Heritage cards, we use a more specific format that works better
      keywords = `${lastName} ${brand} Heritage ${year}`;
      if (/^\d+$/.test(cardNumber)) {
        keywords += ` ${cardNumber}`;
      }
      console.log('Using Heritage search strategy');
    }
    // Check for Series Two cards
    else if (typeof collection === 'string' && collection.toLowerCase().includes('series two')) {
      // For Series Two cards, include the full collection name for better results
      keywords = `${playerName} ${brand} Series Two ${year}`;
      if (cardNumber && /^\d+$/.test(cardNumber)) {
        keywords += ` ${cardNumber}`;
      }
      console.log('Using Series Two search strategy with full player name and collection');
    }
    // Standard cards
    else {
      // For regular cards, include full player name, brand, collection, card number, and year
      keywords = `${playerName} ${brand}`;
      
      // Add collection if available
      if (collection) {
        keywords += ` ${collection}`;
      }
      
      // Add card number if available
      if (cardNumber && /^\d+$/.test(cardNumber)) {
        keywords += ` ${cardNumber}`;
      }
      
      // Add year
      keywords += ` ${year}`;
      
      console.log('Using comprehensive standard search strategy with full card details');
    }
    
    // Add serial number suffix for serialized cards to get accurate pricing for limited editions
    if (isNumbered && serialNumber) {
      // Extract the suffix (e.g., "/399" from "010/399")
      const serialMatch = serialNumber.match(/\/(\d+)$/);
      if (serialMatch) {
        const serialSuffix = `/${serialMatch[1]}`;
        keywords += ` ${serialSuffix}`;
        console.log(`Added serial number suffix "${serialSuffix}" to search for numbered card`);
      } else {
        // Fallback to "numbered" if we can't extract the suffix
        keywords += ' numbered';
        console.log('Added "numbered" to search for serialized card (fallback)');
      }
    }
    
    // Add foil variant for special finishes to get accurate pricing for foil variants
    console.log(`DEBUG: foilType parameter = "${foilType}"`);
    if (foilType) {
      // Use the already imported helper function to get the eBay-friendly search term
      const foilSearchTerm = getFoilSearchTerm(foilType);
      console.log(`DEBUG: getFoilSearchTerm("${foilType}") = "${foilSearchTerm}"`);
      if (foilSearchTerm) {
        keywords += ` ${foilSearchTerm}`;
        console.log(`Added "${foilSearchTerm}" to search for ${foilType} foil variant`);
      } else {
        console.log(`No foil search term found for ${foilType}`);
      }
    } else {
      console.log('DEBUG: No foilType provided to eBay search');
    }
    
    console.log('Searching eBay for SOLD listings with keywords:', keywords);

    // Try Finding API first for sold listings (most valuable data)
    let response;
    let usingFindingAPI = true;
    
    try {
      const findingUrl = 'https://svcs.ebay.com/services/search/FindingService/v1';
      const findingParams = {
        'OPERATION-NAME': 'findCompletedItems',
        'SERVICE-VERSION': '1.0.0',
        'SECURITY-APPNAME': EBAY_APP_ID,
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
          'Authorization': `Bearer ${EBAY_BROWSE_TOKEN}`,
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

    // Prioritize results based on card information match
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
      searchUrl: getEbaySearchUrl(playerName, cardNumber, brand, year, collection, '', isNumbered, foilType, serialNumber),
      dataType: dataType as 'sold' | 'current'
    };

    // Cache the successful result
    searchCache.set(cacheKey, { data: result, timestamp: Date.now() });

    return result;
  } catch (error: any) {
    console.error('Error searching eBay Browse API:', error.message);
    console.error('Error response status:', error.response?.status);
    console.error('Error response data:', JSON.stringify(error.response?.data, null, 2));
    
    // If this is a complex search (with foil or serial), try a simpler search as fallback
    // But keep foilType since that's important for accurate pricing
    if (serialNumber) {
      console.log('Complex search failed, trying simpler fallback search (keeping foil type)...');
      return await searchCardValues(
        playerName, 
        cardNumber, 
        brand, 
        year, 
        collection, 
        condition, 
        false, // remove isNumbered
        foilType, // KEEP foilType for accurate pricing
        undefined  // remove serialNumber
      );
    }
    
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
  // Split player name into first and last name for more flexible search
  const nameComponents = playerName.split(' ');
  const lastName = nameComponents.length > 1 ? nameComponents[nameComponents.length - 1] : playerName;
  
  // Build search terms using same logic as API search - use full details for better results
  let keywords = '';
  
  // Check for Stars of MLB cards
  if (collection && collection.toLowerCase().includes('stars of mlb')) {
    // For Stars of MLB cards, use the exact format that works on eBay
    keywords = `${playerName} ${brand} ${collection} ${cardNumber}`;
  }
  // Check for Heritage cards
  else if (collection && collection.toLowerCase().includes('heritage')) {
    keywords = `${lastName} ${brand} Heritage ${year}`;
    if (/^\d+$/.test(cardNumber)) {
      keywords += ` ${cardNumber}`;
    }
  }
  // Check for Series Two cards
  else if (collection && collection.toLowerCase().includes('series two')) {
    keywords = `${playerName} ${brand} Series Two ${year}`;
    if (cardNumber && /^\d+$/.test(cardNumber)) {
      keywords += ` ${cardNumber}`;
    }
  }
  // Standard cards
  else {
    // Use comprehensive format: Full player name, brand, collection, card number, year
    keywords = `${playerName} ${brand}`;
    
    // Add collection if available
    if (collection) {
      keywords += ` ${collection}`;
    }
    
    // Add card number if available
    if (cardNumber && /^\d+$/.test(cardNumber)) {
      keywords += ` ${cardNumber}`;
    }
    
    // Add year
    keywords += ` ${year}`;
  }
  
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