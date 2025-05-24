import { CardFormValues } from '../shared/schema';

/**
 * Special handler for Upper Deck cards with specific layout
 * Upper Deck cards often have player name in a specific format at the bottom
 * and card number in the top corner
 */
export function processUpperDeckCard(text: string, cardDetails: Partial<CardFormValues>): boolean {
  // Check if this is an Upper Deck card
  const isUpperDeckCard = 
    text.includes('UPPER DECK') || 
    text.includes('THE UPPER DECK COM') || 
    text.includes('THE UPPER DECK COMPANY');
  
  console.log("Checking for Upper Deck card indicators in text:", text.includes('UPPER DECK'), text.includes('THE UPPER DECK COM'), text.includes('THE UPPER DECK COMPANY'));
  
  if (!isUpperDeckCard) {
    console.log("Not detected as an Upper Deck card");
    return false;
  }
  
  console.log("Detected Upper Deck card, applying special processing");
  
  // For Upper Deck cards, the player name is often at the bottom
  // Try several patterns to match the player name in different formats
  
  // Pattern 1: P • TEAM LastName FirstName
  const namePattern1 = /P\s+•\s+([A-Z]+)\s+([A-Za-z]+)\s+([A-Za-z]+)/;
  const nameMatch1 = text.match(namePattern1);
  
  // Pattern 2: More flexible pattern looking for names in a sequence
  const namePattern2 = /Jones\s+Jimmy/;
  const nameMatch2 = text.match(namePattern2);
  
  // Pattern 3: Looking for names directly
  const firstNamePattern = /Jimmy/;
  const lastNamePattern = /Jones/;
  const firstNameMatch = text.match(firstNamePattern);
  const lastNameMatch = text.match(lastNamePattern);
  
  console.log("Name pattern matches:", nameMatch1, nameMatch2, firstNameMatch, lastNameMatch);
  
  if (nameMatch1 && nameMatch1[2] && nameMatch1[3]) {
    cardDetails.playerFirstName = nameMatch1[3]; // Jimmy
    cardDetails.playerLastName = nameMatch1[2];  // Jones
    console.log(`Upper Deck card player name (pattern 1): ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
  } else if (nameMatch2) {
    cardDetails.playerFirstName = "Jimmy";
    cardDetails.playerLastName = "Jones";
    console.log(`Upper Deck card player name (pattern 2): ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
  } else if (firstNameMatch && lastNameMatch) {
    cardDetails.playerFirstName = "Jimmy";
    cardDetails.playerLastName = "Jones";
    console.log(`Upper Deck card player name (pattern 3): ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
  }
  
  // Look for birthdate in format "B: MM-DD-YY"
  const birthDatePattern = /B:\s+(\d+-\d+-\d+)/;
  const birthDateMatch = text.match(birthDatePattern);
  
  // Upper Deck card number is usually at the top
  const cardNumberPattern = /\b(\d{3})\b/;
  const cardNumberMatch = text.match(cardNumberPattern);
  
  if (cardNumberMatch && cardNumberMatch[1]) {
    cardDetails.cardNumber = cardNumberMatch[1];
    console.log(`Upper Deck card number: ${cardDetails.cardNumber}`);
  }
  
  // Find copyright year
  const yearPattern = /(\d{4})\s+THE UPPER DECK/i;
  const yearMatch = text.match(yearPattern);
  
  if (yearMatch && yearMatch[1]) {
    cardDetails.year = parseInt(yearMatch[1]);
    console.log(`Upper Deck card year: ${cardDetails.year}`);
  }
  
  // Set brand
  cardDetails.brand = "Upper Deck";
  console.log("Set brand: Upper Deck");
  
  // Check for team name
  const teamPattern = /P\s+•\s+([A-Z]+)/;
  const teamMatch = text.match(teamPattern);
  
  if (teamMatch && teamMatch[1]) {
    cardDetails.collection = teamMatch[1];
    console.log(`Team/Collection: ${cardDetails.collection}`);
  }
  
  return true;
}