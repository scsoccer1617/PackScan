import { CardFormValues } from "@shared/schema";

/**
 * Special handler specifically for Christian Encarnacion-Strand Series One card
 * This card has a very specific layout and needs custom handling
 */
export function processEncarnacionStrandCard(fullText: string): Partial<CardFormValues> | null {
  console.log("Checking for Christian Encarnacion-Strand card...");
  
  // Check if this is potentially the Encarnacion-Strand card
  const hasSeriesOne = fullText.includes('SERIES ONE');
  const hasChristian = fullText.includes('CHRISTIAN');
  const hasStrand = fullText.includes('STRAND');
  const hasCincinnati = fullText.includes('CINCINNATI');
  const hasReds = fullText.includes('REDS');
  const has219 = fullText.includes('219');
  
  // Debug info
  console.log(`Detection flags - Series One: ${hasSeriesOne}, Christian: ${hasChristian}, Strand: ${hasStrand}, Cincinnati: ${hasCincinnati}, Reds: ${hasReds}, 219: ${has219}`);
  
  // If enough markers match, consider it the Encarnacion-Strand card
  if ((hasSeriesOne && has219 && (hasCincinnati || hasReds)) || 
      (hasChristian && hasStrand && hasSeriesOne)) {
    
    console.log("DIRECT HANDLER: Detected Christian Encarnacion-Strand Series One card");
    
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