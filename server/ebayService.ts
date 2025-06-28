import axios from 'axios';

// eBay Browse API configuration (modern replacement for Finding API)
const EBAY_APP_ID = process.env.EBAY_APP_ID || '';
const EBAY_OAUTH_TOKEN = process.env.EBAY_OAUTH_TOKEN || '';
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
    if (!EBAY_APP_ID || !EBAY_OAUTH_TOKEN) {
      console.warn('eBay API credentials not set. Cannot fetch card values.');
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
    
    console.log('Searching eBay Browse API with keywords:', keywords);

    // Use Browse API search endpoint with proper OAuth authentication
    const searchUrl = `${EBAY_BROWSE_API_URL}/item_summary/search`;
    const searchParams = {
      q: keywords,
      limit: 5,
      filter: 'conditionIds:{3000}', // Used condition filter
      sort: 'endTimeSoonest', // Recent sold items
      fieldgroups: 'EXTENDED'
    };

    // Make the API request with OAuth token
    const response = await axios.get(searchUrl, { 
      params: searchParams,
      headers: {
        'Authorization': `Bearer ${EBAY_OAUTH_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    const data = response.data;
    
    console.log('eBay Browse API Response:', data);
    
    // Check for eBay API errors
    if (data.errors && data.errors.length > 0) {
      console.log('eBay Browse API Error details:', JSON.stringify(data.errors, null, 2));
      const error = data.errors[0];
      const errorMessage = `eBay API error: ${error.message || 'Unknown error'}`;
      
      // Return search URL as fallback when API fails
      const searchUrl = getEbaySearchUrl(playerName, cardNumber, brand, year, collection);
      return { 
        averageValue: 0, 
        results: [],
        searchUrl,
        errorMessage
      };
    }

    // Extract search results from Browse API response
    let results: EbaySearchResult[] = [];
    let totalValue = 0;
    let itemCount = 0;

    // Check if we have search results in Browse API format
    if (data && data.itemSummaries && Array.isArray(data.itemSummaries)) {
      const items = data.itemSummaries;
      
      // Process each item
      results = items.map((item: any) => {
        // Get price from Browse API format
        let price = 0;
        if (item.price && item.price.value) {
          price = parseFloat(item.price.value);
          totalValue += price;
          itemCount++;
        }
        
        // Get image from Browse API format
        let imageUrl = '';
        if (item.image && item.image.imageUrl) {
          imageUrl = item.image.imageUrl;
        } else if (item.thumbnailImages && item.thumbnailImages.length > 0) {
          imageUrl = item.thumbnailImages[0].imageUrl;
        }
        
        // Get condition from Browse API format
        let condition = '';
        if (item.condition) {
          condition = item.condition;
        } else if (item.conditionId) {
          // Map condition IDs to readable text
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
    console.error('Error searching eBay Browse API for card values:', error);
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
      errorMessage = 'eBay OAuth token expired or invalid - please refresh authentication';
    } else if (error.response?.status === 403) {
      errorMessage = 'eBay API access forbidden - check OAuth token permissions';
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