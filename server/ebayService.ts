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
export async function searchCardValues(
  playerName: string,
  cardNumber: string,
  brand: string,
  year: number,
  collection?: string,
  condition?: string
): Promise<{ averageValue: number; results: EbaySearchResult[] }> {
  try {
    if (!EBAY_APP_ID) {
      console.warn('eBay API credentials not set. Cannot fetch card values.');
      return { averageValue: 0, results: [] };
    }

    // Build search query based on card details
    // Note: We intentionally exclude the condition (PSA grade) from the search
    // to get a wider range of results
    
    // Split player name into first and last name for more flexible search
    const nameComponents = playerName.split(' ');
    const lastName = nameComponents.length > 1 ? nameComponents[nameComponents.length - 1] : playerName;
    
    // For special cards like Heritage, we need to be more specific
    let isHeritage = false;
    if (typeof collection === 'string' && collection.toLowerCase().includes('heritage')) {
      isHeritage = true;
    }
    
    // Construct a more flexible search query
    let keywords = '';
    
    if (isHeritage) {
      // For Heritage cards, we use a more specific format that works better
      keywords = `${lastName} ${brand} Heritage ${year}`;
    } else {
      // For regular cards, we use a broader search
      keywords = `${lastName} ${brand} ${year}`;
    }
    
    // Try to add card number if appropriate
    // For Heritage cards, if the card number is numeric, include it
    if (isHeritage && /^\d+$/.test(cardNumber)) {
      keywords += ` ${cardNumber}`;
    }
    
    console.log('Searching eBay with keywords:', keywords);

    // API request parameters
    const params = {
      'OPERATION-NAME': 'findItemsByKeywords',
      'SERVICE-VERSION': '1.0.0',
      'SECURITY-APPNAME': EBAY_APP_ID,
      'GLOBAL-ID': 'EBAY-US',
      'RESPONSE-DATA-FORMAT': 'JSON',
      'REST-PAYLOAD': true,
      'keywords': keywords,
      'categoryId': '212', // Sports Mem, Cards & Fan Shop
      'itemFilter(0).name': 'Condition',
      'itemFilter(0).value': 'Used',
      'itemFilter(1).name': 'ListingType',
      'itemFilter(1).value(0)': 'FixedPrice',
      'itemFilter(1).value(1)': 'Auction',
      'sortOrder': 'BestMatch',
      'paginationInput.entriesPerPage': 20 // Increased from 10 to get more results
    };

    // Make the API request
    const response = await axios.get(EBAY_FINDING_API_URL, { params });
    const data = response.data;

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

    return {
      averageValue,
      results
    };
  } catch (error) {
    console.error('Error searching eBay for card values:', error);
    return { averageValue: 0, results: [] };
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
  
  // Determine if this is a Heritage card
  const isHeritage = collection && collection.toLowerCase().includes('heritage');
  
  // Build search terms using same logic as API search
  let keywords = '';
  
  if (isHeritage) {
    keywords = `${lastName} ${brand} Heritage ${year}`;
    if (/^\d+$/.test(cardNumber)) {
      keywords += ` ${cardNumber}`;
    }
  } else {
    keywords = `${lastName} ${brand} ${year}`;
    if (/^\d+$/.test(cardNumber)) {
      keywords += ` ${cardNumber}`;
    }
  }
  
  // Encode for URL
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(keywords)}&_sacat=0&LH_Complete=1&LH_Sold=1`;
}