import { CardFormValues } from "@shared/schema";

/**
 * Special handler for Topps Series Two cards
 * These cards have "SERIES TWO" at the top which is getting confused with the player name
 */
export function processSeriesTwoCard(text: string, cardDetails: Partial<CardFormValues>): boolean {
  // Check for the key pattern of Series Two cards
  if (text.includes('SERIES TWO') && text.includes('@TOPPS')) {
    console.log("SPECIALIZED HANDLER: Detected Topps Series Two card");
    
    // Extract the actual player name which is usually on the second line or after SERIES TWO
    const lines = text.split('\n');
    let playerNameLine = '';
    
    // Find the player name line which is typically after "SERIES TWO"
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === 'SERIES TWO' && i + 1 < lines.length) {
        playerNameLine = lines[i + 1].trim();
        break;
      }
    }
    
    // If we found a name
    if (playerNameLine) {
      const nameParts = playerNameLine.trim().split(' ');
      if (nameParts.length >= 2) {
        cardDetails.playerFirstName = nameParts[0];
        cardDetails.playerLastName = nameParts.slice(1).join(' ');
      } else if (nameParts.length === 1) {
        cardDetails.playerFirstName = nameParts[0];
        cardDetails.playerLastName = '';
      }
      
      // Set collection to Series Two
      cardDetails.collection = 'Series Two';
      
      // Look for card number - typically a short number that appears alone on a line
      for (const line of lines) {
        const trimmed = line.trim();
        // Card numbers are typically 1-3 digits, occasionally with a letter
        if (/^[0-9]{1,3}[A-Za-z]?$/.test(trimmed)) {
          cardDetails.cardNumber = trimmed;
          break;
        }
      }
      
      // Try to extract the correct year from copyright text
      const copyrightMatch = text.match(/[©&][\s]*([0-9]{4})/);
      if (copyrightMatch && copyrightMatch[1]) {
        cardDetails.year = parseInt(copyrightMatch[1]);
      }
      
      console.log("SPECIALIZED HANDLER: Successfully processed Series Two card");
      console.log(`Detected player: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
      console.log(`Detected card number: ${cardDetails.cardNumber}`);
      
      return true;
    }
  }
  
  return false;
}