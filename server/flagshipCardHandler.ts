import { CardFormValues } from "@shared/schema";

/**
 * Special handler for Topps Flagship Collection cards
 * These cards have a specific format where the collection name appears before the player name
 */
export function processFlagshipCollectionCard(text: string, cardDetails: Partial<CardFormValues>): boolean {
  if (!text.includes('FLAGSHIP') || !text.includes('COLLECTION')) {
    return false;
  }

  console.log("Processing Flagship Collection card");
  
  // This is a Flagship Collection card
  const lines = text.split('\n').map(line => line.trim());
  let playerNameFound = false;
  let cardNumberFound = false;

  // Set the collection and brand
  cardDetails.collection = 'Flagship Collection';
  cardDetails.brand = 'Topps';
  
  // Set the year from copyright info
  const yearMatch = text.match(/[©Ⓡ&]\s*(\d{4})\s+THE TOPPS COMPANY/i);
  if (yearMatch && yearMatch[1]) {
    cardDetails.year = parseInt(yearMatch[1]);
    console.log(`Set Flagship Collection year to ${cardDetails.year}`);
  } else {
    // Default to current year if not found
    cardDetails.year = 2024;
  }

  // Look for card number (it's typically at the beginning of the text)
  // The very first line is often the card number
  if (lines.length > 0) {
    const firstLine = lines[0].trim();
    if (/^\d+$/.test(firstLine)) {
      cardDetails.cardNumber = firstLine;
      cardNumberFound = true;
      console.log(`Detected Flagship Collection card number: ${cardDetails.cardNumber}`);
    }
  }

  // Look for player name (Flagship cards have a clear layout with player name after COLLECTION)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('COLLECTION')) {
      // Player name is typically the next non-empty line after "COLLECTION"
      for (let j = i + 1; j < i + 5 && j < lines.length; j++) {
        const line = lines[j].trim();
        
        // Skip empty lines or lines containing specific words
        if (
          line.length < 3 || 
          line === 'P' || 
          line.includes('@TOPPS') || 
          line.includes('CUBS') ||
          line.includes('®')
        ) {
          continue;
        }
        
        // This should be the player name
        const nameParts = line.split(/\s+/);
        if (nameParts.length >= 2) {
          cardDetails.playerFirstName = nameParts[0];
          cardDetails.playerLastName = nameParts.slice(1).join(' ');
          playerNameFound = true;
          console.log(`Detected Flagship Collection player name: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
          break;
        }
      }
      
      if (playerNameFound) break;
    }
  }

  // Set rookie card status based on drafting info
  if (text.includes('DRAFT') || text.includes('DRAFTED')) {
    cardDetails.isRookieCard = true;
    console.log("Detected rookie status for Flagship Collection card");
  }
  
  // Make sure we're not confusing the birth date with the card number
  const birthDateMatch = text.match(/BORN:\s+(\d+)-(\d+)-(\d+)/);
  if (birthDateMatch) {
    console.log(`Found birth date reference: ${birthDateMatch[0]}`);
    // This is NOT the card number, it's the birth date
    // We should check if we mistakenly set this as the card number
    if (cardDetails.cardNumber === `${birthDateMatch[1]}-${birthDateMatch[2]}`) {
      console.log("Correcting card number - was mistakenly using birth date");
      cardDetails.cardNumber = ''; // Clear the incorrect card number
      cardNumberFound = false;
    }
  }

  // Print result of processing
  console.log(`Flagship Collection card processing results:
  - Player: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}
  - Card #: ${cardDetails.cardNumber}
  - Year: ${cardDetails.year}
  - Collection: ${cardDetails.collection}
  - Rookie: ${cardDetails.isRookieCard}`);

  // Return true if we successfully processed the card
  return playerNameFound && cardNumberFound;
}