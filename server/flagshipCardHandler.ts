import { CardFormValues } from "@shared/schema";

/**
 * Special handler for Topps Flagship Collection cards
 * These cards have a specific format where the collection name appears before the player name
 */
export function processFlagshipCollectionCard(text: string, cardDetails: Partial<CardFormValues>): boolean {
  if (!text.includes('FLAGSHIP') || !text.includes('COLLECTION')) {
    return false;
  }

  // This is a Flagship Collection card
  const lines = text.split('\n').map(line => line.trim());
  let playerNameFound = false;
  let cardNumberFound = false;

  // Set the collection 
  cardDetails.collection = 'Flagship Collection';

  // Look for player name (typically after COLLECTION and before player details)
  for (let i = 0; i < lines.length; i++) {
    // If we find a line that says "FLAGSHIP", look for the player name a few lines later
    if (lines[i].includes('FLAGSHIP')) {
      // Skip lines until we find the player name (usually after P or @TOPPS line)
      for (let j = i + 1; j < i + 10 && j < lines.length; j++) {
        // Skip the COLLECTION, P, and @TOPPS lines
        if (
          lines[j].includes('COLLECTION') || 
          lines[j].trim() === 'P' || 
          lines[j].includes('@TOPPS') ||
          lines[j].length < 3 ||
          lines[j].includes('®')
        ) {
          continue;
        }
        
        // The first substantial line after these is likely the player name
        // Look for all caps name
        if (/^[A-Z\s'.-]{3,}$/.test(lines[j])) {
          const nameParts = lines[j].trim().split(/\s+/);
          if (nameParts.length >= 2) {
            cardDetails.playerFirstName = nameParts[0];
            cardDetails.playerLastName = nameParts.slice(1).join(' ');
            playerNameFound = true;
            console.log(`Detected Flagship Collection player name: ${lines[j]}`);
            break;
          }
        }
      }
      
      if (playerNameFound) break;
    }
  }

  // Look for card number (it's typically at the beginning of the text)
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    // The card number is usually just a number by itself at the top
    const numericMatch = lines[i].match(/^(\d+)$/);
    if (numericMatch) {
      cardDetails.cardNumber = numericMatch[1];
      cardNumberFound = true;
      console.log(`Detected Flagship Collection card number: ${cardDetails.cardNumber}`);
      break;
    }
  }

  // Set other details
  cardDetails.brand = 'Topps';
  
  // Look for birth date in format "BORN: MM-DD-YY"
  const birthDateMatch = text.match(/BORN:\s+(\d+)-(\d+)-(\d+)/);
  if (birthDateMatch) {
    console.log(`Found birth date reference: ${birthDateMatch[0]}`);
    // This is NOT the card number, it's the birth date
    // We should check if we mistakenly set this as the card number
    if (cardDetails.cardNumber === `${birthDateMatch[1]}-${birthDateMatch[2]}`) {
      cardDetails.cardNumber = ''; // Clear the incorrect card number
      cardNumberFound = false;
    }
  }

  // Return true if we successfully processed the card
  return playerNameFound;
}