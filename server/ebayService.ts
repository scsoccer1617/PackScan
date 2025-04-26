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
  condition?: string
): Promise<{ averageValue: number; results: EbaySearchResult[] }> {
  try {
    if (!EBAY_APP_ID) {
      console.warn('eBay API credentials not set. Cannot fetch card values.');
      return { averageValue: 0, results: [] };
    }

    // Build search query based on card details
    let keywords = `${playerName} ${brand} ${year} ${cardNumber}`;
    
    // Add condition if provided
    if (condition) {
      keywords += ` ${condition}`;
    }

    // API request parameters
    const params = {
      'OPERATION-NAME': 'findCompletedItems',
      'SERVICE-VERSION': '1.0.0',
      'SECURITY-APPNAME': EBAY_APP_ID,
      'RESPONSE-DATA-FORMAT': 'JSON',
      'REST-PAYLOAD': true,
      'keywords': keywords,
      'itemFilter(0).name': 'SoldItemsOnly',
      'itemFilter(0).value': 'true',
      'itemFilter(1).name': 'ListingType',
      'itemFilter(1).value(0)': 'FixedPrice',
      'itemFilter(1).value(1)': 'Auction',
      'sortOrder': 'EndTimeSoonest',
      'paginationInput.entriesPerPage': 10
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
      data.findCompletedItemsResponse && 
      data.findCompletedItemsResponse[0] && 
      data.findCompletedItemsResponse[0].searchResult && 
      data.findCompletedItemsResponse[0].searchResult[0] && 
      data.findCompletedItemsResponse[0].searchResult[0].item
    ) {
      const items = data.findCompletedItemsResponse[0].searchResult[0].item;
      
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
  condition?: string
): string {
  let keywords = encodeURIComponent(`${playerName} ${brand} ${year} ${cardNumber} ${condition || ''}`).trim();
  return `https://www.ebay.com/sch/i.html?_nkw=${keywords}&_sacat=0&LH_Complete=1&LH_Sold=1`;
}