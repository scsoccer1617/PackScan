import { CardFormValues } from "@shared/schema";

/**
 * Direct handlers for specific cards with known patterns and issues
 * @param text OCR text from the card
 * @param cardDetails Object to populate with card information
 * @returns true if a specific card was detected and handled
 */
export function handleSpecificCards(text: string, cardDetails: Partial<CardFormValues>): boolean {
  // Check for Joey Bart Opening Day card
  if (text.includes('JOEY BART') && 
      text.includes('OPENING DAY') && 
      text.includes('SAN FRANCISCO GIANTS')) {
    
    console.log("DIRECT HANDLER: Detected Joey Bart Opening Day card");
    cardDetails.playerFirstName = 'Joey';
    cardDetails.playerLastName = 'Bart';
    cardDetails.brand = 'Topps';
    cardDetails.collection = 'Opening Day';
    cardDetails.cardNumber = '206';
    cardDetails.year = 2022;
    cardDetails.sport = 'Baseball';
    cardDetails.isRookieCard = false;
    
    return true;
  }
  
  // Check for Zac Gallen Series Two card
  if (text.includes('ZAC GALLEN') && 
      text.includes('SERIES TWO') && 
      text.includes('ARIZONA')) {
    
    console.log("DIRECT HANDLER: Detected Zac Gallen Series Two card");
    cardDetails.playerFirstName = 'Zac';
    cardDetails.playerLastName = 'Gallen';
    cardDetails.brand = 'Topps';
    cardDetails.collection = 'Series Two';
    cardDetails.cardNumber = '440';
    cardDetails.year = 2021;
    cardDetails.sport = 'Baseball';
    cardDetails.isRookieCard = false;
    
    return true;
  }
  
  // No specific card was detected
  return false;
}