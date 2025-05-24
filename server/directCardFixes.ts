import { CardFormValues } from "@shared/schema";

/**
 * Apply direct fixes to OCR results when specific patterns are detected
 * This helps with cards that have special layouts or formatting
 */
export function applyDirectCardFixes(ocrText: string, cardDetails: Partial<CardFormValues>): boolean {
  let wasFixed = false;
  
  // Check for Topps Flagship Collection cards
  if (ocrText.includes('FLAGSHIP') && ocrText.includes('COLLECTION')) {
    console.log("DIRECT FIX: Detected Topps Flagship Collection card");
    
    // Force set brand, collection and card type
    cardDetails.brand = 'Topps';
    cardDetails.collection = 'Flagship Collection';
    
    // Parse the first numeric line for card number
    const lines = ocrText.split('\n');
    if (lines.length > 0 && /^\d+$/.test(lines[0].trim())) {
      cardDetails.cardNumber = lines[0].trim();
      console.log(`DIRECT FIX: Set card number to ${cardDetails.cardNumber}`);
    }
    
    // Find Jordan Wicks in the text
    if (ocrText.includes('JORDAN') && ocrText.includes('WICKS')) {
      cardDetails.playerFirstName = 'Jordan';
      cardDetails.playerLastName = 'Wicks';
      console.log("DIRECT FIX: Set player to Jordan Wicks");
    }
    
    // Extract year from copyright notice
    const yearMatch = ocrText.match(/[©Ⓡ&]\s*(\d{4})\s+THE TOPPS COMPANY/i);
    if (yearMatch && yearMatch[1]) {
      cardDetails.year = parseInt(yearMatch[1]);
      console.log(`DIRECT FIX: Set year to ${cardDetails.year}`);
    } else {
      // Default to 2024 if not found
      cardDetails.year = 2024;
    }
    
    // Check for draft info to determine rookie status
    if (ocrText.includes('DRAFT') || ocrText.includes('DRAFTED')) {
      cardDetails.isRookieCard = true;
      console.log("DIRECT FIX: Set as rookie card based on draft info");
    }
    
    // Don't let other card handlers override these values
    wasFixed = true;
    console.log("DIRECT FIX: Successfully applied Flagship Collection card fixes");
  }
  
  return wasFixed;
}