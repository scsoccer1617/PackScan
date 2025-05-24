import { CardFormValues } from '../shared/schema';

/**
 * Special handler for Upper Deck cards with specific layout
 * Upper Deck cards often have player name in a specific format at the bottom
 * and card number in the top corner
 */
export function processUpperDeckCard(text: string, cardDetails: Partial<CardFormValues>): boolean {
  // Check if this is an Upper Deck card
  const isUpperDeckCard = text.includes('UPPER DECK') || text.includes('THE UPPER DECK COM');
  
  if (!isUpperDeckCard) {
    return false;
  }
  
  console.log("Detected Upper Deck card, applying special processing");
  
  // For Upper Deck cards, the player name is often at the bottom
  // In format "LastName\nFirstName" 
  const namePattern = /P\s+•\s+([A-Z]+)\s+([A-Za-z]+)\s+([A-Za-z]+)/;
  const nameMatch = text.match(namePattern);
  
  if (nameMatch && nameMatch[2] && nameMatch[3]) {
    cardDetails.playerFirstName = nameMatch[3]; // Jimmy
    cardDetails.playerLastName = nameMatch[2];  // Jones
    console.log(`Upper Deck card player name: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
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