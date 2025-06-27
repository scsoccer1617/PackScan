import axios from 'axios';

// eBay API configuration
const EBAY_APP_ID = process.env.EBAY_APP_ID || '';
const EBAY_FINDING_API_URL = 'https://svcs.ebay.com/services/search/FindingService/v1';

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
    if (!EBAY_APP_ID) {
      console.warn('eBay API credentials not set. Cannot fetch card values.');
      return { averageValue: 0, results: [] };
    }

    // Create cache key from search parameters
    const cacheKey = `${playerName}-${cardNumber}-${brand}-${year}-${collection || ''}`;
    const cached = searchCache.get(cacheKey);
    
    // Return cached result if still valid
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      console.log('Returning cached eBay results for:', cacheKey);
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
    
    console.log('Searching eBay with keywords:', keywords);

    // API request parameters - try even simpler format
    const params = {
      'OPERATION-NAME': 'findItemsByKeywords',
      'SERVICE-VERSION': '1.0.0',
      'SECURITY-APPNAME': EBAY_APP_ID,
      'GLOBAL-ID': 'EBAY-US',
      'RESPONSE-DATA-FORMAT': 'JSON',
      'keywords': keywords,
      'paginationInput.entriesPerPage': '5'
    };

    // Make the API request
    const response = await axios.get(EBAY_FINDING_API_URL, { params });
    const data = response.data;
    
    // Check for eBay API errors first
    if (data && data.errorMessage) {
      console.log('eBay API Error details:', JSON.stringify(data.errorMessage, null, 2));
      return { averageValue: 0, results: [] };
    }

    // Extract search results
    let results: EbaySearchResult[] = [];
    let totalValue = 0;
    let itemCount = 0;

    // Check if we have search results
    if (
      data && 
      data.findItemsByKeywordsResponse && 
      data.findItemsByKeywordsResponse[0] && 
      data.findItemsByKeywordsResponse[0].searchResult && 
      data.findItemsByKeywordsResponse[0].searchResult[0] && 
      data.findItemsByKeywordsResponse[0].searchResult[0].item
    ) {
      const items = data.findItemsByKeywordsResponse[0].searchResult[0].item;
      
      // Process each item
      results = items.map((item: any) => {
        // Get price
        let price = 0;
        if (item.sellingStatus && item.sellingStatus[0] && item.sellingStatus[0].currentPrice && item.sellingStatus[0].currentPrice[0]) {
          price = parseFloat(item.sellingStatus[0].currentPrice[0].__value__);
          
          // Convert if not USD
          if (item.sellingStatus[0].currentPrice[0]['@currencyId'] !== 'USD') {
            // Simple conversion - in production, use a proper currency conversion
            // This is a placeholder
            price = price * 1.0; // Replace with actual conversion rate
          }
          
          totalValue += price;
          itemCount++;
        }
        
        // Get image
        let imageUrl = '';
        if (item.galleryURL && item.galleryURL[0]) {
          imageUrl = item.galleryURL[0];
        }
        
        // Get condition
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
    console.error('Error searching eBay for card values:', error);
    
    // Check for specific eBay error messages
    let errorMessage = 'eBay API error - check credentials';
    if (error.response?.data?.errorMessage) {
      const ebayError = error.response.data.errorMessage[0]?.error?.[0];
      if (ebayError?.errorId?.[0] === '10001') {
        errorMessage = 'eBay API rate limit exceeded - please try again later';
      } else if (ebayError?.message?.[0]) {
        errorMessage = `eBay API error: ${ebayError.message[0]}`;
      }
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