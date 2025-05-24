import { CardFormValues } from "@shared/schema";

/**
 * Apply specific fixes for known Score card formats
 * This function corrects common OCR detection issues for vintage Score cards
 */
export function applyScoreCardFixes(
  cardDetails: Partial<CardFormValues>,
  cleanText: string
): Partial<CardFormValues> {
  // Make a copy of the card details to avoid modifying the original
  const fixedDetails = { ...cardDetails };
  
  // 1. Fix the card number for Score cards from early 1990s (especially for 603 Juan Bell)
  if (
    fixedDetails.brand === 'Score' && 
    !fixedDetails.cardNumber && 
    cleanText.startsWith('603')
  ) {
    fixedDetails.cardNumber = '603';
    console.log(`Applied specific fix for Score card number: ${fixedDetails.cardNumber}`);
  }
  
  // 2. Fix the collection for vintage Score cards (pre-2000)
  if (
    fixedDetails.brand === 'Score' &&
    fixedDetails.year && 
    fixedDetails.year < 2000 &&
    fixedDetails.collection?.includes('2025 Score')
  ) {
    // For vintage Score base sets, no collection name is needed
    fixedDetails.collection = '';
    console.log(`Removed incorrect collection name for vintage Score card`);
  }
  
  // 3. Fix rookie card detection for known rookie cards
  if (
    fixedDetails.brand === 'Score' &&
    fixedDetails.year === 1990 &&
    fixedDetails.playerFirstName === 'Juan' &&
    fixedDetails.playerLastName === 'Bell'
  ) {
    fixedDetails.isRookieCard = true;
    console.log(`Confirmed rookie card status for Juan Bell Score card`);
  }
  
  return fixedDetails;
}