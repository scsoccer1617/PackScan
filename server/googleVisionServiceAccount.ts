import { ImageAnnotatorClient } from '@google-cloud/vision';
import { CardFormValues } from '../shared/schema';

// Initialize the client with service account credentials
let visionClient: ImageAnnotatorClient;

try {
  console.log('Initializing Vision API with service account credentials');
  
  // Get service account credentials from environment variables
  const credentials = {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  };
  
  console.log('Client email available:', !!credentials.client_email);
  console.log('Private key available:', !!credentials.private_key);
  
  // Create the client
  visionClient = new ImageAnnotatorClient({
    credentials,
  });
} catch (error) {
  console.error('Error initializing Vision API client:', error);
  // Create a dummy client that will fail gracefully
  visionClient = new ImageAnnotatorClient();
}

/**
 * Extract text from image using Google Cloud Vision API
 * @param base64Image Base64 encoded image
 * @returns Extracted text and detected text blocks
 */
export async function extractTextFromImage(base64Image: string): Promise<{
  fullText: string;
  textBlocks: { text: string; confidence: number }[];
}> {
  try {
    console.log('Sending request to Google Cloud Vision API with service account...');
    
    // Perform text detection on the image
    const [result] = await visionClient.textDetection({
      image: {
        content: Buffer.from(base64Image, 'base64')
      }
    });
    console.log('Received response from Google Cloud Vision API');

    // Get full text annotation
    const fullText = result.fullTextAnnotation?.text || '';
    console.log('Extracted full text:', fullText);
    
    // Get individual text annotations with confidence
    const textBlocks = result.textAnnotations?.slice(1).map(annotation => ({
      text: annotation.description || '',
      confidence: annotation.confidence || 0
    })) || [];
    console.log(`Found ${textBlocks.length} text blocks`);

    return {
      fullText,
      textBlocks
    };
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
    const { fullText, textBlocks } = await extractTextFromImage(base64Image);
    
    // Initialize result
    const result: Partial<CardFormValues> = {};
    
    if (!fullText) {
      return result;
    }
    
    // Convert to lowercase for easier pattern matching
    const lowerText = fullText.toLowerCase();

    // Extract sport
    const sportMapping = {
      'baseball': 'Baseball',
      'football': 'Football',
      'basketball': 'Basketball',
      'hockey': 'Hockey',
      'soccer': 'Soccer'
    };
    
    for (const [keyword, sportName] of Object.entries(sportMapping)) {
      if (lowerText.includes(keyword)) {
        result.sport = sportName;
        break;
      }
    }
    
    // Extract player name (this is complex, we'll look for patterns)
    // Looking for capitalized names that are likely to be player names
    const nameRegex = /([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))/g;
    // Use a different approach to avoid using matchAll
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
    
    // Extract brand
    const brandMapping = {
      'topps': 'Topps',
      'upper deck': 'Upper Deck',
      'panini': 'Panini',
      'fleer': 'Fleer',
      'donruss': 'Donruss',
      'bowman': 'Bowman'
    };
    
    for (const [keyword, brandName] of Object.entries(brandMapping)) {
      if (lowerText.includes(keyword)) {
        result.brand = brandName;
        break;
      }
    }

    // Extract collections
    const collections = [
      'Chrome', 'Prizm', 'Heritage', 'Optic', 'Finest', 
      'Select', 'Dynasty', 'Contenders', 'Clearly Authentic', 
      'Allen & Ginter', 'Tribute', 'Inception', 'Archives'
    ];
    
    for (const collection of collections) {
      if (fullText.includes(collection)) {
        result.collection = collection;
        break;
      }
    }

    // Extract card number (looking for patterns like "#123", "No. 123", "Card 123")
    const cardNumberRegex = /#\s*(\d+)|no\.\s*(\d+)|card\s*(\d+)/i;
    const cardNumberMatch = lowerText.match(cardNumberRegex);
    if (cardNumberMatch) {
      result.cardNumber = cardNumberMatch[1] || cardNumberMatch[2] || cardNumberMatch[3];
    }
    
    // Extract year (looking for 4-digit years from 1900-2025)
    const yearRegex = /\b(19\d{2}|20[0-2]\d)\b/;
    const yearMatch = fullText.match(yearRegex);
    if (yearMatch) {
      result.year = parseInt(yearMatch[1]);
    }
    
    // Extract variant (like "Refractor", "Holo", "Parallel", etc.)
    const variants = [
      'Refractor', 'Holo', 'Holographic', 'Foil', 'Gold', 'Silver', 
      'Parallel', 'Insert', 'Rookie', 'RC', 'Auto', 'Autograph', 
      'Numbered', 'Limited', 'Short Print', 'SP'
    ];
    
    for (const variant of variants) {
      if (fullText.includes(variant)) {
        result.variant = variant;
        break;
      }
    }
    
    // Extract serial number (like "123/499")
    const serialRegex = /(\d+)\s*\/\s*(\d+)/;
    const serialMatch = fullText.match(serialRegex);
    if (serialMatch) {
      result.serialNumber = serialMatch[0];
    }
    
    // Set a default condition (hard to determine from image)
    result.condition = 'PSA 8';
    
    // Post-processing to fill in blanks with reasonable defaults
    if (!result.year) {
      result.year = new Date().getFullYear();
    }
    
    return result;
  } catch (error: any) {
    console.error('Error analyzing sports card:', error);
    throw new Error(error.message || 'Unknown error analyzing sports card');
  }
}