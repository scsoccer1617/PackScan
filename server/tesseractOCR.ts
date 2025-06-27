import Tesseract from 'tesseract.js';
import { CardFormValues } from '../shared/schema';

/**
 * Extract text from image using Tesseract.js as fallback OCR
 */
export async function extractTextWithTesseract(imageBuffer: Buffer): Promise<{ fullText: string; textAnnotations: any[] }> {
  try {
    console.log('Using Tesseract.js OCR as fallback');
    
    const { data } = await Tesseract.recognize(imageBuffer, 'eng', {
      logger: m => console.log(m)
    });
    
    const fullText = data.text || '';
    
    // Convert Tesseract words to Google Vision-like format
    const textAnnotations = (data as any).words?.map((word: any) => ({
      description: word.text,
      boundingPoly: {
        vertices: [
          { x: word.bbox.x0, y: word.bbox.y0 },
          { x: word.bbox.x1, y: word.bbox.y0 },
          { x: word.bbox.x1, y: word.bbox.y1 },
          { x: word.bbox.x0, y: word.bbox.y1 }
        ]
      }
    })) || [];
    
    console.log(`Tesseract extracted ${textAnnotations.length} text annotations`);
    
    return { fullText, textAnnotations };
  } catch (error: any) {
    console.error('Error in Tesseract OCR:', error);
    throw new Error(`Failed to analyze image with Tesseract: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Analyze sports card using Tesseract OCR
 */
export async function analyzeSportsCardWithTesseract(imageBuffer: Buffer): Promise<Partial<CardFormValues>> {
  try {
    const { fullText, textAnnotations } = await extractTextWithTesseract(imageBuffer);
    
    // Basic card analysis from OCR text
    const cardDetails: Partial<CardFormValues> = {
      condition: 'PSA 8',
      sport: 'Baseball',
      brand: 'Topps',
      year: new Date().getFullYear()
    };
    
    // Extract player name (look for capitalized words that might be names)
    const text = fullText.toUpperCase();
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    
    // Look for common card patterns
    for (const line of lines) {
      // Player name detection (capitalized words)
      if (line.match(/^[A-Z][A-Z\s]+[A-Z]$/) && line.length > 3 && line.length < 30) {
        if (!line.includes('TOPPS') && !line.includes('SERIES') && !line.includes('MLB')) {
          const names = formatName(line).split(' ');
          cardDetails.playerFirstName = names[0] || '';
          cardDetails.playerLastName = names.slice(1).join(' ') || '';
          break;
        }
      }
    }
    
    // Extract card number
    const cardNumMatch = text.match(/(?:NO\.?\s*|#)(\d+)/i);
    if (cardNumMatch) {
      cardDetails.cardNumber = cardNumMatch[1];
    }
    
    // Extract year
    const yearMatch = text.match(/\b(19\d{2}|20\d{2})\b/);
    if (yearMatch) {
      cardDetails.year = parseInt(yearMatch[1]);
    }
    
    // Detect brand
    if (text.includes('TOPPS')) {
      cardDetails.brand = 'Topps';
    } else if (text.includes('UPPER DECK')) {
      cardDetails.brand = 'Upper Deck';
    } else if (text.includes('PANINI')) {
      cardDetails.brand = 'Panini';
    }
    
    // Detect rookie card
    if (text.includes('RC') || text.includes('ROOKIE')) {
      cardDetails.isRookieCard = true;
    }
    
    console.log('Tesseract analysis result:', cardDetails);
    
    return cardDetails;
  } catch (error: any) {
    console.error('Error analyzing card with Tesseract:', error);
    return {
      condition: 'PSA 8',
      sport: 'Baseball',
      brand: 'Topps',
      year: new Date().getFullYear()
    };
  }
}

/**
 * Format a name with proper capitalization
 */
function formatName(name: string): string {
  return name
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}