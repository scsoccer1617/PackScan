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
const CACHE_DURATION = 60000; // 1 minute cache

export async function searchCardValues(
  playerName: string,
  cardNumber: string,
  brand: string,
  year: number,
  collection?: string,
  condition?: string
): Promise<EbayResponse> {
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
      // For regular cards, we use a broader search
      keywords = `${lastName} ${brand} ${year}`;
      console.log('Using standard search strategy');
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
        
        const searchUrl = getEbaySearchUrl(playerName, cardNumber, brand, year, collection);
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
        
        const searchUrl = getEbaySearchUrl(playerName, cardNumber, brand, year, collection);
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

    // Calculate average value
    const averageValue = itemCount > 0 ? Math.round(totalValue / itemCount) : 0;

    const result = {
      averageValue,
      results: results.slice(0, 5), // Return only top 5 results
      searchUrl: getEbaySearchUrl(playerName, cardNumber, brand, year, collection),
      dataType: dataType as 'sold' | 'current'
    };

    // Cache the successful result
    searchCache.set(cacheKey, { data: result, timestamp: Date.now() });

    return result;
  } catch (error: any) {
    console.error('Error searching eBay Browse API:', error);
    console.error('Error response data:', error.response?.data);
    
    // Check for specific eBay Browse API error messages
    let errorMessage = 'eBay Browse API error - check credentials';
    
    if (error.response?.data?.errors && Array.isArray(error.response.data.errors)) {
      const ebayError = error.response.data.errors[0];
      if (ebayError?.errorId === 1001 || ebayError?.errorId === '1001') {
        errorMessage = 'eBay API rate limit exceeded - please try again later';
      } else if (ebayError?.message) {
        errorMessage = `eBay API error: ${ebayError.message}`;
      }
    } else if (error.response?.status === 401) {
      errorMessage = 'eBay OAuth token invalid - check Browse API credentials';
    } else if (error.response?.status === 403) {
      errorMessage = 'eBay API access forbidden - OAuth token may lack Browse API permissions';
    } else if (error.response?.status === 429) {
      errorMessage = 'eBay API rate limit exceeded - please try again later';
    }
    
    // Return search URL as fallback when API fails
    const searchUrl = getEbaySearchUrl(playerName, cardNumber, brand, year, collection);
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
  // Check for Series Two cards
  else if (collection && collection.toLowerCase().includes('series two')) {
    keywords = `${playerName} ${brand} Series Two ${year}`;
    if (cardNumber && /^\d+$/.test(cardNumber)) {
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