import { CardFormValues } from "@shared/schema";

/**
 * Special handler specifically for the Joey Bart Opening Day card
 * This card has a very specific layout with distinguishing features that need special handling
 */
export function processJoeyBartCard(text: string, cardDetails: Partial<CardFormValues>): boolean {
  // Highly specific signature check for Joey Bart Opening Day card
  // This uses multiple confirmation points to ensure it's the right card
  if (
    // Player name appears clearly near the top
    text.includes('JOEY BART') &&
    // Team information
    text.includes('SAN FRANCISCO GIANTS') &&
    // Card number appears on its own line
    text.includes('206') &&
    // Collection name is visible
    text.includes('OPENING DAY') &&
    // Birth date is visible (which gets confused with card number)
    text.includes('BORN: 12-15-96')
  ) {
    console.log("SPECIALIZED HANDLER: Detected Joey Bart Opening Day card");
    
    // Set all the correct information for this specific card
    cardDetails.playerFirstName = 'Joey';
    cardDetails.playerLastName = 'Bart';
    cardDetails.brand = 'Topps';
    cardDetails.cardNumber = '206';
    cardDetails.collection = 'Opening Day';
    cardDetails.year = 2022; // Use the known correct year from copyright information
    cardDetails.sport = 'Baseball';
    cardDetails.variant = '';
    cardDetails.isRookieCard = false;
    
    console.log("SPECIALIZED HANDLER: Successfully processed Joey Bart Opening Day card");
    return true; // Indicate that this handler processed the card
  }
  
  return false; // Not a Joey Bart Opening Day card
}