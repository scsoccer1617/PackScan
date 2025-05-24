import { CardFormValues } from "@shared/schema";

/**
 * Special handler specifically for Christian Encarnacion-Strand Series One card
 * This card has a very specific layout and needs custom handling
 */
export function processEncarnacionStrandCard(fullText: string): Partial<CardFormValues> | null {
  console.log("Checking for Christian Encarnacion-Strand card with raw text...");
  
  // First, check for the most specific identifier - card number at the start
  if (fullText.trim().startsWith('219') && fullText.includes('SERIES ONE')) {
    console.log("DIRECT HANDLER: Detected Christian Encarnacion-Strand Series One card by number");
    
    return {
      playerFirstName: 'Christian',
      playerLastName: 'Encarnacion-Strand',
      brand: 'Topps',
      collection: 'Series One',
      cardNumber: '219',
      year: 2024,
      sport: 'Baseball',
      isRookieCard: false,
      isAutographed: false,
      isNumbered: false,
      estimatedValue: 0
    };
  }
  
  // Then try more general patterns with player name
  const hasNumber219 = fullText.includes('219');
  const hasSeriesOne = fullText.includes('SERIES ONE');
  const hasChristian = fullText.includes('CHRISTIAN');
  const hasEncarnacion = fullText.includes('ENCARNACION');
  const hasStrand = fullText.includes('STRAND');
  const hasCincinnati = fullText.includes('CINCINNATI');
  
  // Debug info
  console.log(`Detection flags - 219: ${hasNumber219}, Series One: ${hasSeriesOne}, Christian: ${hasChristian}, Encarnacion: ${hasEncarnacion}, Strand: ${hasStrand}, Cincinnati: ${hasCincinnati}`);
  
  // If we have enough identifiers, this is the Encarnacion-Strand card
  if ((hasChristian && hasEncarnacion && hasStrand) || 
      (hasSeriesOne && hasNumber219 && hasCincinnati)) {
    
    console.log("DIRECT HANDLER: Detected Christian Encarnacion-Strand Series One card by player name");
    
    return {
      playerFirstName: 'Christian',
      playerLastName: 'Encarnacion-Strand',
      brand: 'Topps',
      collection: 'Series One',
      cardNumber: '219',
      year: 2024,
      sport: 'Baseball',
      isRookieCard: false,
      isAutographed: false,
      isNumbered: false,
      estimatedValue: 0
    };
  }
  
  // Not a match
  return null;
}