import { CardFormValues } from "@shared/schema";

/**
 * A specialized analyzer for Score brand cards which have a distinctive layout
 * This helps extract information from older Score cards from the 1990s
 * 
 * @param fullText The full OCR text extracted from the card
 * @returns Partial card details with extracted information
 */
export function analyzeScoreCard(fullText: string): Partial<CardFormValues> {
  console.log('Analyzing Score card with specialized analyzer...');
  
  // Initialize with default values
  const cardDetails: Partial<CardFormValues> = {
    brand: 'Score',
    condition: 'PSA 8',
    sport: 'Baseball',
    year: 1990, // Most Score cards are from early 90s, but we'll check for copyright
    collection: 'Score Base',
    estimatedValue: 0,
    isRookieCard: false
  };
  
  // Split text into lines for easier analysis
  const lines = fullText.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  
  console.log('Score card text lines:', lines.slice(0, 5));
  
  // Step 1: Extract card number - usually first line or at top corner
  const firstLine = lines[0];
  if (firstLine && /^\d{1,3}$/.test(firstLine)) {
    cardDetails.cardNumber = firstLine;
    console.log(`Score card number found: ${cardDetails.cardNumber}`);
  }
  
  // Step 2: Extract player name - typically lines 2 and 3 after the brand name
  let scoreIndex = -1;
  
  // Find the SCORE text line
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toUpperCase() === 'SCORE') {
      scoreIndex = i;
      break;
    }
  }
  
  // Player name typically follows the SCORE text
  if (scoreIndex >= 0 && scoreIndex + 2 < lines.length) {
    cardDetails.playerFirstName = formatName(lines[scoreIndex + 1]);
    cardDetails.playerLastName = formatName(lines[scoreIndex + 2]);
    console.log(`Score player name detected: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
  }
  
  // Step 3: Look for copyright year
  const copyrightPattern = /(?:©|\(C\)|\&copy;|\&\s*©|\&\s*\(C\))(?:\s*)(\d{4})/i;
  for (const line of lines) {
    const copyrightMatch = line.match(copyrightPattern);
    if (copyrightMatch && copyrightMatch[1]) {
      const year = parseInt(copyrightMatch[1]);
      if (year >= 1900 && year <= new Date().getFullYear()) {
        cardDetails.year = year;
        console.log(`Score card copyright year: ${cardDetails.year}`);
        // Set collection with year
        cardDetails.collection = `${cardDetails.year} Score`;
        break;
      }
    }
  }
  
  // Step 4: Check for rookie indicators
  const rookieRegex = /rookie|prospect|future\s+star|draft\s+pick|first\s+year/i;
  let rookieIndicator = false;
  
  for (const line of lines) {
    if (rookieRegex.test(line)) {
      rookieIndicator = true;
      break;
    }
  }
  
  // Also check bio text for rookie indicators (Score cards often mention this in player bio)
  const bioText = lines.slice(Math.min(10, lines.length)).join(' ');
  if (
    bioText.includes('rookie') || 
    bioText.includes('rookies') || 
    /\b19\d\d's\s+more\s+spectacular\s+rookies/.test(bioText)
  ) {
    rookieIndicator = true;
  }
  
  if (rookieIndicator) {
    cardDetails.isRookieCard = true;
    console.log('Score card rookie status detected');
  }
  
  return cardDetails;
}

/**
 * Format a name with proper capitalization
 */
function formatName(name: string): string {
  if (!name) return '';
  
  return name.toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}