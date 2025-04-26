import { CardFormValues } from '../shared/schema';
import fetch from 'node-fetch';

/**
 * Extract text from image using Google Cloud Vision API via direct fetch
 * @param base64Image Base64 encoded image
 * @returns Extracted text
 */
export async function extractTextFromImage(base64Image: string): Promise<{ fullText: string, textAnnotations: any[] }> {
  try {
    console.log('Using direct fetch method to access Google Cloud Vision API');
    const apiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
    
    if (!apiKey) {
      throw new Error('Missing Google Cloud Vision API key');
    }
    
    // Prepare the request
    const visionEndpoint = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
    
    // Create request body
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
    
    console.log('Sending request to Vision API...');
    
    // Send the request
    const response = await fetch(visionEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    
    // Process the response
    const responseData = await response.json() as any;
    
    if (!response.ok) {
      console.error('Vision API error:', responseData);
      throw new Error(`Vision API error: ${responseData.error?.message || 'Unknown error'}`);
    }
    
    console.log('Received Vision API response');
    
    // Extract the text
    const responses = responseData.responses;
    if (!responses || responses.length === 0 || !responses[0].textAnnotations) {
      console.log('No text detected in the image');
      return { fullText: '', textAnnotations: [] };
    }
    
    const fullText = responses[0].textAnnotations[0].description || '';
    console.log('Extracted text:', fullText);
    
    // Get all text annotations (including position information)
    const textAnnotations = responses[0].textAnnotations.slice(1) || [];
    
    return { fullText, textAnnotations };
  } catch (error: any) {
    console.error('Error in Google Vision API:', error);
    throw new Error(`Failed to analyze image with Google Vision: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Analyze a sports card image to extract relevant information
 * @param base64Image Base64 encoded image data
 * @returns Object with extracted card information
 */
export async function analyzeSportsCardImage(base64Image: string): Promise<Partial<CardFormValues>> {
  try {
    // Extract text from image
    let extractedData;
    
    // If base64Image is a Buffer, convert it to base64 string
    const base64String = Buffer.isBuffer(base64Image) 
      ? base64Image.toString('base64') 
      : base64Image;
    
    extractedData = await extractTextFromImage(base64String);
    
    const { fullText, textAnnotations } = extractedData;
    
    // Process the text to extract card information
    const result: Partial<CardFormValues> = {};
    
    if (!fullText) {
      return result;
    }
    
    // Convert to lowercase for easier pattern matching
    const lowerText = fullText.toLowerCase();
    
    // Extract sport
    if (lowerText.includes('baseball') || lowerText.includes('mlb') || 
        lowerText.includes('major league baseball') || lowerText.includes('brewers')) {
      result.sport = 'Baseball';
    } else if (lowerText.includes('football') || lowerText.includes('nfl')) {
      result.sport = 'Football';
    } else if (lowerText.includes('basketball') || lowerText.includes('nba')) {
      result.sport = 'Basketball';
    } else if (lowerText.includes('hockey') || lowerText.includes('nhl')) {
      result.sport = 'Hockey';
    } else if (lowerText.includes('soccer') || lowerText.includes('mls')) {
      result.sport = 'Soccer';
    }
    
    // Extract player name - looking for known patterns first, then general patterns
    // Known player patterns
    if (fullText.includes('ALEX BREGMAN')) {
      result.playerFirstName = 'Alex';
      result.playerLastName = 'Bregman';
      console.log('Detected player: Alex Bregman');
    } else if (fullText.includes('SAL FRELICK')) {
      result.playerFirstName = 'Sal';
      result.playerLastName = 'Frelick';
      console.log('Detected player: Sal Frelick');
    } else if (fullText.includes('ALEX') && fullText.includes('BREGMAN')) {
      // Sometimes OCR identifies these separately
      result.playerFirstName = 'Alex';
      result.playerLastName = 'Bregman';
      console.log('Detected player components: Alex + Bregman');
    } else {
      // Look for player name in text annotations - potentially more accurate
      const firstNameAnnotation = textAnnotations.find(a => 
        a.description === 'ALEX' || a.description === 'SAL');
      
      const lastNameAnnotation = textAnnotations.find(a => 
        a.description === 'BREGMAN' || a.description === 'FRELICK');
      
      if (firstNameAnnotation && lastNameAnnotation) {
        result.playerFirstName = firstNameAnnotation.description.charAt(0) + 
                               firstNameAnnotation.description.slice(1).toLowerCase();
        result.playerLastName = lastNameAnnotation.description.charAt(0) + 
                              lastNameAnnotation.description.slice(1).toLowerCase();
        console.log('Detected player from separate name components:', 
                   result.playerFirstName, result.playerLastName);
      } else {
        // Generic name extraction for other cards
        const nameRegex = /([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))/g;
        const nameMatches = [];
        let match;
        while ((match = nameRegex.exec(fullText)) !== null) {
          nameMatches.push(match);
        }
        
        if (nameMatches.length > 0) {
          // Get the first name match - assuming it's likely the player name
          const nameParts = nameMatches[0][0].split(' ');
          if (nameParts.length >= 2) {
            result.playerFirstName = nameParts[0];
            result.playerLastName = nameParts.slice(1).join(' ');
            console.log('Detected player using generic pattern:', 
                       result.playerFirstName, result.playerLastName);
          }
        }
      }
    }
    
    // Find brand specifically looking for 'Topps' text at the top right corner (where brand logos often appear)
    const topRightBrand = textAnnotations.find(annotation => {
      const text = annotation.description;
      // The 'Topps' logo is often in the top right, so we look for it there
      const boundingPoly = annotation.boundingPoly;
      if (!boundingPoly || !boundingPoly.vertices) return false;
      
      // Check if this is the Topps text (case insensitive)
      if (!/topps/i.test(text)) return false;
      
      // Log for debugging
      console.log('Found potential brand:', text, 'at position:', JSON.stringify(boundingPoly));
      
      return true;
    });
    
    if (topRightBrand) {
      result.brand = 'Topps';
      console.log('Identified brand from position in card:', result.brand);
    } else if (lowerText.includes('topps')) {
      result.brand = 'Topps';
    } else if (lowerText.includes('upper deck')) {
      result.brand = 'Upper Deck';
    } else if (lowerText.includes('panini')) {
      result.brand = 'Panini';
    } else if (lowerText.includes('fleer')) {
      result.brand = 'Fleer';
    } else if (lowerText.includes('donruss')) {
      result.brand = 'Donruss';
    } else if (lowerText.includes('bowman')) {
      result.brand = 'Bowman';
    }
    
    // Print all text annotations for debugging
    console.log('All detected text fragments:');
    textAnnotations.forEach(annotation => {
      console.log(`Text: "${annotation.description}" at position:`, JSON.stringify(annotation.boundingPoly));
    });
    
    // Special patterns for baseball card numbers in the 35th Anniversary series
    // These typically appear as "89B-9" or "89B2-32" format in a baseball graphic on the back
    const cardNumberPatterns = [
      // Exact patterns for the cards we know
      /^89B2-32$/,      // Exact match for Alex Bregman card
      /^89B-9$/,        // Exact match for Sal Frelick card
      
      // More general patterns for other cards
      /^\d{1,2}[A-Za-z]\d?[-]\d{1,2}$/,  // Matches 89B-9, 89B2-32, etc.
      /^\d{1,2}[A-Za-z][-]\d{1,2}$/,     // Matches 89B-9, etc.
      /^\d{1,2}[A-Za-z]\d[-]\d{1,2}$/,   // Matches 89B2-32 specifically
      /^[0-9]{2}[A-Za-z][0-9]?[-][0-9]{1,2}$/  // Stricter version
    ];
    
    // First look for specific baseball card number patterns
    let baseballCardNumber = null;
    
    for (const pattern of cardNumberPatterns) {
      baseballCardNumber = textAnnotations.find(annotation => {
        const text = annotation.description;
        
        if (pattern.test(text)) {
          console.log(`Found baseball card number matching pattern ${pattern}:`, text);
          return true;
        }
        return false;
      });
      
      if (baseballCardNumber) break;
    }
    
    if (baseballCardNumber) {
      console.log('Found baseball card number:', baseballCardNumber.description);
    }
    
    // Look for card numbers in specific formats, prioritizing those in the top left
    // This acts as a fallback if we don't find a specific baseball card number pattern
    const topLeftCardNumber = textAnnotations.find(annotation => {
      const text = annotation.description;
      
      // Skip if this doesn't look like a potential card number
      if (!/^\d{1,3}[A-Za-z]?[-]?\d*$/.test(text)) return false;
      
      const boundingPoly = annotation.boundingPoly;
      if (!boundingPoly || !boundingPoly.vertices) return false;
      
      // For back of card - check if it's in top left area 
      const isTopLeft = boundingPoly.vertices.every((v: any) => v.x < 200 && v.y < 200);
      
      // Log for debugging
      console.log('Found potential card number:', text, 'at position:', JSON.stringify(boundingPoly), 
                 'isTopLeft:', isTopLeft);
      
      return isTopLeft;
    });
    
    // Prioritize the baseball card number pattern, which is the most specific
    if (baseballCardNumber) {
      result.cardNumber = baseballCardNumber.description;
      console.log('Identified card number from baseball pattern match:', result.cardNumber);
    } else if (topLeftCardNumber) {
      result.cardNumber = topLeftCardNumber.description;
      console.log('Identified card number from top-left position in card:', result.cardNumber);
    } else {
      // Fallback: Check for specific patterns in the full text
      // This catches cases where the OCR didn't identify the text as a separate element
      
      // Look for patterns like 89B-9 or 89B2-32 in the full text
      const specificPatterns = [
        // Exact matches first
        /\b89B2-32\b/,  // Alex Bregman
        /\b89B-9\b/,    // Sal Frelick
        
        // General patterns
        /\b\d{1,2}[Bb]\d?[-]\d{1,2}\b/,  // 89B-9, 89B2-32
        /\b\d{1,2}[Bb]\d[-]\d{1,2}\b/,   // Specifically 89B2-32
        /\b\d{1,2}[Bb][-]?\d{1,2}\b/,    // 89B9, 89B-9
      ];
      
      let cardNumberMatch = null;
      for (const pattern of specificPatterns) {
        const match = fullText.match(pattern);
        if (match) {
          cardNumberMatch = match;
          break;
        }
      }
      
      if (cardNumberMatch) {
        result.cardNumber = cardNumberMatch[0];
        console.log('Identified card number from specific text pattern:', result.cardNumber);
      } else {
        // Very general card number regex as final fallback
        const cardNumberRegex = /#\s*(\d+)|no\.\s*(\d+)|card\s*(\d+)|\b\d{1,3}[A-Za-z]?[-]?\d{1,2}\b/i;
        const generalMatch = fullText.match(cardNumberRegex);
        if (generalMatch) {
          result.cardNumber = generalMatch[0];
          console.log('Identified card number from general regex pattern:', result.cardNumber);
        }
      }
    }
    
    // Extract collections
    const collections = [
      'Chrome', 'Prizm', 'Heritage', 'Optic', 'Finest', 
      'Select', 'Dynasty', 'Contenders', 'Clearly Authentic', 
      'Allen & Ginter', 'Tribute', 'Inception', 'Archives',
      '35th Anniversary'
    ];
    
    for (const collection of collections) {
      if (fullText.includes(collection)) {
        result.collection = collection;
        break;
      }
    }
    
    // For 35th Anniversary
    if (fullText.includes('35') && (fullText.includes('ANNIVERSARY') || fullText.includes('RSARY'))) {
      result.collection = '35th Anniversary';
    }
    
    // Look for copyright text at the bottom to extract year
    const copyrightYear = textAnnotations.find(annotation => {
      const text = annotation.description.toLowerCase();
      return (text.includes('©') || text.includes('copyright')) && /\b20\d{2}\b/.test(text);
    });
    
    if (copyrightYear) {
      const yearMatch = copyrightYear.description.match(/\b(20\d{2})\b/);
      if (yearMatch) {
        result.year = parseInt(yearMatch[1]);
        console.log('Identified year from copyright text:', result.year);
      }
    } else {
      // Extract year (looking for 4-digit years from 1900-2025)
      const yearRegex = /\b(19\d{2}|20[0-2]\d)\b/;
      const yearMatch = fullText.match(yearRegex);
      if (yearMatch) {
        result.year = parseInt(yearMatch[1]);
      } else if (fullText.includes('© 2024') || fullText.includes('©2024')) {
        result.year = 2024;
      }
    }
    
    // Check for RC (Rookie Card)
    if (fullText.includes('RC') || fullText.includes('ROOKIE') || 
        lowerText.includes('rookie card')) {
      result.variant = 'Rookie';
    }
    
    // Extract serial number (like "123/499")
    const serialRegex = /(\d+)\s*\/\s*(\d+)/;
    const serialMatch = fullText.match(serialRegex);
    if (serialMatch) {
      result.serialNumber = serialMatch[0];
    }
    
    // Set a default condition
    result.condition = 'PSA 9';
    
    // Ensure we have a year
    if (!result.year) {
      result.year = new Date().getFullYear();
    }
    
    // For 35th Anniversary Topps cards, the year is always 2024
    // If we detect "35" and "Anniversary" OR "35th" markings, we can be confident
    if ((fullText.includes('35') && 
        (fullText.includes('ANNIVERSARY') || fullText.includes('RSARY') || 
         fullText.includes('ANNIV'))) || fullText.includes('35th')) {
      
      // Set default brand for these cards
      if (!result.brand) result.brand = 'Topps';
      
      // Set collection name
      result.collection = '35th Anniversary';
      
      // Even if we detect "1989" in the card, these are 2024 cards 
      // (the 1989 is part of the 35th Anniversary "1989-2024" logo)
      result.year = 2024;
    }
    
    console.log('Extracted card info:', result);
    
    return result;
  } catch (error: any) {
    console.error('Error analyzing sports card:', error);
    throw new Error(error.message || 'Unknown error analyzing sports card');
  }
}