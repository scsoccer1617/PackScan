import { createWorker } from 'tesseract.js';
import { CardFormValues } from '@shared/schema';

// Load Tesseract worker with English language
const loadWorker = async () => {
  const worker = await createWorker('eng');
  return worker;
};

/**
 * Extracts text from an image using Tesseract OCR
 * @param imageData Base64 image data
 * @returns Extracted text
 */
export const extractTextFromImage = async (imageData: string): Promise<string> => {
  const worker = await loadWorker();
  
  try {
    const { data: { text } } = await worker.recognize(imageData);
    await worker.terminate();
    return text;
  } catch (error) {
    console.error('Error in OCR processing:', error);
    await worker.terminate();
    throw new Error('Failed to extract text from image');
  }
};

/**
 * Attempts to extract sports card information from extracted text
 * @param text Extracted text from OCR
 * @returns Partial card information
 */
export const extractCardInfoFromText = (text: string): Partial<CardFormValues> => {
  const result: Partial<CardFormValues> = {};
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  
  // Extract sport
  const sportKeywords = {
    'baseball': 'Baseball',
    'football': 'Football',
    'basketball': 'Basketball',
    'hockey': 'Hockey',
    'soccer': 'Soccer'
  };
  
  for (const [keyword, sport] of Object.entries(sportKeywords)) {
    if (text.toLowerCase().includes(keyword)) {
      result.sport = sport;
      break;
    }
  }
  
  // Extract player name (this is complex, but we'll try a simple approach)
  // Names are often prominent on cards, so we'll look for capitalized words
  const potentialNames = lines
    .filter(line => /^[A-Z][a-z]+ [A-Z][a-z]+/.test(line))
    .slice(0, 2); // Take first few matches as potential names
  
  if (potentialNames.length > 0) {
    const nameParts = potentialNames[0].trim().split(' ');
    if (nameParts.length >= 2) {
      result.playerFirstName = nameParts[0];
      result.playerLastName = nameParts.slice(1).join(' ');
    }
  }
  
  // Extract card number (look for # or No. followed by digits)
  const cardNumberMatch = text.match(/#\s*(\d+)|No\.\s*(\d+)|Card\s*(\d+)/i);
  if (cardNumberMatch) {
    result.cardNumber = cardNumberMatch[1] || cardNumberMatch[2] || cardNumberMatch[3];
  }
  
  // Extract year (4 digit number between 1900-2025)
  const yearMatch = text.match(/\b(19\d{2}|20[0-2]\d)\b/);
  if (yearMatch) {
    result.year = parseInt(yearMatch[1]);
  } else {
    result.year = new Date().getFullYear(); // Default to current year
  }
  
  // Extract brand
  const brandKeywords = {
    'topps': 'Topps',
    'upper deck': 'Upper Deck',
    'panini': 'Panini',
    'fleer': 'Fleer',
    'donruss': 'Donruss',
    'bowman': 'Bowman'
  };
  
  for (const [keyword, brand] of Object.entries(brandKeywords)) {
    if (text.toLowerCase().includes(keyword)) {
      result.brand = brand;
      break;
    }
  }
  
  // Extract serial number (look for ###/### format)
  const serialMatch = text.match(/(\d+)\s*\/\s*(\d+)/);
  if (serialMatch) {
    result.serialNumber = serialMatch[0];
  }
  
  // Extract collection
  // This is difficult without specific knowledge of collections, but we can try to identify some common ones
  const collections = [
    'Chrome', 'Prizm', 'Series One', 'Series Two', 'Heritage',
    'Optic', 'Finest', 'Select', 'Dynasty', 'Contenders'
  ];
  
  for (const collection of collections) {
    if (text.includes(collection)) {
      result.collection = collection;
      break;
    }
  }
  
  // Set a default condition (since it's hard to determine from the image)
  result.condition = 'PSA 9';
  
  return result;
};

/**
 * Process card image to extract information
 * @param imageData Base64 image data
 * @returns Card information extracted from the image
 */
export const analyzeCardImage = async (imageData: string): Promise<Partial<CardFormValues>> => {
  try {
    const extractedText = await extractTextFromImage(imageData);
    const cardInfo = extractCardInfoFromText(extractedText);
    
    // Return extracted data with default values for missing fields
    return {
      sport: cardInfo.sport || '',
      playerFirstName: cardInfo.playerFirstName || '',
      playerLastName: cardInfo.playerLastName || '',
      brand: cardInfo.brand || '',
      collection: cardInfo.collection || '',
      cardNumber: cardInfo.cardNumber || '',
      year: cardInfo.year || new Date().getFullYear(),
      variant: cardInfo.variant || '',
      serialNumber: cardInfo.serialNumber || '',
      condition: cardInfo.condition || 'PSA 9',
    };
  } catch (error) {
    console.error('Error analyzing card image:', error);
    throw error;
  }
};