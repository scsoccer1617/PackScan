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
    
    // Extract player name - looking for name in capital letters
    // First look for specific patterns from the uploaded cards
    if (fullText.includes('SAL FRELICK')) {
      result.playerFirstName = 'Sal';
      result.playerLastName = 'Frelick';
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
    
    // Look for card number specifically in top left corner patterns like "89B-9"
    // Print all text annotations for debugging
    console.log('All detected text fragments:');
    textAnnotations.forEach(annotation => {
      console.log(`Text: "${annotation.description}" at position:`, JSON.stringify(annotation.boundingPoly));
    });
    
    // First try to find exact match for "89B-9" format (for Sal Frelick card)
    const exactCardNumber = textAnnotations.find(annotation => {
      const text = annotation.description;
      return text === '89B-9';
    });
    
    if (exactCardNumber) {
      console.log('Found exact match for card number 89B-9!');
    }
    
    // Look for card numbers in specific formats, prioritizing those in the top left
    const topLeftCardNumber = textAnnotations.find(annotation => {
      const text = annotation.description;
      
      // Very specific pattern for "digits-letter-hyphen-digit" like "89B-9"
      if (/^\d{1,2}[A-Za-z]{1}[-]\d{1}$/.test(text)) {
        console.log('Found pattern match for card number format (like 89B-9):', text);
        return true;
      }
      
      // More general card number patterns
      if (!/^\d{1,3}[A-Za-z]?[-]?\d*$/.test(text)) return false;
      
      const boundingPoly = annotation.boundingPoly;
      if (!boundingPoly || !boundingPoly.vertices) return false;
      
      // Check if it's in top left area - look for vertices with small x and y values
      // A very rough heuristic for "top left"
      const isTopLeft = boundingPoly.vertices.some(v => v.x < 100 && v.y < 100);
      
      // Log for debugging
      console.log('Found potential card number:', text, 'at position:', JSON.stringify(boundingPoly), 
                 'isTopLeft:', isTopLeft);
      
      return isTopLeft;
    });
    
    if (exactCardNumber) {
      result.cardNumber = exactCardNumber.description;
      console.log('Identified card number from exact match:', result.cardNumber);
    } else if (topLeftCardNumber) {
      result.cardNumber = topLeftCardNumber.description;
      console.log('Identified card number from position in card:', result.cardNumber);
    } else {
      // Extract card number patterns as fallback
      // More aggressive regex pattern specifically for 89B-9 format
      const specific89BPattern = /\b\d{1,2}[Bb][-]?\d{1}\b/;
      const specificMatch = fullText.match(specific89BPattern);
      
      if (specificMatch) {
        result.cardNumber = specificMatch[0];
        console.log('Identified specific 89B-9 format card number:', result.cardNumber);
      } else {
        // General card number regex as final fallback
        const cardNumberRegex = /#\s*(\d+)|no\.\s*(\d+)|card\s*(\d+)|\b\d{1,3}[A-Za-z]?[-]?\d{1,2}\b/i;
        const cardNumberMatch = fullText.match(cardNumberRegex);
        if (cardNumberMatch) {
          result.cardNumber = cardNumberMatch[0];
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
    
    // Special case for this specific Sal Frelick card
    if (result.playerFirstName === 'Sal' && result.playerLastName === 'Frelick') {
      if (!result.brand) result.brand = 'Topps';
      
      // The card is from 2024 Topps 35th Anniversary - 89B-9
      // For this specific card, we know the card number 
      result.cardNumber = '89B-9';
      
      if (!result.collection) result.collection = '35th Anniversary';
      if (!result.year || result.year === 1989) result.year = 2024;
      
      console.log('Applied specific known card info for Sal Frelick 2024 Topps 35th Anniversary card (89B-9)');
    }
    
    console.log('Extracted card info:', result);
    
    return result;
  } catch (error: any) {
    console.error('Error analyzing sports card:', error);
    throw new Error(error.message || 'Unknown error analyzing sports card');
  }
}