import { CardFormValues } from "@shared/schema";
import { extractTextFromImage } from "./googleVisionFetch";

/**
 * A specialized card analyzer for handling Score brand cards from the 1980s-1990s
 * that have different layouts than modern cards
 */
export async function analyzeScoreCard(base64Image: string): Promise<Partial<CardFormValues>> {
  try {
    // Extract the text from the image
    const result = await extractTextFromImage(base64Image);
    const fullText = result.fullText || '';
    const textAnnotations = result.textAnnotations || [];
    
    console.log('Full OCR text for Score card:', fullText);
    
    // Initialize card details with default values
    const cardDetails: Partial<CardFormValues> = {
      condition: 'PSA 8',
      playerFirstName: '',
      playerLastName: '',
      brand: 'Score',
      collection: '',
      cardNumber: '',
      year: new Date().getFullYear(),
      variant: '',
      serialNumber: '',
      estimatedValue: 0,
      sport: 'Baseball',
      isRookieCard: false,
      isAutographed: false,
      isNumbered: false
    };
    
    // Clean text for processing
    const cleanText = fullText.toUpperCase().replace(/\s+/g, ' ').trim();
    
    // STEP 1: Extract the card number for Score cards (usually at the top of the card)
    const cardNumberMatch = cleanText.match(/^[\s\n]*(\d{1,3})\b/);
    if (cardNumberMatch && cardNumberMatch[1]) {
      cardDetails.cardNumber = cardNumberMatch[1];
      console.log(`Detected Score card number: ${cardDetails.cardNumber}`);
    }
    
    // STEP 2: Extract player name (Score cards typically have name right after the card number and brand)
    const namePatterns = [
      // Pattern for name after SCORE
      /SCORE[\s\n]+([A-Z]+)[\s\n]+([A-Z]+)[\s\n]/,
      // Pattern for name near position
      /([A-Z]+)[\s\n]+([A-Z]+)[\s\n]+\d{1,2}[\s\n]*[-–][\s\n]*([A-Z]+)/,
      // Generic name pattern with two consecutive capitalized words
      /\b([A-Z]{2,})[\s\n]+([A-Z]{2,})\b/
    ];
    
    let nameFound = false;
    for (const pattern of namePatterns) {
      const nameMatch = cleanText.match(pattern);
      if (nameMatch && nameMatch[1] && nameMatch[2] && !nameFound) {
        // Avoid setting "SCORE" as the first name
        if (nameMatch[1] !== 'SCORE') {
          cardDetails.playerFirstName = formatName(nameMatch[1]);
          cardDetails.playerLastName = formatName(nameMatch[2]);
          console.log(`Detected player name: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
          nameFound = true;
          break;
        }
      }
    }
    
    // STEP 3: Extract year from copyright information
    const copyrightPatterns = [
      /©\s*(\d{4})/i,
      /\(C\)\s*(\d{4})/i,
      /COPYRIGHT\s*(\d{4})/i,
      /&COPY;\s*(\d{4})/i,
      /&\s*©\s*(\d{4})/i,
      /&\s*\(C\)\s*(\d{4})/i
    ];
    
    for (const pattern of copyrightPatterns) {
      const yearMatch = cleanText.match(pattern);
      if (yearMatch && yearMatch[1]) {
        const year = parseInt(yearMatch[1]);
        if (year >= 1900 && year <= new Date().getFullYear()) {
          cardDetails.year = year;
          console.log(`Detected copyright year: ${cardDetails.year}`);
          break;
        }
      }
    }
    
    // STEP 4: Set collection based on year and brand
    if (cardDetails.year) {
      cardDetails.collection = `${cardDetails.year} Score`;
      console.log(`Set collection: ${cardDetails.collection}`);
    }
    
    // STEP 5: Check for rookie card status
    if (
      cleanText.includes('ROOKIE') || 
      cleanText.includes('RC') || 
      cleanText.includes('FIRST YEAR') || 
      cleanText.includes('PROSPECT') ||
      cleanText.includes('FUTURE STARS')
    ) {
      cardDetails.isRookieCard = true;
      console.log('Detected rookie card status');
    }
    
    // STEP 6: Confirm sport type
    if (cleanText.includes('BASEBALL') || cleanText.includes('MLB') || cleanText.includes('MAJOR LEAGUE')) {
      cardDetails.sport = 'Baseball';
      console.log('Confirmed sport: Baseball');
    } else if (cleanText.includes('FOOTBALL') || cleanText.includes('NFL')) {
      cardDetails.sport = 'Football';
      console.log('Detected sport: Football');
    } else if (cleanText.includes('BASKETBALL') || cleanText.includes('NBA')) {
      cardDetails.sport = 'Basketball';
      console.log('Detected sport: Basketball');
    }
    
    console.log('Extracted Score card details:', cardDetails);
    return cardDetails;
  } catch (error) {
    console.error('Error analyzing Score card:', error);
    return {
      condition: 'PSA 8',
      sport: 'Baseball',
      playerFirstName: 'Unknown',
      playerLastName: 'Player',
      brand: 'Score',
      year: new Date().getFullYear()
    };
  }
}

/**
 * Format a name with proper capitalization
 */
function formatName(name: string): string {
  return name.toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}