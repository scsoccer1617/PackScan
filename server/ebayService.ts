import axios from 'axios';

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

/**
 * Search eBay for completed/sold items matching card criteria
 */
// Simple cache to reduce API calls
const searchCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_DURATION = 60000; // 1 minute cache

export async function searchCardValues(
  playerName: string,
  cardNumber: string,
  brand: string,
  year: number,
  collection?: string,
  condition?: string
): Promise<{ averageValue: number; results: EbaySearchResult[]; searchUrl?: string; errorMessage?: string }> {
  try {
    if (!EBAY_APP_ID || !EBAY_BROWSE_TOKEN) {
      console.warn('eBay Browse API credentials not set. Cannot fetch card values.');
      return { averageValue: 0, results: [] };
    }

    // Create cache key from search parameters
    const cacheKey = `${playerName}-${cardNumber}-${brand}-${year}-${collection || ''}`;
    const cached = searchCache.get(cacheKey);
    
    // Return cached result if still valid
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
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
    // Standard cards
    else {
      // For regular cards, we use a broader search
      keywords = `${lastName} ${brand} ${year}`;
      console.log('Using standard search strategy');
    }
    
    console.log('Searching eBay for SOLD card values with keywords:', keywords);

    // Use Finding API specifically for sold listings (still supported for this use case)
    // Browse API is for active listings, Finding API's findCompletedItems is for sold data
    const searchUrl = 'https://svcs.ebay.com/services/search/FindingService/v1';
    const searchParams = {
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

    // Make the API request (Finding API uses App ID, not OAuth for completed items)
    const response = await axios.get(searchUrl, { 
      params: searchParams,
      timeout: 15000
    });
    const data = response.data;
    
    console.log('eBay Finding API (Completed Items) Response received');
    
    // Check for eBay API errors first
    if (data && data.errorMessage) {
      console.log('eBay Finding API Error details:', JSON.stringify(data.errorMessage, null, 2));
      const error = data.errorMessage[0]?.error?.[0];
      const errorMessage = `eBay API error: ${error?.message?.[0] || 'Unknown error'}`;
      
      // Return search URL as fallback when API fails
      const searchUrl = getEbaySearchUrl(playerName, cardNumber, brand, year, collection);
      return { 
        averageValue: 0, 
        results: [],
        searchUrl,
        errorMessage
      };
    }

    // Extract search results from Finding API response
    let results: EbaySearchResult[] = [];
    let totalValue = 0;
    let itemCount = 0;

    // Check if we have search results in Finding API format for completed items
    if (
      data && 
      data.findCompletedItemsResponse && 
      data.findCompletedItemsResponse[0] && 
      data.findCompletedItemsResponse[0].searchResult && 
      data.findCompletedItemsResponse[0].searchResult[0] && 
      data.findCompletedItemsResponse[0].searchResult[0].item
    ) {
      const items = data.findCompletedItemsResponse[0].searchResult[0].item;
      
      // Process each sold item
      results = items.map((item: any) => {
        // Get sold price from Finding API format
        let price = 0;
        if (item.sellingStatus && item.sellingStatus[0] && item.sellingStatus[0].currentPrice && item.sellingStatus[0].currentPrice[0]) {
          price = parseFloat(item.sellingStatus[0].currentPrice[0].__value__);
          
          // Convert if not USD
          if (item.sellingStatus[0].currentPrice[0]['@currencyId'] !== 'USD') {
            price = price * 1.0; // Placeholder for currency conversion
          }
          
          totalValue += price;
          itemCount++;
        }
        
        // Get image from Finding API format
        let imageUrl = '';
        if (item.galleryURL && item.galleryURL[0]) {
          imageUrl = item.galleryURL[0];
        }
        
        // Get condition from Finding API format
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

    // Calculate average value
    const averageValue = itemCount > 0 ? Math.round(totalValue / itemCount) : 0;

    const result = {
      averageValue,
      results
    };

    // Cache the successful result
    searchCache.set(cacheKey, { data: result, timestamp: Date.now() });

    return result;
  } catch (error: any) {
    console.error('Error searching eBay Finding API for sold card values:', error);
    console.error('Error response data:', error.response?.data);
    
    // Check for specific eBay Finding API error messages
    let errorMessage = 'eBay Finding API error - check credentials';
    
    if (error.response?.data?.errorMessage) {
      const ebayError = error.response.data.errorMessage[0]?.error?.[0];
      if (ebayError?.errorId?.[0] === '10001') {
        errorMessage = 'eBay API rate limit exceeded - please try again later';
      } else if (ebayError?.message?.[0]) {
        errorMessage = `eBay API error: ${ebayError.message[0]}`;
      }
    } else if (error.response?.status === 429) {
      errorMessage = 'eBay API rate limit exceeded - please try again later';
    }
    
    // Return search URL as fallback when API fails
    const searchUrl = getEbaySearchUrl(playerName, cardNumber, brand, year, collection);
    return { 
      averageValue: 0, 
      results: [],
      searchUrl,
      errorMessage
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
  condition?: string
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
  // Standard cards
  else {
    keywords = `${lastName} ${brand} ${year}`;
    if (/^\d+$/.test(cardNumber)) {
      keywords += ` ${cardNumber}`;
    }
  }
  
  // Encode for URL
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(keywords)}&_sacat=0&LH_Complete=1&LH_Sold=1`;
}