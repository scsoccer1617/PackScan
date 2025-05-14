import { CardFormValues } from "@shared/schema";
import { extractTextFromImage } from "./googleVisionFetch";

interface TextAnnotation {
  description: string;
  boundingPoly?: {
    vertices: Array<{
      x: number;
      y: number;
    }>;
  };
}

interface OCRResult {
  fullText: string;
  textAnnotations: TextAnnotation[];
}

/**
 * Extract text from image using Google Cloud Vision API
 * @param base64Image Base64 encoded image
 * @returns Extracted text and text annotations
 */
export async function getTextFromImage(base64Image: string): Promise<OCRResult> {
  const result = await extractTextFromImage(base64Image);
  return {
    fullText: result.fullText,
    textAnnotations: result.textAnnotations
  };
}

/**
 * Analyze a sports card image to extract relevant information dynamically without player-specific handlers
 * @param base64Image Base64 encoded image data
 * @returns Object with extracted card information
 */
export async function analyzeSportsCardImage(base64Image: string): Promise<Partial<CardFormValues>> {
  try {
    // Extract the text from the image
    const { fullText, textAnnotations } = await getTextFromImage(base64Image);
    
    console.log('Full OCR text:', fullText);
    
    // Initialize card details object with default values
    const cardDetails: Partial<CardFormValues> = {
      condition: 'PSA 8', // Default condition per requirements
      estimatedValue: 0, // Default value
      sport: 'Baseball', // Default sport
    };
    
    // Parse all extracted text
    const cleanText = fullText.toUpperCase().replace(/\s+/g, ' ').trim();
    
    // PLAYER NAME DETECTION - Extract player name using positional and context analysis
    extractPlayerName(cleanText, cardDetails);
    
    // CARD NUMBER DETECTION - Extract card number using regex patterns
    extractCardNumber(cleanText, cardDetails);
    
    // COLLECTION, BRAND & YEAR DETECTION - Extract using pattern recognition
    extractCardMetadata(cleanText, cardDetails);
    
    // SERIAL NUMBER DETECTION - Look for serial numbering
    extractSerialNumber(cleanText, cardDetails);
    
    // CARD FEATURES DETECTION - Rookie cards, autographs, etc.
    detectCardFeatures(cleanText, cardDetails);
    
    // SPORT DETECTION - Try to detect the sport if not already set
    // Sport detection should happen after other metadata extraction
    if (!cardDetails.sport) {
      cardDetails.sport = "Baseball"; // Default to Baseball
    }
    
    // Enhanced sport detection with more comprehensive keyword lists
    if (cleanText.match(/FOOTBALL|NFL|QUARTERBACK|QB|TOUCHDOWN|TD|RECEIVER|WR|RB|RUNNING BACK|FIELD GOAL|TACKLE|YARDS|OFFENSIVE|DEFENSIVE|COACH|PASS|PUNT|KICK|BOWL|LINEMAN|DRAFT|GUARD|COLTS|BENGALS|COWBOYS|GIANTS|PACKERS|SEAHAWKS|CHIEFS|BRONCOS|PATRIOTS|VIKINGS|FALCONS|SAINTS/i)) {
      cardDetails.sport = "Football";
      console.log("Sport detected: Football");
    } else if (cleanText.match(/BASKETBALL|NBA|SLAM DUNK|POINT GUARD|PG|SHOOTING GUARD|SG|SMALL FORWARD|SF|POWER FORWARD|PF|CENTER|C|COURT|REBOUND|PLAYOFFS|FINALS|DRAFT|LAKERS|CELTICS|BULLS|WARRIORS|KNICKS|NETS|HEAT|MAVERICKS|SPURS|ROCKETS|RAPTORS|BUCKS|CAVALIERS|SUNS|NUGGETS/i)) {
      cardDetails.sport = "Basketball";
      console.log("Sport detected: Basketball");
    } else if (cleanText.match(/HOCKEY|NHL|GOALIE|ICE RINK|PUCK|PENALTY|STANLEY CUP|PLAYOFFS|DEFENSEMAN|FORWARD|LEFT WING|RIGHT WING|LW|RW|CENTER|BLUE LINE|BRUINS|CANADIENS|RED WINGS|BLACKHAWKS|RANGERS|MAPLE LEAFS|FLYERS|PENGUINS|OILERS|FLAMES|AVALANCHE|GOLDEN KNIGHTS|LIGHTNING/i)) {
      cardDetails.sport = "Hockey";
      console.log("Sport detected: Hockey");
    } else if (cleanText.match(/SOCCER|FOOTBALL CLUB|FC|FIFA|WORLD CUP|PREMIER LEAGUE|LA LIGA|BUNDESLIGA|SERIE A|LIGUE 1|MLS|FORWARD|STRIKER|MIDFIELDER|DEFENDER|GOALKEEPER|GK|GOAL|BARCELONA|REAL MADRID|MANCHESTER|LIVERPOOL|CHELSEA|ARSENAL|BAYERN|PSG|JUVENTUS|INTER|AC MILAN/i)) {
      cardDetails.sport = "Soccer";
      console.log("Sport detected: Soccer");
    } else if (cleanText.match(/BASEBALL|MLB|PITCHER|P|CATCHER|C|INFIELDER|OUTFIELDER|SS|1B|2B|3B|OF|DH|DESIGNATED HITTER|SHORTSTOP|HOMERUN|HOME RUN|WORLD SERIES|ALL-STAR|MVP|ROOKIE|TOPPS|BOWMAN|HERITAGE|CHROME|PANINI|DONRUSS|STADIUM CLUB|YANKEES|RED SOX|DODGERS|CUBS|GIANTS|CARDINALS|BRAVES|ASTROS|PHILLIES|NATIONALS|METS|BLUE JAYS|ANGELS|RANGERS/i)) {
      cardDetails.sport = "Baseball";
      console.log("Sport detected: Baseball");
    } else {
      console.log("Sport detected: Baseball (default)");
      cardDetails.sport = "Baseball";
    }
    
    // No player-specific overrides - fully dynamic
    
    console.log('Extracted card details:', cardDetails);
    return cardDetails;
  } catch (error) {
    console.error('Error analyzing card image:', error);
    throw error;
  }
}

/**
 * Extract player name using pattern recognition and common positions
 */
function extractPlayerName(text: string, cardDetails: Partial<CardFormValues>): void {
  // Special case for Stars of MLB cards - prioritize bottom right and top middle positions
  if (text.includes("STARS") && text.includes("MLB")) {
    console.log("Applying special Stars of MLB player name detection rules");
    
    // For Stars of MLB cards, we'll try multiple focused approaches
    
    // First try: Look for a player name line that's prominent in Stars of MLB cards
    // This pattern looks for a name that's likely to be the player name (all caps, 2 words)
    const nameLinePattern = /\n([A-Z]+)\s+([A-Z]+)\s*\n/;
    const nameLineMatch = text.match(nameLinePattern);
    
    if (nameLineMatch) {
      cardDetails.playerFirstName = nameLineMatch[1].toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
        
      cardDetails.playerLastName = nameLineMatch[2].toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
      
      console.log(`Detected Stars of MLB player name from caption: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
      return;
    }
    
    // Second try: Look for card number followed immediately by a player name
    // Example: "SMLB-27 FREDDIE FREEMAN" or "CSMLB-2 MIKE TROUT"
    const cardNumberNamePattern = /\b(?:SMLB|CSMLB)[-]?\d+\s+([A-Z]+)\s+([A-Z]+)\b/i;
    const cardNumberNameMatch = text.match(cardNumberNamePattern);
    
    if (cardNumberNameMatch) {
      cardDetails.playerFirstName = cardNumberNameMatch[1].toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
        
      cardDetails.playerLastName = cardNumberNameMatch[2].toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
      
      console.log(`Detected Stars of MLB player name near card number: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
      return;
    }
    
    // Second try: Look for player name followed by team name and position
    // Find patterns like "MANNY MACHADO SAN DIEGO PADRES | 3B"
    const playerTeamPositionPattern = /([A-Z]+)\s+([A-Z]+)\s+([A-Z\s]+)\s*[|]\s*([0-9A-Z]+)/;
    const playerTeamMatch = text.match(playerTeamPositionPattern);
    
    if (playerTeamMatch) {
      cardDetails.playerFirstName = playerTeamMatch[1].toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
        
      cardDetails.playerLastName = playerTeamMatch[2].toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
      
      console.log(`Detected Stars of MLB player name with team and position: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
      return;
    }
    
    // Third try: Look for names near team names, which are common in Star of MLB cards
    const teams = ['YANKEES', 'RED SOX', 'DODGERS', 'CUBS', 'ANGELS', 'BRAVES', 'TWINS', 'PADRES', 'BREWERS', 'ASTROS'];
    
    for (const team of teams) {
      if (text.includes(team)) {
        // Find the index of the team name
        const teamIndex = text.indexOf(team);
        
        // Get text before the team name (usually contains player name)
        const beforeTeam = text.substring(0, teamIndex).trim().split(/\s+/);
        
        // If we have enough words before the team name, extract potential player name
        if (beforeTeam.length >= 2) {
          // Try to get the last two words before the team name
          const potentialFirstName = beforeTeam[beforeTeam.length - 2];
          const potentialLastName = beforeTeam[beforeTeam.length - 1];
          
          // Basic validation - verify these look like names
          if (potentialFirstName && potentialLastName && 
              !/[0-9*#@<>]/.test(potentialFirstName + potentialLastName) &&
              !['MAJOR', 'LEAGUE', 'BASEBALL', 'TRADING', 'CARD', 'TOPPS', 'SAN', 'LOS'].includes(potentialFirstName) &&
              !['MAJOR', 'LEAGUE', 'BASEBALL', 'TRADING', 'CARD', 'TOPPS', 'DIEGO', 'ANGELES'].includes(potentialLastName)) {
            
            cardDetails.playerFirstName = potentialFirstName.toLowerCase()
              .split(' ')
              .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
              .join(' ');
              
            cardDetails.playerLastName = potentialLastName.toLowerCase()
              .split(' ')
              .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
              .join(' ');
            
            console.log(`Detected Stars of MLB player name near team: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
            return;
          }
        }
      }
    }
    
    // Third try: Look for capitalized words that might be names by position in text
    // Most Stars of MLB cards have the player name in a standard location/format
    const lines = text.split('\n');
    
    // Look for patterns in each line that might indicate a player name
    for (const line of lines) {
      // Skip lines with card-specific terms to avoid false positives
      if (line.includes('TOPPS') || line.includes('MLB') || line.includes('CARD') || 
          line.includes('STARS') || line.includes('BASEBALL')) {
        continue;
      }
      
      // Look for lines with exactly two capitalized words (potential first & last name)
      const namePattern = /^([A-Z][A-Za-z]+)\s+([A-Z][A-Za-z]+)$/;
      const nameMatch = line.match(namePattern);
      
      if (nameMatch && nameMatch[1] && nameMatch[2]) {
        cardDetails.playerFirstName = nameMatch[1];
        cardDetails.playerLastName = nameMatch[2];
        console.log(`Detected Stars of MLB player name by line position: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
        return;
      }
    }
    
    // No player-specific hardcoded detection - fully dynamic
    
    // If all Stars of MLB specific approaches fail, use general name patterns from whole text
    const allWords = text.split(/\s+/);
    const potentialNames = [];
    
    // Find pairs of capitalized words
    for (let i = 0; i < allWords.length - 1; i++) {
      const word1 = allWords[i];
      const word2 = allWords[i + 1];
      
      if (word1 && word2 && 
          word1.length > 1 && word2.length > 1 && 
          /^[A-Z]/.test(word1) && /^[A-Z]/.test(word2) &&
          !/[0-9]/.test(word1 + word2) &&
          !['MAJOR', 'LEAGUE', 'BASEBALL', 'TRADING', 'CARD', 'TOPPS', 'STARS', 'MLB', 'CHROME'].includes(word1) &&
          !['MAJOR', 'LEAGUE', 'BASEBALL', 'TRADING', 'CARD', 'TOPPS', 'STARS', 'MLB', 'CHROME'].includes(word2)) {
        
        potentialNames.push({ firstName: word1, lastName: word2 });
      }
    }
    
    // If we found potential names, use the first one
    if (potentialNames.length > 0) {
      cardDetails.playerFirstName = potentialNames[0].firstName.toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
        
      cardDetails.playerLastName = potentialNames[0].lastName.toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
      
      console.log(`Detected Stars of MLB player name by general pattern: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
      return;
    }
    
    // If all specific Stars of MLB approaches fail, set generic values
    console.log('Could not detect Stars of MLB player name with confidence. Setting generic values.');
    cardDetails.playerFirstName = 'Unknown';
    cardDetails.playerLastName = 'Player';
    return;
  }
  
  // For non-Stars of MLB cards, use the general approach
  // Common sports names that might be in the text (not player-specific)
  const sportKeywords = ['BASEBALL', 'FOOTBALL', 'BASKETBALL', 'HOCKEY', 'SOCCER', 'MLB', 'NFL', 'NBA', 'NHL'];
  
  // Exclude words that are commonly misidentified as player names
  const excludedPlayerNames = ['MAJOR LEAGUE', 'BASEBALL', 'TRADING CARD', 'TOPPS', 'PANINI', 'UPPER DECK'];
  
  // Try to extract player name using various patterns and positions
  
  // Pattern 1: Look for potential name at the beginning of the text (most common position)
  let nameParts = text.split(' ').slice(0, 3);
  let potentialName = nameParts.join(' ');
  
  // Check if the potential name contains excluded terms
  const isExcluded = excludedPlayerNames.some(term => potentialName.includes(term));
  
  if (!isExcluded && nameParts.length >= 2) {
    // Basic validation - names typically don't contain digits or special characters
    if (!/[0-9*#@<>]/.test(potentialName) && !/MLB|NFL|NBA|NHL/.test(potentialName)) {
      cardDetails.playerFirstName = nameParts[0].toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
        
      cardDetails.playerLastName = nameParts.slice(1).join(' ').toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
      
      console.log(`Detected player name (pattern 1): ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
      return;
    }
  }
  
  // Pattern 2: Try to find player name using positional analysis - sometimes the name is positioned
  // near a team name or position indicator like "PITCHER", "INFIELDER", etc.
  const teams = ['YANKEES', 'RED SOX', 'DODGERS', 'CUBS', 'ANGELS', 'BRAVES', 'TWINS', 'PADRES', 'BREWERS'];
  const positions = ['PITCHER', 'CATCHER', 'INFIELDER', 'OUTFIELDER'];
  
  // Search for a team name or position, then look for nearby words that might be a player name
  for (const keyword of [...teams, ...positions]) {
    if (text.includes(keyword)) {
      const index = text.indexOf(keyword);
      const beforeKeyword = text.substring(0, index).trim().split(' ');
      
      // Take the last few words before the team/position as the potential name
      if (beforeKeyword.length >= 2) {
        const firstName = beforeKeyword[beforeKeyword.length - 2];
        const lastName = beforeKeyword[beforeKeyword.length - 1];
        
        // Basic validation
        if (!/[0-9*#@<>]/.test(firstName + lastName) && 
            !sportKeywords.includes(firstName) && 
            !sportKeywords.includes(lastName) &&
            !excludedPlayerNames.includes(`${firstName} ${lastName}`)) {
          
          cardDetails.playerFirstName = firstName.toLowerCase()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
            
          cardDetails.playerLastName = lastName.toLowerCase()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
          
          console.log(`Detected player name (pattern 2): ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
          return;
        }
      }
    }
  }
  
  console.log('Could not detect player name with confidence. Setting generic values.');
  cardDetails.playerFirstName = 'Unknown';
  cardDetails.playerLastName = 'Player';
}

/**
 * Extract card number using regex patterns for common formats
 */
function extractCardNumber(text: string, cardDetails: Partial<CardFormValues>): void {
  // Special case for Stars of MLB Collection
  if (text.includes("STARS") && text.includes("MLB")) {
    console.log("Applying special Stars of MLB card number rules");
    
    // No special handling for specific players
    // Dynamic detection of card information only
    
    // No player-specific hardcoded detection - fully dynamic

    // Look for all possible patterns of Stars of MLB card numbers
    // Fully dynamic detection for any card number format including double-digit numbers
    const smlbPatterns = [
      // Chrome Stars MLB formats (prioritize these first for exactness)
      { regex: /\b(CSMLB[-]?[0-9]{1,3})\b/i, format: "Chrome Stars MLB exact", example: "CSMLB-44" },
      { regex: /\b(CSMLB)\s*[-]?\s*([0-9]{1,3})\b/i, format: "Chrome Stars MLB with space", example: "CSMLB 44" },
      { regex: /\b(CSMLB[0-9]{1,3})\b/i, format: "Chrome Stars MLB no dash", example: "CSMLB44" },
      
      // Regular Stars MLB formats
      { regex: /\b(SMLB[-]?[0-9]{1,3})\b/i, format: "Stars MLB exact", example: "SMLB-27" },
      { regex: /\b(SMLB)\s*[-]?\s*([0-9]{1,3})\b/i, format: "Stars MLB with space", example: "SMLB 27" },
      { regex: /\b(SMLB[0-9]{1,3})\b/i, format: "Stars MLB no dash", example: "SMLB27" }
    ];
    
    // First try precise MLB card number patterns
    for (const pattern of smlbPatterns) {
      const match = text.match(pattern.regex);
      if (match) {
        // Handle special case where we have a space or no dash
        if (pattern.format.includes("with space")) {
          // For "SMLB 27" format, construct the proper format with dash
          cardDetails.cardNumber = `${match[1]}-${match[2]}`;
        } else if (match[0].includes("-")) {
          // Already has a dash, use as-is
          cardDetails.cardNumber = match[0].toUpperCase();
        } else {
          // No dash, add it (for cases like SMLB27 -> SMLB-27 or CSMLB2 -> CSMLB-2)
          try {
            // Safe extraction with null checks
            const matchText = match[0] || '';
            const prefixMatch = matchText.match(/[A-Za-z]+/);
            const numberMatch = matchText.match(/\d+/);
            
            if (prefixMatch && prefixMatch[0] && numberMatch && numberMatch[0]) {
              const prefix = prefixMatch[0].toUpperCase();
              const number = numberMatch[0];
              cardDetails.cardNumber = `${prefix}-${number}`;
            } else {
              // Fallback to just using what we matched
              cardDetails.cardNumber = matchText.toUpperCase();
            }
          } catch (error) {
            // Last resort fallback
            console.error("Error formatting card number:", error);
            cardDetails.cardNumber = match[0] ? match[0].toUpperCase() : 'UNKNOWN';
          }
        }

        console.log(`Detected Stars of MLB card number: ${cardDetails.cardNumber}`);
        
        // Also set the collection and other metadata
        // Handle Chrome as a variant, not a separate collection
        cardDetails.collection = "Stars of MLB";
        
        if (pattern.format.includes("Chrome")) {
          cardDetails.variant = "Chrome";
        }
        
        cardDetails.brand = "Topps";
        return;
      }
    }
    
    // If we get here, we didn't find a specific Stars of MLB card number pattern
    // Look for plain numbers that might be part of a SMLB card number
    // No hardcoded player detection - only dynamic analysis
    // Let the system detect card numbers naturally
    
    // Updated to support two-digit or higher card numbers (up to 999)
    // Exclude numbers that are likely part of stats/text and not card numbers
    // Filter out numbers in contexts like "12-year run", "30-home run", "91 RBI", etc.
    const excludedPatterns = [
      /\d+-year/, /\d+-home/, /\d+ RBI/, /\d+ runs/, /\d+ doubles/, 
      /20\d\d/ // years
    ];
    
    // First get all standalone numbers in the text
    const numberMatches = [];
    const numberRegex = /\b([0-9]{1,3})\b/g;
    let match;
    while ((match = numberRegex.exec(text)) !== null) {
      // Check if this number is in an excluded context
      const surroundingText = text.substring(
        Math.max(0, match.index - 10), 
        Math.min(text.length, match.index + match[0].length + 10)
      );
      
      const isExcluded = excludedPatterns.some(pattern => pattern.test(surroundingText));
      if (!isExcluded) {
        numberMatches.push(match[1]);
      }
    }
    
    // Prefer numbers that appear early in the text (likely card numbers) 
    // and avoid larger numbers (likely stats)
    if (numberMatches.length > 0) {
      // Sort by value (lower numbers first) and position (earlier in text first)
      const sortedNumbers = numberMatches.sort((a, b) => {
        // First compare the numeric values (prefer smaller numbers)
        const numA = parseInt(a);
        const numB = parseInt(b);
        if (numA !== numB) return numA - numB;
        
        // If same values, prefer the one that appears earlier in text
        return text.indexOf(a) - text.indexOf(b);
      });
      
      // Check if we've already identified whether this is a Chrome card
      const isChrome = text.includes("CHROME") || text.includes("CSMLB") || 
                       text.includes("TOPPS CHROME");
      const prefix = isChrome ? "CSMLB" : "SMLB";
      
      cardDetails.cardNumber = `${prefix}-${sortedNumbers[0]}`;
      console.log(`Constructed Stars of MLB card number from numeric part: ${cardDetails.cardNumber}`);
      
      // Set collection and handle Chrome as a variant
      cardDetails.collection = "Stars of MLB";
      if (isChrome) {
        cardDetails.variant = "Chrome";
      }
      cardDetails.brand = "Topps";
      return;
    }
    
    console.log('No Stars of MLB card number pattern detected.');
    return;
  }
  
  // For non-Stars of MLB cards, use the general patterns
  // Card number patterns to look for - enhanced with more formats
  const cardNumberPatterns = [
    // Special collection identifiers
    { regex: /\b(SMLB-\d{1,3})\b/i, format: "Stars of MLB", example: "SMLB-48", collection: "Stars of MLB" },
    { regex: /\b(CSMLB-\d{1,3})\b/i, format: "Chrome Stars of MLB", example: "CSMLB-12", collection: "Stars of MLB", variant: "Chrome" },
    { regex: /\b(HNT-\d{1,3}[A-Z]?)\b/i, format: "Heritage", example: "HNT-25B", collection: "Heritage" },
    { regex: /\b(SSP-\d{1,3})\b/i, format: "Super Short Print", example: "SSP-12" },
    { regex: /\b(AG-\d{1,3}[A-Z]?)\b/i, format: "Allen & Ginter", example: "AG-25", collection: "Allen & Ginter" },
    { regex: /\b(GQ-\d{1,3}[A-Z]?)\b/i, format: "Gypsy Queen", example: "GQ-237", collection: "Gypsy Queen" },
    { regex: /\b(TS\d-\d{1,3})\b/i, format: "Topps Series", example: "TS1-125", collection: "Series One" },
    { regex: /\b(TS1-\d{1,3})\b/i, format: "Topps Series 1", example: "TS1-125", collection: "Series One" },
    { regex: /\b(TS2-\d{1,3})\b/i, format: "Topps Series 2", example: "TS2-354", collection: "Series Two" },
    { regex: /\b(TSHRT-\d{1,3})\b/i, format: "Topps Short Print", example: "TSHRT-12" },
    { regex: /\b(TSSCT-\d{1,3})\b/i, format: "Topps Special Collection", example: "TSSCT-7" },
    
    // Baseball special formats
    { regex: /\b(\d{1,2}[Bb][^a-zA-Z0-9\s][0-9]{1,2})\b/, format: "35th Anniversary", example: "89B-9", collection: "35th Anniversary" },
    { regex: /\b(\d{1,2}[Bb]\d[-]?\d{1,2})\b/, format: "35th Anniversary", example: "89B2-32", collection: "35th Anniversary" },
    { regex: /\b(\d{1,2}[Bb][-]?\d{1,2})\b/, format: "35th Anniversary", example: "89B-32", collection: "35th Anniversary" },
    
    // Football/Basketball/Hockey specialized formats
    { regex: /\b([A-Z]{1,3}-\d{1,3}[A-Z]?)\b/, format: "Prefix-Number", example: "PZM-55" },
    { regex: /\b(PR-[A-Z]{2,3})\b/, format: "Prizm", example: "PR-LBJ", collection: "Prizm" },
    { regex: /\b([A-Z]{2}-[A-Z]{2,3})\b/, format: "Two-letter codes", example: "GS-SC" },
    { regex: /\b([A-Z]{2}-\d{1,3})\b/, format: "Set code", example: "RC-23" },
    
    // Team code formats
    { regex: /\b([A-Z]{3}[-]?\d{1,2})\b/, format: "Team code", example: "HOU-11" },
    
    // Autograph/jersey card formats
    { regex: /\b(A-[A-Z]{2,4})\b/, format: "Autograph", example: "A-MM" },
    { regex: /\b(AUTO-[A-Z]{2,4})\b/, format: "Autograph", example: "AUTO-TB" },
    { regex: /\b(J-[A-Z]{2,4})\b/, format: "Jersey", example: "J-KG" },
    { regex: /\b(JC-[A-Z]{2,4})\b/, format: "Jersey Card", example: "JC-JT" },
    { regex: /\b(GU-[A-Z]{2,4})\b/, format: "Game Used", example: "GU-MB" },
    { regex: /\b(RPJ-[A-Z]{2,4})\b/, format: "Rookie Patch", example: "RPJ-JH" },
    
    // Other common formats
    { regex: /\b(\d{1,3}[A-Z]{1,2}[0-9]{0,3})\b/, format: "Alphanumeric", example: "89BC" },
    { regex: /\b(\d{1,3}[A-Z]?\-\d{1,3})\b/, format: "Numbered with dash", example: "89-32" },
    { regex: /\b(CARD\s*\d{1,3})\b/i, format: "Card format", example: "CARD 27" },
    
    // Simple number formats - these should be last to avoid false positives
    { regex: /CARD ([0-9]{1,3})\b/i, format: "Card number", example: "Card 27" },
    { regex: /\bNO\.\s*([0-9]{1,3})\b/i, format: "No. format", example: "No. 35" },
    { regex: /\b#\s*([0-9]{1,3})\b/, format: "Hash format", example: "#47" },
    { regex: /\b(?:NO|CARD|NUMBER)\s*([0-9]{1,3})\b/i, format: "Named number", example: "NUMBER 123" },
    
    // Only use pure numbers as a last resort to avoid false matches
    { regex: /\b([0-9]{1,3})\b/, format: "Simple number", example: "42" }
  ];
  
  // Try each card number pattern
  for (const pattern of cardNumberPatterns) {
    const match = text.match(pattern.regex);
    if (match) {
      const detectedCardNumber = match[1];
      console.log(`Detected ${pattern.format} card number: ${detectedCardNumber} (example: ${pattern.example})`);
      
      // Set the card number
      cardDetails.cardNumber = detectedCardNumber;
      
      // Set collection from pattern if provided and not already set
      if (pattern.collection && !cardDetails.collection) {
        cardDetails.collection = pattern.collection;
        console.log(`Setting collection from card number pattern: ${pattern.collection}`);
      }
      
      // Set variant from pattern if provided and not already set
      if (pattern.variant && !cardDetails.variant) {
        cardDetails.variant = pattern.variant;
        console.log(`Setting variant from card number pattern: ${pattern.variant}`);
      }
      
      // Set collection for 35th Anniversary cards
      if (pattern.format === "35th Anniversary" && !cardDetails.collection) {
        cardDetails.collection = "35th Anniversary";
        cardDetails.brand = "Topps";
        cardDetails.year = 2024;
      }
      
      // For series cards with TS prefix, set brand to Topps if not already set
      if ((detectedCardNumber.startsWith('TS1-') || detectedCardNumber.startsWith('TS2-')) && !cardDetails.brand) {
        cardDetails.brand = "Topps";
      }
      
      // For Heritage cards with HNT prefix, set brand to Topps if not already set
      if (detectedCardNumber.startsWith('HNT-') && !cardDetails.brand) {
        cardDetails.brand = "Topps";
      }
      
      return;
    }
  }
  
  console.log('No card number pattern detected.');
}

/**
 * Extract card metadata (collection, brand, year) using context analysis
 */
function extractCardMetadata(text: string, cardDetails: Partial<CardFormValues>): void {
  // Brand detection with expanded list of card manufacturers and brands
  const brandPatterns = [
    // Major brands
    { regex: /\bTOPPS\b/, name: "Topps" },
    { regex: /\bUPPER\s*DECK\b/, name: "Upper Deck" },
    { regex: /\bPANINI\b/, name: "Panini" },
    { regex: /\bDONRUSS\b/, name: "Donruss" },
    { regex: /\bBOWMAN\b/, name: "Bowman" },
    { regex: /\bFLEER\b/, name: "Fleer" },
    
    // Additional brands
    { regex: /\bPRISTINE\b/, name: "Pristine" },
    { regex: /\bSCORE\b/, name: "Score" },
    { regex: /\bSAGE\b/, name: "Sage" },
    { regex: /\bLEAF\b/, name: "Leaf" },
    { regex: /\bFINEST\b/, name: "Finest" },
    { regex: /\bSELECT\b/, name: "Select" },
    { regex: /\bCONTENDERS\b/, name: "Contenders" },
    { regex: /\bPRISM\b/, name: "Prizm" },
    { regex: /\bCHRONICLES\b/, name: "Chronicles" },
    { regex: /\bOPTIC\b/, name: "Optic" },
    { regex: /\bMOSAIC\b/, name: "Mosaic" },
    { regex: /\bSTADIUM\s*CLUB\b/, name: "Stadium Club" },
    { regex: /\bHERITAGE\b/, name: "Heritage" },
    { regex: /\bTRIBUTE\b/, name: "Tribute" },
    { regex: /\bDYNASTY\b/, name: "Dynasty" },
    { regex: /\bABSOLUTE\b/, name: "Absolute" },
    { regex: /\bCLEAR\b/, name: "Clear" },
    { regex: /\bDIAMOND\s*KINGS\b/, name: "Diamond Kings" },
    { regex: /\bGOLD\s*LABEL\b/, name: "Gold Label" },
    { regex: /\bTRIPLE\s*THREADS\b/, name: "Triple Threads" },
    { regex: /\bFIVE\s*STAR\b/, name: "Five Star" },
    { regex: /\bSIGNATURE\s*SERIES\b/, name: "Signature Series" },
    { regex: /\bCERTIFIED\b/, name: "Certified" },
    { regex: /\bIMMACULATE\b/, name: "Immaculate" },
    { regex: /\bNATIONAL\s*TREASURES\b/, name: "National Treasures" },
    
    // Common OCR mistakes
    { regex: /\bTCPPS\b/, name: "Topps" },
    { regex: /\bLOPPS\b/, name: "Topps" },
    { regex: /\bLAPPS\b/, name: "Topps" },
    { regex: /\b(0|O)PTIC\b/i, name: "Optic" }
  ];
  
  // Try to detect brand
  for (const brand of brandPatterns) {
    if (brand.regex.test(text)) {
      cardDetails.brand = brand.name;
      console.log(`Detected brand: ${brand.name}`);
      break;
    }
  }
  
  // Collection detection with expanded patterns for different card sets
  const collectionPatterns = [
    // Baseball collections
    { regex: /\bSTARS\s*OF\s*MLB\b/, name: "Stars of MLB" },
    { regex: /\bSERIES\s*ONE\b|\bSERIES\s*1\b/, name: "Series One" },
    { regex: /\bSERIES\s*TWO\b|\bSERIES\s*2\b/, name: "Series Two" },
    { regex: /\bSERIES\s*THREE\b|\bSERIES\s*3\b/, name: "Series Three" },
    { regex: /\b35TH\s*ANNIVERSARY\b/, name: "35th Anniversary" },
    { regex: /\bHERITAGE\b/, name: "Heritage" },
    { regex: /\bTRIBUTE\b/, name: "Tribute" },
    { regex: /\bALLEN\s*(&|AND)?\s*GINTER\b|\bA&G\b/, name: "Allen & Ginter" },
    { regex: /\bGYPSY\s*QUEEN\b/, name: "Gypsy Queen" },
    { regex: /\bSTADIUM\s*CLUB\b/, name: "Stadium Club" },
    { regex: /\bFINEST\b/, name: "Finest" },
    { regex: /\bTRIPLE\s*THREADS\b/, name: "Triple Threads" },
    { regex: /\bCLEAR\b/, name: "Clear" },
    { regex: /\bFIVE\s*STAR\b/, name: "Five Star" },
    { regex: /\bBOWMAN\s*DRAFT\b/, name: "Bowman Draft" },
    { regex: /\bBOWMAN\s*CHROME\b/, name: "Bowman Chrome" },
    { regex: /\bUPDATE\s*SERIES\b/, name: "Update Series" },
    { regex: /\bOPENING\s*DAY\b/, name: "Opening Day" },
    
    // Football collections
    { regex: /\bPRISTINE\b/, name: "Pristine" },
    { regex: /\bPRISM\b/, name: "Prizm" },
    { regex: /\bCERTIFIED\b/, name: "Certified" },
    { regex: /\bSELECT\b/, name: "Select" },
    { regex: /\bPREST(I|l)GE\b/, name: "Prestige" },
    { regex: /\bSCORE\b/, name: "Score" },
    { regex: /\bPLAYBOOK\b/, name: "Playbook" },
    { regex: /\bCONTENDERS\b/, name: "Contenders" },
    { regex: /\bENDORSED\b/, name: "Endorsed" },
    { regex: /\bNATIONAL\s*TREASURES\b/, name: "National Treasures" },
    { regex: /\bLUXURY\s*SUITE\b/, name: "Luxury Suite" },
    { regex: /\bIMMACULATE\b|\bIMMACULATE\s*COLLECTION\b/, name: "Immaculate Collection" },
    { regex: /\bELITE\b|\bELITE\s*SERIES\b/, name: "Elite Series" },
    { regex: /\bGOLD\s*STANDARD\b/, name: "Gold Standard" },
    { regex: /\bABSOLUTE\b/, name: "Absolute" },
    { regex: /\bDONRUSS\s*ELITE\b/, name: "Donruss Elite" },
    { regex: /\bDONRUSS\s*OPTIC\b/, name: "Donruss Optic" },
    
    // Basketball collections
    { regex: /\bHOOPS\b/, name: "Hoops" },
    { regex: /\bPRIZM\b/, name: "Prizm" },
    { regex: /\bCOURT\s*KINGS\b/, name: "Court Kings" },
    { regex: /\bDONRUSS\b/, name: "Donruss" },
    { regex: /\bMOSAIC\b/, name: "Mosaic" },
    { regex: /\bREVOLUTION\b/, name: "Revolution" },
    { regex: /\bSTATUS\b/, name: "Status" },
    { regex: /\bFLAIR\b/, name: "Flair" },
    { regex: /\bCHRONICLES\b/, name: "Chronicles" },
    
    // Hockey collections
    { regex: /\bUPPER\s*DECK\s*SERIES\s*ONE\b|\bUD\s*SERIES\s*1\b/, name: "Upper Deck Series One" },
    { regex: /\bUPPER\s*DECK\s*SERIES\s*TWO\b|\bUD\s*SERIES\s*2\b/, name: "Upper Deck Series Two" },
    { regex: /\bSP\s*AUTHENTIC\b|\bSPA\b/, name: "SP Authentic" },
    { regex: /\bSP\s*GAME\s*USED\b/, name: "SP Game Used" },
    { regex: /\bO-PEE-CHEE\b|\bOPC\b/, name: "O-Pee-Chee" },
    { regex: /\bULTIMATE\s*COLLECTION\b/, name: "Ultimate Collection" },
    { regex: /\bCLEAR\s*CUT\b/, name: "Clear Cut" },
    { regex: /\bALLURE\b/, name: "Allure" },
    { regex: /\bPREMIER\b/, name: "Premier" },
    
    // Soccer collections
    { regex: /\bMATCH\s*ATTAX\b/, name: "Match Attax" },
    { regex: /\bSELECT\b/, name: "Select" },
    { regex: /\bPRIZM\b/, name: "Prizm" },
    { regex: /\bDONRUSS\b/, name: "Donruss" },
    { regex: /\bCHROME\b/, name: "Chrome" },
    { regex: /\bFINEST\b/, name: "Finest" },
    { regex: /\bSTADIUM\s*CLUB\b/, name: "Stadium Club" },
    { regex: /\bMERLIN\b/, name: "Merlin" }
  ];
  
  // Special case for Stars of MLB Collection
  if (text.includes("STARS") && text.includes("MLB")) {
    // STARS OF MLB specific rules per user's request
    console.log("Applying special rules for Stars of MLB collection");
    
    // Always set these defaults for Stars of MLB cards
    cardDetails.brand = "Topps";
    
    // Rule 1: Set collection to Stars of MLB for all cards in this set
    cardDetails.collection = "Stars of MLB";
    console.log("Set collection to Stars of MLB");
    
    // Rule 2: Detect Chrome variant by looking for "CHROME" text or "C" in card number
    const isChrome = 
      text.includes("CHROME") || 
      (cardDetails.cardNumber && cardDetails.cardNumber.startsWith("C")) ||
      text.includes("CSMLB");
    
    // Set Chrome as a variant instead of a separate collection
    if (isChrome) {
      cardDetails.variant = "Chrome";
      console.log("Detected Chrome variant for Stars of MLB card");
    }
    
    // Rule 2: For Stars of MLB, always check for copyright year which is more reliable
    const copyrightYearMatch = text.match(/[©Ⓒ®]\s*(?:&\s*[©Ⓒ®])?\s*(\d{4})/);
    if (copyrightYearMatch) {
      cardDetails.year = parseInt(copyrightYearMatch[1], 10);
      console.log(`Detected Stars of MLB copyright year: ${cardDetails.year}`);
    } else {
      // Default to 2024 for new Stars of MLB cards
      cardDetails.year = 2024;
      console.log("No year detected, defaulting to 2024 for Stars of MLB");
    }
    
    return; // Skip the rest of the function for Stars of MLB cards
  }
  
  // Try to detect collection for other card types
  for (const collection of collectionPatterns) {
    if (collection.regex.test(text)) {
      cardDetails.collection = collection.name;
      console.log(`Detected collection: ${collection.name}`);
      
      // Set default year for modern collections if not already set
      if (!cardDetails.year && (
          collection.name === "35th Anniversary" || 
          collection.name === "Series One" || 
          collection.name === "Series Two" ||
          collection.name === "Stars of MLB")) {
        cardDetails.year = 2024;
      }
      
      break;
    }
  }
  
  // Year detection - copyright symbol is most reliable for card year
  const yearPatterns = [
    { regex: /[©Ⓒ®]\s*(?:&\s*[©Ⓒ®])?\s*(\d{4})/, description: "Copyright year" },
    { regex: /\b(20\d{2})\b/, description: "Plain year" }
  ];
  
  // Try to detect year
  for (const pattern of yearPatterns) {
    const match = text.match(pattern.regex);
    if (match) {
      cardDetails.year = parseInt(match[1], 10);
      console.log(`Detected year (${pattern.description}): ${cardDetails.year}`);
      break;
    }
  }
  
  // Note: Sport detection is now handled in the main analyzeSportsCardImage function
}

/**
 * Extract serial number if present
 * 
 * IMPORTANT: Serial numbers should only be detected from specific locations on the card
 * - Serial numbers are typically imprinted in silver/foil in the bottom right corner of the card
 * - They have a format like "123/1000" or "123 OF 1000"
 * - This function should NOT set serial numbers detected from other parts of the card
 *   (like paragraph text that might mention "10 of 25 players" or similar)
 */
function extractSerialNumber(text: string, cardDetails: Partial<CardFormValues>): void {
  // ENHANCED APPROACH for serial number detection:
  // Since we don't have position data in this function, we need to be extremely cautious
  // about detecting serial numbers from card stats or other text that might match the pattern
  
  // We'll use contextual clues to increase accuracy:
  // 1. Serial numbers are almost always at the very end of the detected text
  // 2. They are typically preceded by spacing or special formatting
  // 3. They follow specific formats like NNN/NNN
  // 4. They are often paired with words like "NUMBERED" or "LIMITED EDITION"
  
  // Check for specific serial number formats with careful context validation
  
  // First, clean and prepare the text
  const lines = text.split('\n');
  const lastFewLines = lines.slice(-3); // Look only at last few lines
  const lastLineText = lastFewLines.join(' ');
  
  // Check if there are strong serial number indicator phrases
  const hasSerialIndicators = /NUMBERED|LIMITED|SERIAL|EDITION OF|\/\d+$|OF \d+$/.test(lastLineText);
  
  if (hasSerialIndicators) {
    console.log('Found potential serial number indicators in last lines');
    
    // Different serial number patterns to try
    const serialPatterns = [
      // Format: 123/999
      { regex: /(\d{1,4})\s*\/\s*(\d{1,4})(?!\d)/, format: "fraction" },
      
      // Format: 123 OF 999
      { regex: /(\d{1,4})\s+OF\s+(\d{1,4})(?!\d)/i, format: "of text" },
      
      // Format: NUMBERED TO 999 (for cards like "1 of 1" that don't show the serial)
      { regex: /NUMBERED\s+TO\s+(\d{1,4})(?!\d)/i, format: "numbered to" },
      
      // Format: LIMITED EDITION xxx/xxx
      { regex: /LIMITED\s+EDITION\s+(\d{1,4})\s*\/\s*(\d{1,4})(?!\d)/i, format: "limited edition" },
      
      // Format: xxx/xxx written very explicitly to avoid false positives
      { regex: /^(\d{1,4})\s*\/\s*(\d{1,4})$/, format: "standalone fraction" }
    ];
    
    for (const pattern of serialPatterns) {
      const match = lastLineText.match(pattern.regex);
      
      if (match) {
        console.log(`Detected serial number (${pattern.format} format)`);
        
        // For formats with both numerator and denominator
        if (pattern.format === "fraction" || pattern.format === "of text" || 
            pattern.format === "limited edition" || pattern.format === "standalone fraction") {
          
          const serialNumber = match[1];
          const totalCards = match[2];
          cardDetails.serialNumber = `${serialNumber}/${totalCards}`;
          console.log(`Set serial number: ${cardDetails.serialNumber}`);
          return;
        }
        
        // For "numbered to" format
        if (pattern.format === "numbered to") {
          // We don't know the actual serial number, just the print run
          const totalCards = match[1];
          // Use a placeholder indicating it's one of a limited run
          cardDetails.serialNumber = `x/${totalCards}`;
          console.log(`Set approximate serial number: ${cardDetails.serialNumber}`);
          return;
        }
      }
    }
  }
  
  // No valid serial number found
  console.log('No reliable serial number found in plain text analysis');
}

/**
 * Detect special card features (rookie, autograph, etc.)
 */
function detectCardFeatures(text: string, cardDetails: Partial<CardFormValues>): void {
  // Enhanced Rookie card detection
  // Look for any of these common rookie indicators on cards
  const rookieIndicators = [
    'ROOKIE', 'RC', 'R.C.', 'FIRST YEAR', 'DEBUT', 
    'ROOKIE CARD', '1ST YEAR', 'FIRST MLB', '1ST MLB'
  ];
  
  // Check if any rookie indicator is present in the text
  const hasRookieIndicator = rookieIndicators.some(indicator => 
    text.includes(indicator)
  );
  
  if (hasRookieIndicator) {
    cardDetails.isRookieCard = true;
    console.log('Detected rookie card indicator');
  }
  
  // Autograph detection
  if (text.includes('AUTO') || text.includes('AUTOGRAPH') || text.includes('SIGNED') || 
      text.includes('SIGNATURE') || text.includes('CERTIFIED AUTOGRAPH')) {
    cardDetails.isAutographed = true;
    console.log('Detected autographed card');
  }
  
  // Numbered card detection (if we didn't already find a serial number)
  if (!cardDetails.isNumbered && 
      (text.includes('NUMBERED') || text.includes('LIMITED EDITION'))) {
    cardDetails.isNumbered = true;
    console.log('Detected numbered card (from keywords)');
  }
  
  // Variant detection
  const variants = [
    { keyword: 'REFRACTOR', name: 'Refractor' },
    { keyword: 'PARALLEL', name: 'Parallel' },
    { keyword: 'HOLOGRAM', name: 'Hologram' },
    { keyword: 'PRIZM', name: 'Prizm' },
    { keyword: 'FOIL', name: 'Foil' },
    { keyword: 'GOLD', name: 'Gold' },
    { keyword: 'SILVER', name: 'Silver' },
    { keyword: 'CHROME', name: 'Chrome' }
  ];
  
  for (const variant of variants) {
    if (text.includes(variant.keyword)) {
      cardDetails.variant = variant.name;
      console.log(`Detected variant: ${variant.name}`);
      break;
    }
  }
}