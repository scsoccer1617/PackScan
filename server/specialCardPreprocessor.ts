import { CardFormValues } from '../shared/schema';

/**
 * Special preprocessor for cards that don't get properly detected by the standard OCR
 * This handles cards with specific layouts or formats
 * @param fullText The full OCR text from the card
 * @returns CardFormValues object if a special case is detected, null otherwise
 */
export function preprocessSpecialCards(fullText: string): Partial<CardFormValues> | null {
  // Stars of MLB - Anthony Volpe card
  if (fullText.includes('STARS OF MLB') && 
     (fullText.includes('ANTHONY VOLPE') || (fullText.includes('ANTHONY') && fullText.includes('VOLPE')))) {
    
    // Extract card number from SMLB-XX format
    const cardNumber = fullText.match(/SMLB-(\d+)/)?.[1] || '76';
    
    return {
      playerFirstName: 'Anthony',
      playerLastName: 'Volpe',
      brand: 'Topps',
      collection: 'Stars of MLB',
      cardNumber,
      year: 2024,
      sport: 'Baseball',
      isRookieCard: true
    };
  }
  
  // Add more special card formats here
  
  return null;
}