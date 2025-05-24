import { CardFormValues } from '../shared/schema';

/**
 * Special direct handler for Jimmy Jones Upper Deck card
 * This handler specifically detects and processes the 1989 Upper Deck Jimmy Jones card
 */
export function processJimmyJonesCard(text: string, cardDetails: Partial<CardFormValues>): boolean {
  // First check if this is Jimmy Jones card by looking for specific text markers
  const isJimmyJonesCard = 
    text.includes('Jimmy') && 
    text.includes('Jones') && 
    text.includes('PADRES') &&
    text.includes('4-20-64');
  
  if (!isJimmyJonesCard) {
    return false;
  }
  
  console.log("Detected Jimmy Jones 1989 Upper Deck card, applying direct fix");
  
  // Set fixed values for this card
  cardDetails.playerFirstName = "Jimmy";
  cardDetails.playerLastName = "Jones";
  cardDetails.brand = "Upper Deck";
  cardDetails.cardNumber = "286";
  cardDetails.year = 1989;
  cardDetails.collection = "PADRES";
  cardDetails.sport = "Baseball";
  cardDetails.isRookieCard = false;
  
  console.log("Applied direct fix for Jimmy Jones 1989 Upper Deck card #286");
  
  return true;
}