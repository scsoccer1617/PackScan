import { CardFormValues } from "@shared/schema";
import { extractTextFromImage } from "./googleVisionFetch";

/**
 * A simplified card analyzer that avoids complex detection logic and focuses on 
 * reliable pattern detection with proper error handling
 */
export async function analyzeSportsCardImage(base64Image: string): Promise<Partial<CardFormValues>> {
  try {
    // Extract the text from the image
    const result = await extractTextFromImage(base64Image);
    const fullText = result.fullText || '';
    
    console.log('Full OCR text:', fullText);
    
    // Initialize card details with default values
    const cardDetails: Partial<CardFormValues> = {
      condition: 'PSA 8',
      playerFirstName: '',
      playerLastName: '',
      brand: '',
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
    
    // STEP 1: Try to identify the player name using various patterns
    
    // First check for brand name "SCORE" to avoid confusing it with player name
    if (cleanText.includes('SCORE') && !cleanText.includes('SCORE CARD')) {
      cardDetails.brand = 'Score';
      console.log(`Detected brand: Score`);
      
      // For Score cards, player name typically appears after the brand and card number
      const scoreNamePattern = /SCORE[\s\n]+([A-Z]+)[\s\n]+([A-Z]+)[\s\n]/;
      const scoreNameMatch = cleanText.match(scoreNamePattern);
      
      if (scoreNameMatch && scoreNameMatch[1] && scoreNameMatch[2]) {
        cardDetails.playerFirstName = formatName(scoreNameMatch[1]);
        cardDetails.playerLastName = formatName(scoreNameMatch[2]);
        console.log(`Detected Score card player name: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
      }
    } else {
      // Standard pattern for most modern cards
      const nameMatch = cleanText.match(/^[\s\n]*([A-Z]+)[\s\n]+([A-Z]+)[\s\n]/);
      if (nameMatch && nameMatch[1] && nameMatch[2]) {
        cardDetails.playerFirstName = formatName(nameMatch[1]);
        cardDetails.playerLastName = formatName(nameMatch[2]);
        console.log(`Detected player name from name pattern: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
      }
    }
    
    // STEP 2: Try to identify the card number
    // First check for Score card numbers which often appear at the top or corner
    if (cardDetails.brand === 'Score') {
      // Score cards typically have a number at the beginning or in a corner
      const scoreNumberMatch = cleanText.match(/^[\s\n]*(\d{1,3})\b/);
      if (scoreNumberMatch && scoreNumberMatch[1]) {
        cardDetails.cardNumber = scoreNumberMatch[1];
        console.log(`Detected Score card number: ${cardDetails.cardNumber}`);
      }
    }
    
    // Standard pattern for modern cards with dash format
    if (!cardDetails.cardNumber) {
      const dashNumberMatch = cleanText.match(/\b([A-Z0-9]+)-([0-9]+)\b/);
      if (dashNumberMatch && dashNumberMatch[0]) {
        cardDetails.cardNumber = dashNumberMatch[0];
        console.log(`Detected card number with dash: ${cardDetails.cardNumber}`);
        
        // Check for 35th Anniversary card format
        if (dashNumberMatch[0].match(/^\d+[A-Z]-\d+$/)) {
          cardDetails.collection = "35th Anniversary";
          console.log(`Setting collection from card number pattern: 35th Anniversary`);
        }
      }
    }
    
    // STEP 3: Detect brand (especially Topps)
    if (cleanText.includes('TOPPS')) {
      cardDetails.brand = 'Topps';
      console.log(`Detected brand: Topps`);
    }
    
    // STEP 4: Check for specific collection patterns
    if (cardDetails.brand === 'Score') {
      // For Score cards, check for specific collections
      if (cleanText.includes('SCORE TRADED') || cleanText.includes('TRADED SET')) {
        cardDetails.collection = 'Score Traded';
        console.log(`Detected collection: Score Traded`);
      } else if (cleanText.includes('SCORE RISING STARS')) {
        cardDetails.collection = 'Rising Stars';
        console.log(`Detected collection: Rising Stars`);
      } else if (cleanText.includes('SCORE DREAM TEAM')) {
        cardDetails.collection = 'Dream Team';
        console.log(`Detected collection: Dream Team`);
      } else {
        // For standard Score base cards, use the year as the collection
        if (cardDetails.year) {
          cardDetails.collection = `${cardDetails.year} Score`;
          console.log(`Setting Score base collection with year: ${cardDetails.collection}`);
        } else {
          cardDetails.collection = 'Score Base';
          console.log(`Setting Score base collection`);
        }
      }
    } 
    // Handle modern Topps collections
    else if (cleanText.includes('STARS OF MLB') || cleanText.includes('SMLB')) {
      cardDetails.collection = 'Stars of MLB';
      console.log(`Detected collection: Stars of MLB`);
    } 
    else if (cleanText.includes('CHROME STARS OF MLB') || cleanText.includes('CSMLB')) {
      cardDetails.collection = 'Stars of MLB';
      cardDetails.variant = 'Chrome';
      console.log(`Detected collection: Stars of MLB (Chrome variant)`);
    }
    else if (cleanText.includes('HERITAGE')) {
      cardDetails.collection = 'Heritage';
      console.log(`Detected collection: Heritage`);
    }
    
    // STEP 5: Check for Chrome variant
    if (cleanText.includes('CHROME') && !cardDetails.variant) {
      cardDetails.variant = 'Chrome';
      console.log(`Detected variant: Chrome`);
    }
    
    // STEP 6: Look for copyright year
    const copyrightMatch = cleanText.match(/(?:©|\(C\)|\&copy;|\&\s*©|\&\s*\(C\))(?:\s*)(\d{4})/i);
    if (copyrightMatch && copyrightMatch[1]) {
      const year = parseInt(copyrightMatch[1]);
      if (year >= 1900 && year <= new Date().getFullYear()) {
        cardDetails.year = year;
        console.log(`Using copyright year as card date: ${cardDetails.year}`);
      }
    }
    
    // STEP 7: Check for rookie card status
    if (cleanText.includes('RC') || cleanText.includes('ROOKIE')) {
      cardDetails.isRookieCard = true;
      console.log(`Detected rookie card status`);
    }
    
    // STEP 8: Check sport indicators
    if (cleanText.includes('MLB') || cleanText.includes('BASEBALL')) {
      cardDetails.sport = 'Baseball';
      console.log(`Sport detected: Baseball`);
    } 
    else if (cleanText.includes('NFL') || cleanText.includes('FOOTBALL')) {
      cardDetails.sport = 'Football';
      console.log(`Sport detected: Football`);
    }
    else if (cleanText.includes('NBA') || cleanText.includes('BASKETBALL')) {
      cardDetails.sport = 'Basketball'; 
      console.log(`Sport detected: Basketball`);
    }
    
    console.log('Extracted card details:', cardDetails);
    return cardDetails;
  } catch (error) {
    console.error('Error analyzing card image:', error);
    return {
      condition: 'PSA 8',
      sport: 'Baseball',
      playerFirstName: 'Unknown',
      playerLastName: 'Player',
      brand: 'Topps',
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