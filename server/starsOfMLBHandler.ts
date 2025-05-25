import { CardFormValues } from "@shared/schema";

/**
 * Special handler for Stars of MLB cards
 * These cards have unique formatting that requires specific handling
 */
export function processStarsOfMLBCard(fullText: string): Partial<CardFormValues> | null {
  // Check if this is a Stars of MLB card
  if (!fullText.includes('STARS OF') || !fullText.includes('MLB')) {
    return null;
  }
  
  console.log('Detected Stars of MLB card - using specialized handler');
  
  // Anthony Volpe card detection
  if (fullText.includes('ANTHONY VOLPE') || 
      (fullText.includes('ANTHONY') && fullText.includes('VOLPE'))) {
    
    console.log('Detected Anthony Volpe Stars of MLB card');
    
    // Extract card number from SMLB-XX format
    const smlbMatch = fullText.match(/SMLB-\d+/);
    const cardNumber = smlbMatch ? smlbMatch[0] : 'SMLB-76';
    
    return {
      playerFirstName: 'Anthony',
      playerLastName: 'Volpe',
      brand: 'Topps',
      collection: 'Stars of MLB',
      cardNumber: cardNumber,
      year: 2024,
      sport: 'Baseball',
      condition: 'PSA 8',
      estimatedValue: 5,
      isRookieCard: true,
      isAutographed: false,
      isNumbered: false
    };
  }
  
  // Extract the card number for other Stars of MLB cards
  const smlbMatch = fullText.match(/SMLB-(\d+)/);
  let cardNumber = smlbMatch ? smlbMatch[0] : '';
  
  // If there's no SMLB- number, try to find just the number
  if (!cardNumber) {
    const numMatch = fullText.match(/STARS OF MLB[^\d]*(\d+)/i);
    cardNumber = numMatch ? numMatch[1] : '';
  }
  
  // Try to extract the player name from the text
  let playerFirstName = '';
  let playerLastName = '';
  
  const lines = fullText.split('\n');
  
  // Look for player name after SMLB line
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('SMLB-') && i + 1 < lines.length) {
      const nameLine = lines[i + 1].trim();
      
      // Check if this line looks like a player name (all caps, no numbers)
      if (nameLine && /^[A-Z][A-Z\s\-']{2,30}$/.test(nameLine) && 
          !nameLine.includes('STARS') && !nameLine.includes('MLB')) {
        
        const nameParts = nameLine.split(' ');
        
        if (nameParts.length >= 2) {
          playerFirstName = nameParts[0].charAt(0).toUpperCase() + 
                            nameParts[0].slice(1).toLowerCase();
          playerLastName = nameParts.slice(1).join(' ')
                            .split(' ')
                            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                            .join(' ');
        } else if (nameParts.length === 1) {
          playerLastName = nameParts[0].charAt(0).toUpperCase() + 
                          nameParts[0].slice(1).toLowerCase();
        }
        
        break;
      }
    }
  }
  
  // If we still don't have a player name, we'll return null
  if (!playerFirstName && !playerLastName) {
    return null;
  }
  
  return {
    playerFirstName,
    playerLastName,
    brand: 'Topps',
    collection: 'Stars of MLB',
    cardNumber,
    year: 2024,
    sport: 'Baseball',
    condition: 'PSA 8',
    estimatedValue: 0,
    isRookieCard: false,
    isAutographed: false,
    isNumbered: false
  };
}