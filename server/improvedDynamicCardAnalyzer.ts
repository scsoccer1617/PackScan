import { CardFormValues } from "@shared/schema";
import { extractTextFromImage } from "./googleVisionFetch";

/**
 * Analyze a sports card image to extract relevant information
 * @param base64Image Base64 encoded image data
 * @returns Object with extracted card information
 */
export async function analyzeSportsCardImage(base64Image: string): Promise<Partial<CardFormValues>> {
  try {
    // Extract the text from the image
    const result = await extractTextFromImage(base64Image);
    const fullText = result.fullText;
    
    console.log('Full OCR text:', fullText);
    
    // Initialize card details object with default values
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
    
    // Clean up the text for consistent processing
    const cleanText = fullText.toUpperCase().replace(/\s+/g, ' ').trim();
    
    // PLAYER NAME DETECTION
    const playerNameMatch = detectPlayerName(cleanText);
    if (playerNameMatch) {
      cardDetails.playerFirstName = playerNameMatch.firstName;
      cardDetails.playerLastName = playerNameMatch.lastName;
      console.log(`Detected player name: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
    }
    
    // CARD NUMBER DETECTION
    const cardNumber = detectCardNumber(cleanText);
    if (cardNumber) {
      cardDetails.cardNumber = cardNumber;
      console.log(`Detected card number: ${cardDetails.cardNumber}`);
      
      // Check if this is a 35th Anniversary card based on number format
      if (cardNumber.match(/^\d+[A-Z]-\d+$/)) {
        cardDetails.collection = "35th Anniversary";
        console.log(`Setting collection from card number pattern: 35th Anniversary`);
      }
    }
    
    // BRAND DETECTION
    const brand = detectBrand(cleanText);
    if (brand) {
      cardDetails.brand = brand;
      console.log(`Detected brand: ${cardDetails.brand}`);
    }
    
    // COLLECTION & VARIANT DETECTION
    const collectionInfo = detectCollection(cleanText);
    if (collectionInfo.collection) {
      cardDetails.collection = collectionInfo.collection;
      console.log(`Detected collection: ${cardDetails.collection}`);
    }
    if (collectionInfo.variant) {
      cardDetails.variant = collectionInfo.variant;
      console.log(`Detected variant: ${cardDetails.variant}`);
    }
    
    // YEAR DETECTION
    const year = detectYear(cleanText);
    if (year) {
      cardDetails.year = year;
      console.log(`Detected year: ${cardDetails.year}`);
    }
    
    // SERIAL NUMBER DETECTION
    const serialNumber = detectSerialNumber(cleanText);
    if (serialNumber) {
      cardDetails.serialNumber = serialNumber;
      cardDetails.isNumbered = true;
      console.log(`Detected serial number: ${cardDetails.serialNumber}`);
    }
    
    // ROOKIE CARD DETECTION
    cardDetails.isRookieCard = cleanText.includes('RC') || 
                              cleanText.includes('ROOKIE') || 
                              cleanText.includes('1ST YEAR');
    console.log(`Rookie card status: ${cardDetails.isRookieCard}`);
    
    // AUTOGRAPH DETECTION
    cardDetails.isAutographed = cleanText.includes('AUTO') || 
                               cleanText.includes('AUTOGRAPH') || 
                               cleanText.includes('SIGNED');
    console.log(`Autographed card status: ${cardDetails.isAutographed}`);
    
    // SPORT DETECTION
    const sport = detectSport(cleanText);
    if (sport) {
      cardDetails.sport = sport;
      console.log(`Detected sport: ${cardDetails.sport}`);
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
 * Detect player name from card text
 */
function detectPlayerName(text: string): { firstName: string, lastName: string } | null {
  try {
    // Look for a player name at the beginning of the text (common for card fronts)
    const topNamePattern = /^[\s\n]*([A-Z]+)[\s\n]+([A-Z]+)[\s\n]/;
    const topNameMatch = text.match(topNamePattern);
    
    if (topNameMatch && topNameMatch[1] && topNameMatch[2]) {
      return {
        firstName: formatName(topNameMatch[1]),
        lastName: formatName(topNameMatch[2])
      };
    }
    
    // Try a more general pattern for names
    const namePattern = /\b([A-Z]+)[\s]+([A-Z]+)\b/;
    const nameMatch = text.match(namePattern);
    
    if (nameMatch && nameMatch[1] && nameMatch[2]) {
      return {
        firstName: formatName(nameMatch[1]),
        lastName: formatName(nameMatch[2])
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error detecting player name:', error);
    return null;
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

/**
 * Detect card number from text
 */
function detectCardNumber(text: string): string | null {
  try {
    // Format: 89B-2 (alphanumeric with dash)
    const dashNumberPattern = /\b([A-Z0-9]+)-([0-9]+)\b/;
    const dashNumberMatch = text.match(dashNumberPattern);
    
    if (dashNumberMatch && dashNumberMatch[0]) {
      return dashNumberMatch[0];
    }
    
    // Format: #123 or No. 123
    const plainNumberPattern = /(?:#|No\.\s*)(\d+)/i;
    const plainNumberMatch = text.match(plainNumberPattern);
    
    if (plainNumberMatch && plainNumberMatch[1]) {
      return plainNumberMatch[1];
    }
    
    // Alphanumeric patterns like: T27, TC12, etc.
    const alphaNumPattern = /\b([A-Z]{1,3})(\d+)\b/;
    const alphaNumMatch = text.match(alphaNumPattern);
    
    if (alphaNumMatch && alphaNumMatch[0]) {
      return alphaNumMatch[0];
    }
    
    return null;
  } catch (error) {
    console.error('Error detecting card number:', error);
    return null;
  }
}

/**
 * Detect card brand
 */
function detectBrand(text: string): string | null {
  const brands = [
    { pattern: /TOPPS/i, name: 'Topps' },
    { pattern: /BOWMAN/i, name: 'Bowman' },
    { pattern: /UPPER DECK/i, name: 'Upper Deck' },
    { pattern: /PANINI/i, name: 'Panini' },
    { pattern: /DONRUSS/i, name: 'Donruss' },
    { pattern: /FLEER/i, name: 'Fleer' }
  ];
  
  for (const brand of brands) {
    if (text.match(brand.pattern)) {
      return brand.name;
    }
  }
  
  return null;
}

/**
 * Detect card collection and variant
 */
function detectCollection(text: string): { collection: string | null, variant: string | null } {
  const result = {
    collection: null as string | null,
    variant: null as string | null
  };
  
  const collections = [
    { pattern: /STARS OF MLB|SMLB/i, name: 'Stars of MLB' },
    { pattern: /CHROME STARS OF MLB|CSMLB/i, name: 'Stars of MLB', variant: 'Chrome' },
    { pattern: /HERITAGE/i, name: 'Heritage' },
    { pattern: /ALLEN & GINTER|ALLEN AND GINTER/i, name: 'Allen & Ginter' },
    { pattern: /35TH ANNIVERSARY/i, name: '35th Anniversary' },
    { pattern: /STADIUM CLUB/i, name: 'Stadium Club' },
    { pattern: /BOWMAN CHROME/i, name: 'Bowman Chrome' },
    { pattern: /CHROME/i, variant: 'Chrome' }
  ];
  
  for (const collection of collections) {
    if (text.match(collection.pattern)) {
      if (collection.name) result.collection = collection.name;
      if (collection.variant) result.variant = collection.variant;
      break;
    }
  }
  
  return result;
}

/**
 * Detect card year from copyright or other indicators
 */
function detectYear(text: string): number | null {
  try {
    // Check for copyright year first (most reliable)
    const copyrightPattern = /(?:©|\(C\)|\&copy;|\&\s*©|\&\s*\(C\))(?:\s*)(\d{4})/i;
    const copyrightMatch = text.match(copyrightPattern);
    
    if (copyrightMatch && copyrightMatch[1]) {
      const year = parseInt(copyrightMatch[1], 10);
      if (year >= 1900 && year <= new Date().getFullYear()) {
        return year;
      }
    }
    
    // Fall back to looking for standalone 4-digit years
    const yearPattern = /\b(19\d{2}|20\d{2})\b/;
    const yearMatch = text.match(yearPattern);
    
    if (yearMatch && yearMatch[1]) {
      const year = parseInt(yearMatch[1], 10);
      if (year >= 1900 && year <= new Date().getFullYear()) {
        return year;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error detecting year:', error);
    return null;
  }
}

/**
 * Detect serial numbering on the card
 */
function detectSerialNumber(text: string): string | null {
  try {
    // Look for common serial number formats
    const serialPatterns = [
      /\b(\d+)\/(\d+)\b/,  // Format: 123/1000
      /\b(\d+)\s+OF\s+(\d+)\b/i  // Format: 123 OF 1000
    ];
    
    for (const pattern of serialPatterns) {
      const match = text.match(pattern);
      if (match && match[1] && match[2]) {
        const serialNumber = parseInt(match[1], 10);
        const totalNumber = parseInt(match[2], 10);
        
        // Validate that this looks like a real serial number
        if (serialNumber < totalNumber && totalNumber <= 10000 && serialNumber > 0) {
          return `${serialNumber}/${totalNumber}`;
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error detecting serial number:', error);
    return null;
  }
}

/**
 * Detect the sport category of the card
 */
function detectSport(text: string): string | null {
  // Check for explicit sport indicators
  if (text.match(/\bBASEBALL\b|\bMLB\b|\bMAJOR LEAGUE BASEBALL\b/i)) {
    return "Baseball";
  } 
  else if (text.match(/\bFOOTBALL\b|\bNFL\b|\bNATIONAL FOOTBALL LEAGUE\b/i)) {
    return "Football";
  } 
  else if (text.match(/\bBASKETBALL\b|\bNBA\b|\bNATIONAL BASKETBALL ASSOCIATION\b/i)) {
    return "Basketball";
  } 
  else if (text.match(/\bHOCKEY\b|\bNHL\b|\bNATIONAL HOCKEY LEAGUE\b/i)) {
    return "Hockey";
  } 
  else if (text.match(/\bSOCCER\b|\bMLS\b|\bMAJOR LEAGUE SOCCER\b|\bFIFA\b/i)) {
    return "Soccer";
  }
  
  // Check for team indicators
  if (text.match(/\bYANKEES\b|\bRED SOX\b|\bDODGERS\b|\bCUBS\b|\bGIANTS\b|\bCARDINALS\b|\bBRAVES\b|\bASTROS\b|\bPHILLIES\b|\bMETS\b|\bANGELS\b|\bPADRES\b/i)) {
    return "Baseball";
  }
  else if (text.match(/\bPATRIOTS\b|\bCOWBOYS\b|\bPACKERS\b|\b49ERS\b|\bSTEELERS\b|\bEAGLES\b|\bRAVENS\b|\bCHIEFS\b/i)) {
    return "Football";
  }
  else if (text.match(/\bLAKERS\b|\bCELTICS\b|\bBULLS\b|\bWARRIORS\b|\bKNICKS\b|\bHEAT\b|\bSPURS\b|\bBUCKS\b/i)) {
    return "Basketball";
  }
  
  // Default to baseball if we can't determine
  return null;
}