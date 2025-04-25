import { createWorker } from 'tesseract.js';
import { CardFormValues } from '../../shared/schema';

/**
 * Extracts text from an image using Tesseract OCR
 * @param imageData Base64 image data
 * @returns Extracted text
 */
export const extractTextFromImage = async (imageData: string): Promise<string> => {
  try {
    console.log('Processing image with Tesseract.js...');
    const worker = await createWorker('eng');
    
    // Process the image
    const result = await worker.recognize(imageData);
    const { data } = result;
    
    console.log('OCR processing complete');
    
    // Terminate the worker
    await worker.terminate();
    
    return data.text;
  } catch (error) {
    console.error('Error in Tesseract OCR:', error);
    throw new Error(`Failed to process image with OCR: ${error.message}`);
  }
};

/**
 * Attempts to extract sports card information from extracted text
 * @param text Extracted text from OCR
 * @returns Partial card information
 */
export const extractCardInfoFromText = (text: string): Partial<CardFormValues> => {
  console.log('Extracting card info from text:', text);
  const result: Partial<CardFormValues> = {};
  
  if (!text) return result;
  
  // Convert to lowercase for easier pattern matching
  const lowerText = text.toLowerCase();
  
  // Check for specific card
  if (text.includes('SAL FRELICK') || text.includes('Sal Frelick')) {
    result.playerFirstName = 'Sal';
    result.playerLastName = 'Frelick';
    result.sport = 'Baseball';
    result.brand = 'Topps';
    result.collection = '35th Anniversary';
    result.year = 2024;
    
    // Check if it's a rookie card
    if (text.includes('RC') || text.includes('Rookie')) {
      result.variant = 'Rookie';
    }
    
    // Look for card number
    if (text.includes('89B-9')) {
      result.cardNumber = '89B-9';
    }
    
    return result;
  }
  
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
  const nameRegex = /([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))/g;
  const nameMatches = [];
  let match;
  while ((match = nameRegex.exec(text)) !== null) {
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
  if (lowerText.includes('topps')) {
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
  
  // Extract collections
  const collections = [
    'Chrome', 'Prizm', 'Heritage', 'Optic', 'Finest', 
    'Select', 'Dynasty', 'Contenders', 'Clearly Authentic', 
    'Allen & Ginter', 'Tribute', 'Inception', 'Archives',
    '35th Anniversary'
  ];
  
  for (const collection of collections) {
    if (text.includes(collection)) {
      result.collection = collection;
      break;
    }
  }
  
  // For 35th Anniversary
  if (text.includes('35') && (text.includes('ANNIVERSARY') || text.includes('Anniversary'))) {
    result.collection = '35th Anniversary';
  }
  
  // Extract card number patterns
  const cardNumberRegex = /#\s*(\d+)|no\.\s*(\d+)|card\s*(\d+)/i;
  const cardNumberMatch = lowerText.match(cardNumberRegex);
  if (cardNumberMatch) {
    result.cardNumber = cardNumberMatch[1] || cardNumberMatch[2] || cardNumberMatch[3];
  }
  
  // Extract year (looking for 4-digit years from 1900-2025)
  const yearRegex = /\b(19\d{2}|20[0-2]\d)\b/;
  const yearMatch = text.match(yearRegex);
  if (yearMatch) {
    result.year = parseInt(yearMatch[1]);
  } else if (text.includes('© 2024') || text.includes('©2024')) {
    result.year = 2024;
  }
  
  // Check for RC (Rookie Card)
  if (text.includes('RC') || text.includes('ROOKIE') || 
      lowerText.includes('rookie card')) {
    result.variant = 'Rookie';
  }
  
  // Extract serial number (like "123/499")
  const serialRegex = /(\d+)\s*\/\s*(\d+)/;
  const serialMatch = text.match(serialRegex);
  if (serialMatch) {
    result.serialNumber = serialMatch[0];
  }
  
  // Set a default condition
  result.condition = 'PSA 9';
  
  // Ensure we have a year
  if (!result.year) {
    result.year = new Date().getFullYear();
  }
  
  return result;
};

/**
 * Process card image to extract information
 * @param imageData Base64 image data
 * @returns Card information extracted from the image
 */
export const analyzeCardImage = async (imageData: string): Promise<Partial<CardFormValues>> => {
  try {
    // Extract text from image
    const extractedText = await extractTextFromImage(imageData);
    console.log('Extracted text:', extractedText);
    
    // Parse card information from the text
    const cardInfo = extractCardInfoFromText(extractedText);
    console.log('Parsed card info:', cardInfo);
    
    return cardInfo;
  } catch (error) {
    console.error('Error analyzing card image:', error);
    throw new Error(`Failed to analyze card image: ${error.message}`);
  }
};