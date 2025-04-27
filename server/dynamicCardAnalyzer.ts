import { CardFormValues } from '../shared/schema';

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
export async function extractTextFromImage(base64Image: string): Promise<OCRResult> {
  try {
    // Google Cloud Vision API endpoint
    const apiUrl = 'https://vision.googleapis.com/v1/images:annotate';
    const apiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
    
    if (!apiKey) {
      console.error('Missing Google Cloud Vision API key');
      throw new Error('Google Cloud Vision API key is not configured');
    }
    
    // Prepare the request body for text detection
    const requestBody = {
      requests: [
        {
          image: {
            content: base64Image
          },
          features: [
            {
              type: 'TEXT_DETECTION',
              maxResults: 100
            }
          ]
        }
      ]
    };
    
    // Make the API request
    const response = await fetch(`${apiUrl}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google Cloud Vision API error: ${response.status} ${errorText}`);
    }
    
    const data = await response.json();
    
    // Check if we have any text annotations
    if (!data.responses || 
        !data.responses[0] || 
        !data.responses[0].textAnnotations || 
        data.responses[0].textAnnotations.length === 0) {
      return { fullText: '', textAnnotations: [] };
    }
    
    // The first annotation contains the full text, and the rest are individual words/elements
    const fullText = data.responses[0].textAnnotations[0].description;
    const textAnnotations = data.responses[0].textAnnotations.slice(1);
    
    return { fullText, textAnnotations };
  } catch (error) {
    console.error('Error in text extraction:', error);
    throw error;
  }
}

/**
 * Analyze a sports card image to extract relevant information dynamically without player-specific handlers
 * @param base64Image Base64 encoded image data
 * @returns Object with extracted card information
 */
export async function analyzeSportsCardImage(base64Image: string): Promise<Partial<CardFormValues>> {
  try {
    // Extract text from the image
    const { fullText, textAnnotations } = await extractTextFromImage(base64Image);
    
    // Convert to lowercase for case-insensitive matching
    const lowerText = fullText.toLowerCase();
    
    console.log('OCR full text:\n', fullText);
    
    // Initialize empty result with default values
    const result: Partial<CardFormValues> = {
      sport: 'Baseball',  // Default to baseball
      condition: 'PSA 8'  // Default condition
    };
    
    // STEP 1: PLAYER NAME DETECTION
    // ===========================
    // We'll use multiple patterns to detect player names without hardcoding
    
    // Patterns for player name detection
    const namePatterns = [
      // Format: "LAST, FIRST"
      { regex: /([A-Z][A-Za-z]+),\s*([A-Z][A-Za-z]+)/, firstIndex: 2, lastIndex: 1 },
      
      // Format: "FIRST LAST" (all caps)
      { regex: /([A-Z]{2,})\s+([A-Z]{2,})/, firstIndex: 1, lastIndex: 2 },
      
      // Format: "First Last" (mixed case)
      { regex: /([A-Z][a-z]+)\s+([A-Z][a-z]+)/, firstIndex: 1, lastIndex: 2 }
    ];
    
    // Words that should be excluded from player name detection
    const excludedWords = ['TOPPS', 'BASEBALL', 'MAJOR', 'LEAGUE', 'STARS', 'MLB', 
                          'CHROME', 'SERIES', 'HERITAGE', 'OPENING', 'BOWMAN', 'PANINI',
                          'DONRUSS', 'CARD', 'DAY'];
    
    // Try each pattern on the full text first
    let playerFound = false;
    for (const pattern of namePatterns) {
      const nameMatch = fullText.match(pattern.regex);
      if (nameMatch) {
        // Check if potential name isn't a false positive
        const firstName = nameMatch[pattern.firstIndex];
        const lastName = nameMatch[pattern.lastIndex];
        
        if (!excludedWords.includes(firstName.toUpperCase()) && 
            !excludedWords.includes(lastName.toUpperCase())) {
          // This looks like a real player name
          result.playerFirstName = firstName;
          result.playerLastName = lastName;
          console.log(`Detected player name: ${firstName} ${lastName} using pattern`);
          playerFound = true;
          break;
        }
      }
    }
    
    // If player name not found with patterns, try to find first/last names in separate pieces
    if (!playerFound) {
      // Extract potential first and last names from individual annotations
      // These need to look like proper names: start with capital letter, not be too short or excluded terms
      const potentialNames = textAnnotations
        .map(a => a.description.trim())
        .filter(text => 
          // Must start with capital letter, followed by lowercase
          /^[A-Z][a-z]+$/.test(text) && 
          // Not too short, not excluded word
          text.length > 2 && 
          !excludedWords.includes(text.toUpperCase())
        );
      
      // If we found at least 2 potential name parts
      if (potentialNames.length >= 2) {
        // Take the first two potential names as first/last
        result.playerFirstName = potentialNames[0];
        result.playerLastName = potentialNames[1];
        console.log(`Detected likely player name from separate text blocks: ${result.playerFirstName} ${result.playerLastName}`);
        playerFound = true;
      }
    }
    
    // STEP 2: BRAND DETECTION
    // ======================
    // Common card brands
    const commonBrands = ['Topps', 'Upper Deck', 'Bowman', 'Fleer', 'Panini', 'Donruss'];
    
    // Check for each brand in the text
    for (const brand of commonBrands) {
      if (fullText.includes(brand) || lowerText.includes(brand.toLowerCase())) {
        result.brand = brand;
        console.log(`Detected card brand: ${brand}`);
        break;
      }
    }
    
    // OCR often misreads "Topps" as "Lapps", correct that
    if (fullText.includes('Lapps') || lowerText.includes('lapps')) {
      result.brand = 'Topps';
      console.log('Corrected misread "Lapps" to "Topps"');
    }
    
    // STEP 3: COLLECTION DETECTION
    // ==========================
    // Function to detect collection based on text and other indicators
    const detectCollection = () => {
      // If we're already confident in a collection, return early
      if (result.collection) return;
      
      // Special collection detection for specific patterns
      
      // 1. Check for "Chrome Stars of MLB" (identifiable by CSMLB-XX card numbers)
      if (fullText.match(/CSMLB-?\d+/i) || 
          (fullText.toLowerCase().includes('chrome') && fullText.includes('STARS') && fullText.includes('MLB'))) {
        result.collection = 'Chrome Stars of MLB';
        result.brand = 'Topps';
        console.log('Detected collection: Chrome Stars of MLB');
        return;
      }
      
      // 2. Check for "Stars of MLB" (identifiable by SMLB-XX card numbers)
      if (fullText.match(/SMLB-?\d+/i) || 
          (fullText.includes('STARS') && fullText.includes('MLB') && !fullText.toLowerCase().includes('chrome'))) {
        result.collection = 'Stars of MLB';
        result.brand = 'Topps';
        console.log('Detected collection: Stars of MLB');
        return;
      }
      
      // 3. Check for "35th Anniversary" (identifiable by 89B-XX card numbers or text)
      if (fullText.match(/89B-?\d+/i) || fullText.match(/\d+-?89B/i) || 
          (fullText.includes('35') && 
           (fullText.includes('ANNIVERSARY') || fullText.includes('ANNIV') || fullText.includes('RSARY')))) {
        result.collection = '35th Anniversary';
        result.brand = 'Topps';
        result.year = 2024; // 35th Anniversary cards are from 2024
        console.log('Detected collection: 35th Anniversary');
        return;
      }
      
      // 4. Check for "Heritage" collection
      if (fullText.includes('HERITAGE') || lowerText.includes('heritage')) {
        result.collection = 'Heritage';
        console.log('Detected collection: Heritage');
        return;
      }
      
      // 5. Check for "Series One/Two" collections
      if (fullText.includes('SERIES 1') || fullText.includes('SERIES ONE') || 
          lowerText.includes('series 1') || lowerText.includes('series one')) {
        result.collection = 'Series One';
        console.log('Detected collection: Series One');
        return;
      }
      
      if (fullText.includes('SERIES 2') || fullText.includes('SERIES TWO') || 
          lowerText.includes('series 2') || lowerText.includes('series two')) {
        result.collection = 'Series Two';
        console.log('Detected collection: Series Two');
        return;
      }
      
      // 6. Check for "Opening Day" collection
      if (fullText.includes('OPENING DAY') || lowerText.includes('opening day')) {
        result.collection = 'Opening Day';
        console.log('Detected collection: Opening Day');
        return;
      }
      
      // 7. Check for "Stadium Club" collection
      if (fullText.includes('STADIUM CLUB') || lowerText.includes('stadium club')) {
        result.collection = 'Stadium Club';
        console.log('Detected collection: Stadium Club');
        return;
      }
    };
    
    // STEP 4: CARD NUMBER DETECTION
    // ===========================
    // Card numbers can be in various formats:
    // - Simple numbers like "27"
    // - Card series formats like "CSMLB-44", "SMLB-27", "89B-32"
    
    // Try to detect special format card numbers first
    // These often indicate the collection as well
    
    // Check for Chrome Stars of MLB (CSMLB-XX) format
    const csmlbMatch = fullText.match(/CSMLB[-\s]?(\d+)/i);
    if (csmlbMatch) {
      result.cardNumber = `CSMLB-${csmlbMatch[1]}`;
      result.collection = 'Chrome Stars of MLB';
      result.brand = 'Topps';
      result.year = 2024; // CSMLB cards are from 2024
      console.log(`Detected Chrome Stars of MLB card number: ${result.cardNumber}`);
    }
    // Stars of MLB (SMLB-XX) format
    else {
      const smlbMatch = fullText.match(/SMLB[-\s]?(\d+)/i);
      if (smlbMatch) {
        result.cardNumber = `SMLB-${smlbMatch[1]}`;
        result.collection = 'Stars of MLB';
        result.brand = 'Topps';
        result.year = 2024; // SMLB cards are from 2024
        console.log(`Detected Stars of MLB card number: ${result.cardNumber}`);
      }
      // 35th Anniversary (89B-XX) format
      else {
        const b89Match = fullText.match(/89B[-\s]?(\d+)/i) || fullText.match(/(\d+)[-\s]?89B/i);
        if (b89Match) {
          // Extract the number part, handling both "89B-32" and "32-89B" formats
          const numberPart = b89Match[1] ? b89Match[1] : b89Match[2];
          result.cardNumber = `89B-${numberPart}`;
          result.collection = '35th Anniversary';
          result.brand = 'Topps';
          result.year = 2024; // 89B cards are from 2024
          console.log(`Detected 35th Anniversary card number: ${result.cardNumber}`);
        }
        // If no special format, look for simple numeric card numbers
        else {
          // Simple numeric format (typically found at top of card)
          const topAnnotations = textAnnotations.filter(annotation => {
            const boundingPoly = annotation.boundingPoly;
            if (!boundingPoly || !boundingPoly.vertices) return false;
            
            // Get the vertical position (top 25% of card)
            const yCoords = boundingPoly.vertices.map((v: any) => v.y);
            const avgY = yCoords.reduce((a: number, b: number) => a + b, 0) / yCoords.length;
            
            return avgY < 800; // Top portion of card
          });
          
          // Look for simple numbers at top of card
          for (const annotation of topAnnotations) {
            const text = annotation.description;
            // Simple numeric card number (1-3 digits)
            if (/^\d{1,3}$/.test(text)) {
              result.cardNumber = text;
              console.log(`Detected simple numeric card number at top of card: ${text}`);
              break;
            }
          }
        }
      }
    }
    
    // If we still don't have a card number, look for other formats throughout the card
    if (!result.cardNumber) {
      // Card number may be prefixed with "No." or "#"
      const numberMatch = fullText.match(/No\.?\s*(\d+)/i) || fullText.match(/#\s*(\d+)/i);
      if (numberMatch) {
        result.cardNumber = numberMatch[1];
        console.log(`Detected card number from No./# prefix: ${result.cardNumber}`);
      }
    }
    
    // Run collection detection
    detectCollection();
    
    // STEP 5: YEAR DETECTION
    // ====================
    // Years often appear in copyright text at bottom of card
    
    // First identify all text annotations that are likely at the bottom portion of the card
    const bottomAnnotations = textAnnotations.filter(annotation => {
      const boundingPoly = annotation.boundingPoly;
      if (!boundingPoly || !boundingPoly.vertices) return false;
      
      // Get the vertical position (y-coordinate) to identify bottom section
      const yCoords = boundingPoly.vertices.map((v: any) => v.y);
      const avgY = yCoords.reduce((a: number, b: number) => a + b, 0) / yCoords.length;
      
      // Bottom 25% of card
      return avgY > 1200;
    });
    
    console.log(`Found ${bottomAnnotations.length} text annotations in the bottom section of the card`);
    
    // Look for years with nearby trademark/copyright symbols
    const yearCandidates: {year: number, confidence: number, source: string}[] = [];
    
    // Check each annotation in the bottom section
    bottomAnnotations.forEach(annotation => {
      const text = annotation.description;
      
      // Log for debugging
      console.log(`Bottom text: "${text}" at position:`, JSON.stringify(annotation.boundingPoly));
      
      // Look for trademark/copyright symbols near years
      const hasTrademarkSymbol = text.includes('®') || 
                                text.includes('©') || 
                                text.includes('™') ||
                                text.includes('(R)') ||
                                text.includes('(TM)') ||
                                text.includes('(C)');
      
      // Different patterns for years
      const yearPatterns = [
        { regex: /\b(20\d{2})\b/, confidence: 0.9, type: '20XX' },     // 2023, 2024
        { regex: /\b(19\d{2})\b/, confidence: 0.9, type: '19XX' },     // 1993, 1994
        { regex: /[''](\d{2})/, confidence: 0.7, type: "'YY" },        // '23, '24
        { regex: /\b\d{4}\b/, confidence: 0.6, type: 'XXXX' }          // Any 4 digits as fallback
      ];
      
      // If we have a trademark symbol, look for years
      if (hasTrademarkSymbol) {
        for (const pattern of yearPatterns) {
          const yearMatch = text.match(pattern.regex);
          if (yearMatch) {
            let year = parseInt(yearMatch[1]);
            
            // Handle 2-digit years
            if (year < 100) {
              // Assume 00-25 is 2000-2025, and everything else is 1900s
              year = year <= 25 ? 2000 + year : 1900 + year;
            }
            
            // Only accept reasonable years (1900-2025)
            if (year >= 1900 && year <= 2025) {
              yearCandidates.push({
                year,
                confidence: pattern.confidence,
                source: `${text} (${pattern.type})`
              });
              
              console.log(`Found potential card year: ${year} from text "${text}" with pattern ${pattern.type}`);
              break;  // Once we find a match in this annotation, move to next
            }
          }
        }
      }
    });
    
    // Sort candidates by confidence (highest first)
    yearCandidates.sort((a, b) => b.confidence - a.confidence);
    
    // Use the highest confidence year if available
    if (yearCandidates.length > 0) {
      const bestYearCandidate = yearCandidates[0];
      result.year = bestYearCandidate.year;
      console.log(`Selected card year: ${result.year} from "${bestYearCandidate.source}" with confidence ${bestYearCandidate.confidence}`);
    }
    // Fallback to general detection if no trademark years found
    else {
      // Extract any year (looking for 4-digit years from 1900-2025)
      const yearRegex = /\b(19\d{2}|20[0-2]\d)\b/;
      const yearMatch = fullText.match(yearRegex);
      if (yearMatch) {
        result.year = parseInt(yearMatch[1]);
        console.log('Identified year from general text:', result.year);
      } else {
        // Default to current year if no year found
        result.year = new Date().getFullYear();
        console.log(`No year detected, defaulting to current year: ${result.year}`);
      }
    }
    
    // STEP 6: SERIAL NUMBER DETECTION
    // =============================
    // Serial numbers typically have format "123/999" and are at bottom of card
    
    const serialNumberMatch = bottomAnnotations.find(annotation => {
      const text = annotation.description;
      // Match format like "123/999"
      return /^\d{1,3}\/\d{1,4}$/.test(text);
    });
    
    if (serialNumberMatch) {
      result.serialNumber = serialNumberMatch.description;
      result.isNumbered = true;
      console.log(`Detected serial number: ${result.serialNumber}`);
    }
    
    // STEP 7: CONTEXT-BASED CORRECTIONS
    // ===============================
    
    // Collection-specific corrections
    if (result.collection === '35th Anniversary') {
      // 35th Anniversary cards are from 2024
      result.year = 2024;
      result.brand = 'Topps';
    }
    else if (result.collection === 'Chrome Stars of MLB' || result.collection === 'Stars of MLB') {
      // These are 2024 Topps collections
      result.year = 2024;
      result.brand = 'Topps';
    }
    
    // Card number corrections based on context
    if (result.cardNumber && result.cardNumber.includes('CSMLB')) {
      // Ensure Chrome Stars of MLB collection for CSMLB card numbers
      result.collection = 'Chrome Stars of MLB';
    }
    else if (result.cardNumber && result.cardNumber.includes('SMLB')) {
      // Ensure Stars of MLB collection for SMLB card numbers
      result.collection = 'Stars of MLB';
    }
    else if (result.cardNumber && result.cardNumber.includes('89B')) {
      // Ensure 35th Anniversary collection for 89B card numbers
      result.collection = '35th Anniversary';
    }
    
    // Fix common OCR errors in player names
    if (result.playerFirstName === 'Major' && result.playerLastName === 'League') {
      result.playerFirstName = '';
      result.playerLastName = '';
      console.log('Cleared incorrect "Major League" player name detection');
    }
    
    console.log('Final extracted card info:', result);
    return result;
    
  } catch (error: any) {
    console.error('Error analyzing sports card:', error);
    throw new Error(error.message || 'Unknown error analyzing sports card');
  }
}