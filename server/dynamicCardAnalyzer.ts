import { CardFormValues } from "@shared/schema";
import { extractTextFromImage } from "./googleVisionFetch";

interface TextAnnotation {
  description: string;
  boundingPoly?: {
    vertices: Array<{
      x: number;
      y: number;
    }>;
  };
}

interface OCRResult {
  fullText: string;
  textAnnotations: TextAnnotation[];
}

/**
 * Extract text from image using Google Cloud Vision API
 * @param base64Image Base64 encoded image
 * @returns Extracted text and text annotations
 */
export async function getTextFromImage(base64Image: string): Promise<OCRResult> {
  const result = await extractTextFromImage(base64Image);
  return {
    fullText: result.fullText,
    textAnnotations: result.textAnnotations
  };
}

/**
 * Analyze a sports card image to extract relevant information dynamically without player-specific handlers
 * @param base64Image Base64 encoded image data
 * @returns Object with extracted card information
 */
export async function analyzeSportsCardImage(base64Image: string): Promise<Partial<CardFormValues>> {
  try {
    // Extract the text from the image
    const { fullText, textAnnotations } = await getTextFromImage(base64Image);
    
    console.log('Full OCR text:', fullText);
    
    // Initialize card details object with default values
    const cardDetails: Partial<CardFormValues> = {
      condition: 'PSA 8', // Default condition per requirements
      estimatedValue: 0, // Default value
    };
    
    // Parse all extracted text
    const cleanText = fullText.toUpperCase().replace(/\s+/g, ' ').trim();
    
    // PLAYER NAME DETECTION - Extract player name using positional and context analysis
    extractPlayerName(cleanText, cardDetails);
    
    // CARD NUMBER DETECTION - Extract card number using regex patterns
    extractCardNumber(cleanText, cardDetails);
    
    // COLLECTION, BRAND & YEAR DETECTION - Extract using pattern recognition
    extractCardMetadata(cleanText, cardDetails);
    
    // SERIAL NUMBER DETECTION - Look for serial numbering
    extractSerialNumber(cleanText, cardDetails);
    
    // CARD FEATURES DETECTION - Rookie cards, autographs, etc.
    detectCardFeatures(cleanText, cardDetails);
    
    console.log('Extracted card details:', cardDetails);
    return cardDetails;
  } catch (error) {
    console.error('Error analyzing card image:', error);
    throw error;
  }
}

/**
 * Extract player name using pattern recognition and common positions
 */
function extractPlayerName(text: string, cardDetails: Partial<CardFormValues>): void {
  // Common sports names that might be in the text (not player-specific)
  const sportKeywords = ['BASEBALL', 'FOOTBALL', 'BASKETBALL', 'HOCKEY', 'SOCCER', 'MLB', 'NFL', 'NBA', 'NHL'];
  
  // Exclude words that are commonly misidentified as player names
  const excludedPlayerNames = ['MAJOR LEAGUE', 'BASEBALL', 'TRADING CARD', 'TOPPS', 'PANINI', 'UPPER DECK'];
  
  // Try to extract player name using various patterns and positions
  
  // Pattern 1: Look for potential name at the beginning of the text (most common position)
  let nameParts = text.split(' ').slice(0, 3);
  let potentialName = nameParts.join(' ');
  
  // Check if the potential name contains excluded terms
  const isExcluded = excludedPlayerNames.some(term => potentialName.includes(term));
  
  if (!isExcluded && nameParts.length >= 2) {
    // Basic validation - names typically don't contain digits or special characters
    if (!/[0-9*#@<>]/.test(potentialName) && !/MLB|NFL|NBA|NHL/.test(potentialName)) {
      cardDetails.playerFirstName = nameParts[0].toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
        
      cardDetails.playerLastName = nameParts.slice(1).join(' ').toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
      
      console.log(`Detected player name (pattern 1): ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
      return;
    }
  }
  
  // Pattern 2: Try to find player name using positional analysis - sometimes the name is positioned
  // near a team name or position indicator like "PITCHER", "INFIELDER", etc.
  const teams = ['YANKEES', 'RED SOX', 'DODGERS', 'CUBS', 'ANGELS', 'BRAVES', 'TWINS', 'PADRES', 'BREWERS'];
  const positions = ['PITCHER', 'CATCHER', 'INFIELDER', 'OUTFIELDER'];
  
  // Search for a team name or position, then look for nearby words that might be a player name
  for (const keyword of [...teams, ...positions]) {
    if (text.includes(keyword)) {
      const index = text.indexOf(keyword);
      const beforeKeyword = text.substring(0, index).trim().split(' ');
      
      // Take the last few words before the team/position as the potential name
      if (beforeKeyword.length >= 2) {
        const firstName = beforeKeyword[beforeKeyword.length - 2];
        const lastName = beforeKeyword[beforeKeyword.length - 1];
        
        // Basic validation
        if (!/[0-9*#@<>]/.test(firstName + lastName) && 
            !sportKeywords.includes(firstName) && 
            !sportKeywords.includes(lastName) &&
            !excludedPlayerNames.includes(`${firstName} ${lastName}`)) {
          
          cardDetails.playerFirstName = firstName.toLowerCase()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
            
          cardDetails.playerLastName = lastName.toLowerCase()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
          
          console.log(`Detected player name (pattern 2): ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
          return;
        }
      }
    }
  }
  
  console.log('Could not detect player name with confidence. Setting generic values.');
  cardDetails.playerFirstName = 'Unknown';
  cardDetails.playerLastName = 'Player';
}

/**
 * Extract card number using regex patterns for common formats
 */
function extractCardNumber(text: string, cardDetails: Partial<CardFormValues>): void {
  // Card number patterns to look for
  const cardNumberPatterns = [
    // Baseball special formats
    { regex: /\b(\d{1,2}[Bb][^a-zA-Z0-9\s][0-9]{1,2})\b/, format: "35th Anniversary", example: "89B-9" },
    { regex: /\b(\d{1,2}[Bb]\d[-]?\d{1,2})\b/, format: "35th Anniversary", example: "89B2-32" },
    { regex: /\b(\d{1,2}[Bb][-]?\d{1,2})\b/, format: "35th Anniversary", example: "89B-32" },
    
    // Team code formats
    { regex: /\b([A-Z]{3}[-]?\d{1,2})\b/, format: "Team code", example: "HOU-11" },
    
    // Special MLB series formats
    { regex: /\b(CSMLB[-]?[0-9]{1,2})\b/i, format: "Chrome Stars MLB", example: "CSMLB-2" },
    { regex: /\b(CSMLB)\b\s*[-]?\s*([0-9]{1,2})\b/i, format: "Chrome Stars MLB", example: "CSMLB 2" },
    { regex: /\b(CSMLB[0-9]{1,2})\b/i, format: "Chrome Stars MLB", example: "CSMLB2" },
    { regex: /\b(SMLB[-]?[0-9]{1,2})\b/i, format: "Stars MLB", example: "SMLB-27" },
    { regex: /\b(SMLB)\b\s*[-]?\s*([0-9]{1,2})\b/i, format: "Stars MLB", example: "SMLB 27" },
    { regex: /\b(SMLB[0-9]{1,2})\b/i, format: "Stars MLB", example: "SMLB27" },
    
    // Other common formats
    { regex: /\b(\d{1,3}[A-Z]{1,2}[0-9]{0,3})\b/, format: "Alphanumeric", example: "89BC" },
    { regex: /\b(\d{1,3}[A-Z]?\-\d{1,3})\b/, format: "Numbered with dash", example: "89-32" },
    
    // Simple numeric card numbers (should be tried last)
    { regex: /\bCARD ([0-9]{1,3})\b/i, format: "Card number", example: "Card 27" },
    { regex: /\bNO\.\s*([0-9]{1,3})\b/i, format: "No. format", example: "No. 35" },
    { regex: /\b#\s*([0-9]{1,3})\b/, format: "Hash format", example: "#47" },
    { regex: /\b([0-9]{1,3})\b/, format: "Simple number", example: "42" }
  ];
  
  // Try each card number pattern
  for (const pattern of cardNumberPatterns) {
    const match = text.match(pattern.regex);
    if (match) {
      const detectedCardNumber = match[1];
      console.log(`Detected ${pattern.format} card number: ${detectedCardNumber} (example: ${pattern.example})`);
      
      // Set the card number
      cardDetails.cardNumber = detectedCardNumber;
      
      // For SMLB/CSMLB series, set collection appropriately
      if (pattern.format === "Stars MLB" && !cardDetails.collection) {
        cardDetails.collection = "Stars of MLB";
        cardDetails.brand = "Topps";
      } else if (pattern.format === "Chrome Stars MLB" && !cardDetails.collection) {
        cardDetails.collection = "Chrome Stars of MLB";
        cardDetails.brand = "Topps";
      } else if (pattern.format === "35th Anniversary" && !cardDetails.collection) {
        cardDetails.collection = "35th Anniversary";
        cardDetails.brand = "Topps";
        cardDetails.year = 2024;
      }
      
      return;
    }
  }
  
  console.log('No card number pattern detected.');
}

/**
 * Extract card metadata (collection, brand, year) using context analysis
 */
function extractCardMetadata(text: string, cardDetails: Partial<CardFormValues>): void {
  // Brand detection
  const brandPatterns = [
    { regex: /\bTOPPS\b/, name: "Topps" },
    { regex: /\bUPPER\s*DECK\b/, name: "Upper Deck" },
    { regex: /\bPANINI\b/, name: "Panini" },
    { regex: /\bDONRUSS\b/, name: "Donruss" },
    { regex: /\bFLEER\b/, name: "Fleer" },
    { regex: /\bBOWMAN\b/, name: "Bowman" },
    // Common OCR mistakes
    { regex: /\bTCPPS\b/, name: "Topps" },
    { regex: /\bLAPPS\b/, name: "Topps" }
  ];
  
  // Try to detect brand
  for (const brand of brandPatterns) {
    if (brand.regex.test(text)) {
      cardDetails.brand = brand.name;
      console.log(`Detected brand: ${brand.name}`);
      break;
    }
  }
  
  // Collection detection
  const collectionPatterns = [
    { regex: /\bSTARS\s*OF\s*MLB\b/, name: "Stars of MLB" },
    { regex: /\bCHROME\s*STARS\b/, name: "Chrome Stars of MLB" },
    { regex: /\bSERIES\s*ONE\b|\bSERIES\s*1\b/, name: "Series One" },
    { regex: /\bSERIES\s*TWO\b|\bSERIES\s*2\b/, name: "Series Two" },
    { regex: /\b35TH\s*ANNIVERSARY\b/, name: "35th Anniversary" },
    { regex: /\bHERITAGE\b/, name: "Heritage" }
  ];
  
  // Try to detect collection
  for (const collection of collectionPatterns) {
    if (collection.regex.test(text)) {
      cardDetails.collection = collection.name;
      console.log(`Detected collection: ${collection.name}`);
      
      // Set default year for modern collections if not already set
      if (!cardDetails.year && (
          collection.name === "35th Anniversary" || 
          collection.name === "Chrome Stars of MLB" || 
          collection.name === "Series One" || 
          collection.name === "Series Two")) {
        cardDetails.year = 2024;
      } else if (!cardDetails.year && collection.name === "Stars of MLB") {
        cardDetails.year = 2023;
      }
      
      break;
    }
  }
  
  // Year detection - copyright symbol is most reliable for card year
  const yearPatterns = [
    { regex: /[©Ⓒ]\s*(?:&\s*[©Ⓒ])?\s*(\d{4})/, description: "Copyright year" },
    { regex: /\b(20\d{2})\b/, description: "Plain year" }
  ];
  
  // Try to detect year
  for (const pattern of yearPatterns) {
    const match = text.match(pattern.regex);
    if (match) {
      cardDetails.year = parseInt(match[1], 10);
      console.log(`Detected year (${pattern.description}): ${cardDetails.year}`);
      break;
    }
  }
  
  // Set sport (default to Baseball for now)
  if (!cardDetails.sport) {
    cardDetails.sport = "Baseball";
    
    // Try to detect other sports
    if (text.includes("FOOTBALL") || text.includes("NFL")) {
      cardDetails.sport = "Football";
    } else if (text.includes("BASKETBALL") || text.includes("NBA")) {
      cardDetails.sport = "Basketball";
    } else if (text.includes("HOCKEY") || text.includes("NHL")) {
      cardDetails.sport = "Hockey";
    }
  }
}

/**
 * Extract serial number if present
 */
function extractSerialNumber(text: string, cardDetails: Partial<CardFormValues>): void {
  // Common serial number patterns (typically low numbers out of a print run)
  const serialPatterns = [
    /\b(\d{1,4})\s*\/\s*(\d{1,5})\b/, // Format: 123/1000
    /\b(\d{1,4})\s+OF\s+(\d{1,5})\b/i // Format: 123 OF 1000
  ];
  
  for (const pattern of serialPatterns) {
    const match = text.match(pattern);
    if (match) {
      cardDetails.serialNumber = match[0];
      console.log(`Detected serial number: ${cardDetails.serialNumber}`);
      cardDetails.isNumbered = true;
      return;
    }
  }
}

/**
 * Detect special card features (rookie, autograph, etc.)
 */
function detectCardFeatures(text: string, cardDetails: Partial<CardFormValues>): void {
  // Rookie card detection
  if (text.includes('ROOKIE') || text.includes('RC') || text.includes('R.C.') || 
      text.includes('FIRST YEAR') || text.includes('DEBUT')) {
    cardDetails.isRookieCard = true;
    console.log('Detected rookie card');
  }
  
  // Autograph detection
  if (text.includes('AUTO') || text.includes('AUTOGRAPH') || text.includes('SIGNED') || 
      text.includes('SIGNATURE') || text.includes('CERTIFIED AUTOGRAPH')) {
    cardDetails.isAutographed = true;
    console.log('Detected autographed card');
  }
  
  // Numbered card detection (if we didn't already find a serial number)
  if (!cardDetails.isNumbered && 
      (text.includes('NUMBERED') || text.includes('LIMITED EDITION'))) {
    cardDetails.isNumbered = true;
    console.log('Detected numbered card (from keywords)');
  }
  
  // Variant detection
  const variants = [
    { keyword: 'REFRACTOR', name: 'Refractor' },
    { keyword: 'PARALLEL', name: 'Parallel' },
    { keyword: 'HOLOGRAM', name: 'Hologram' },
    { keyword: 'PRIZM', name: 'Prizm' },
    { keyword: 'FOIL', name: 'Foil' },
    { keyword: 'GOLD', name: 'Gold' },
    { keyword: 'SILVER', name: 'Silver' },
    { keyword: 'CHROME', name: 'Chrome' }
  ];
  
  for (const variant of variants) {
    if (text.includes(variant.keyword)) {
      cardDetails.variant = variant.name;
      console.log(`Detected variant: ${variant.name}`);
      break;
    }
  }
}