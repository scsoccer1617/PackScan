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
    
    // IMPROVED SPORT DETECTION WITH WEIGHTED SCORING SYSTEM
    // This system uses a points-based approach to determine the most likely sport
    // by counting specific keywords for each sport in the text
    
    // First, check for explicit sport indicators that should override everything else
    if (cleanText.match(/\bBASEBALL CARD\b|\bMAJOR LEAGUE BASEBALL\b|\bMLB\b/i)) {
      cardDetails.sport = "Baseball";
      console.log("Sport detected (explicit indicator): Baseball");
      return; // Skip further sport detection
    } 
    else if (cleanText.match(/\bFOOTBALL CARD\b|\bNATIONAL FOOTBALL LEAGUE\b|\bNFL\b/i)) {
      cardDetails.sport = "Football";
      console.log("Sport detected (explicit indicator): Football");
      return; // Skip further sport detection
    } 
    else if (cleanText.match(/\bBASKETBALL CARD\b|\bNATIONAL BASKETBALL ASSOCIATION\b|\bNBA\b/i)) {
      cardDetails.sport = "Basketball";
      console.log("Sport detected (explicit indicator): Basketball");
      return; // Skip further sport detection
    } 
    else if (cleanText.match(/\bHOCKEY CARD\b|\bNATIONAL HOCKEY LEAGUE\b|\bNHL\b/i)) {
      cardDetails.sport = "Hockey";
      console.log("Sport detected (explicit indicator): Hockey");
      return; // Skip further sport detection
    } 
    else if (cleanText.match(/\bSOCCER CARD\b|\bMAJOR LEAGUE SOCCER\b|\bMLS\b|\bFIFA\b/i)) {
      cardDetails.sport = "Soccer";
      console.log("Sport detected (explicit indicator): Soccer");
      return; // Skip further sport detection
    }
    
    // For card collections with known sports
    if (cleanText.includes("STARS OF MLB") || cleanText.includes("SMLB-")) {
      cardDetails.sport = "Baseball";
      console.log("Sport detected (from collection): Baseball");
      return;
    }
    
    // Initialize scores for each sport
    let baseballScore = 0;
    let footballScore = 0; 
    let basketballScore = 0;
    let hockeyScore = 0;
    let soccerScore = 0;
    
    // BASEBALL KEYWORDS WITH WEIGHTS
    const baseballKeywords = [
      // Strong indicators (3 points)
      { term: /\bMLB\b|\bMAJOR LEAGUE BASEBALL\b/i, weight: 3 },
      { term: /\bBASEBALL\b/i, weight: 3 },
      { term: /\bWORLD SERIES\b/i, weight: 3 },
      
      // Team names (2 points)
      { term: /\bYANKEES\b|\bRED SOX\b|\bDODGERS\b|\bCUBS\b|\bGIANTS\b|\bCARDINALS\b|\bBRAVES\b|\bASTROS\b|\bPHILLIES\b|\bNATIONALS\b|\bMETS\b|\bBLUE JAYS\b|\bANGELS\b|\bRANGERS\b|\bMARINERS\b|\bROYALS\b|\bMARLINS\b|\bOAKLAND A'S\b|\bATHLETICS\b|\bTWINS\b|\bBREWERS\b|\bGUARDIANS\b|\bINDIANS\b|\bPIRATES\b|\bPADRES\b|\bRAYS\b|\bORIOLES\b|\bROCKIES\b|\bDIAMONDBACKS\b|\bWHITE SOX\b|\bREDS\b|\bTIGERS\b/i, weight: 2 },
      
      // Positions (2 points)
      { term: /\bPITCHER\b|\bCATCHER\b|\bFIRST BASE\b|\bSECOND BASE\b|\bTHIRD BASE\b|\bSHORTSTOP\b|\bOUTFIELDER\b|\bINFIELDER\b|\bDESIGNATED HITTER\b/i, weight: 2 },
      { term: /\b1B\b|\b2B\b|\b3B\b|\bSS\b|\bOF\b|\bLF\b|\bCF\b|\bRF\b|\bDH\b/i, weight: 2 },
      
      // Baseball terms (1 point)
      { term: /\bHOME RUN\b|\bHOMERUN\b|\bRBI\b|\bERN\b|\bBATTING\b|\bPITCHING\b|\bHITTER\b|\bMOUND\b|\bINNING\b|\bBULLPEN\b|\bBAT\b|\bGLOVE\b/i, weight: 1 },
      { term: /\bMLB DEBUT\b|\bROOKIE CARD\b|\bALL[\s-]STAR\b/i, weight: 1 }
    ];
    
    // FOOTBALL KEYWORDS WITH WEIGHTS
    const footballKeywords = [
      // Strong indicators (3 points)
      { term: /\bNFL\b|\bNATIONAL FOOTBALL LEAGUE\b/i, weight: 3 },
      { term: /\bFOOTBALL\b/i, weight: 3 },
      { term: /\bSUPER BOWL\b/i, weight: 3 },
      
      // Team names (2 points)
      { term: /\bCOWBOYS\b|\bPACKERS\b|\bPATRIOTS\b|\b49ERS\b|\bSTEELERS\b|\bCHIEFS\b|\bRAIDERS\b|\bEAGLES\b|\bBEARS\b|\bVIKINGS\b|\bRAMS\b|\bSEAHAWKS\b|\bBUCCANEERS\b|\bBRONCOS\b|\bSAINTS\b|\bPANTHERS\b|\bCHARGERS\b|\bBENGALS\b|\bBILLS\b|\bTITANS\b|\bLIONS\b|\bJETS\b|\bGIANTS\b|\bDOLPHINS\b|\bRAVENS\b|\bCOLTS\b|\bBROWNS\b|\bCARDINALS\b|\bCOMMANDERS\b|\bFALCONS\b|\bJAGUARS\b|\bTEXANS\b/i, weight: 2 },
      
      // Positions (2 points - make sure we have word boundaries to avoid false matches)
      { term: /\bQUARTERBACK\b|\bQB\b|\bRUNNING BACK\b|\bRB\b|\bWIDE RECEIVER\b|\bWR\b|\bTIGHT END\b|\bTE\b|\bOFFENSIVE LINE\b|\bDEFENSIVE LINE\b|\bLINEBACKER\b|\bCORNERBACK\b|\bSAFETY\b|\bKICKER\b|\bPUNTER\b/i, weight: 2 },
      
      // Football terms (1 point)
      { term: /\bTOUCHDOWN\b|\bTD\b|\bFIELD GOAL\b|\bTACKLE\b|\bSACK\b|\bBLITZ\b|\bINTERCEPTION\b|\bPASS\b|\bRUSH\b|\bYARDS\b|\bYARDAGE\b|\bDRAFT PICK\b/i, weight: 1 }
    ];
    
    // BASKETBALL KEYWORDS WITH WEIGHTS
    const basketballKeywords = [
      // Strong indicators (3 points)
      { term: /\bNBA\b|\bNATIONAL BASKETBALL ASSOCIATION\b/i, weight: 3 },
      { term: /\bBASKETBALL\b/i, weight: 3 },
      { term: /\bNBA FINALS\b/i, weight: 3 },
      
      // Team names (2 points)
      { term: /\bLAKERS\b|\bCELTICS\b|\bBULLS\b|\bWARRIORS\b|\bSPURS\b|\bHEAT\b|\bMAVERICKS\b|\bBUCKS\b|\bKNICKS\b|\bNETS\b|\bROCKETS\b|\bCLIPPERS\b|\b76ERS\b|\bSIXERS\b|\bSUNS\b|\bTHUNDER\b|\bJAZZ\b|\bTRAIL BLAZERS\b|\bGRIZZLIES\b|\bHAWKS\b|\bTIMBERWOLVES\b|\bPELICANS\b|\bNUGGETS\b|\bHORNETS\b|\bKINGS\b|\bPACERS\b|\bPISTONS\b|\bMAGIC\b|\bWIZARDS\b|\bRAPTORS\b/i, weight: 2 },
      
      // Positions (2 points)
      { term: /\bPOINT GUARD\b|\bPG\b|\bSHOOTING GUARD\b|\bSG\b|\bSMALL FORWARD\b|\bSF\b|\bPOWER FORWARD\b|\bPF\b|\bCENTER\b|\bWING\b/i, weight: 2 },
      
      // Basketball terms (1 point)
      { term: /\bSLAM DUNK\b|\bTHREE[\s-]POINTER\b|\bREBOUND\b|\bASSIST\b|\bSTEAL\b|\bBLOCK\b|\bFREE THROW\b|\bJUMP SHOT\b|\bLAYUP\b|\bCOURT\b|\bHOOP\b|\bBACKBOARD\b/i, weight: 1 }
    ];
    
    // HOCKEY KEYWORDS WITH WEIGHTS
    const hockeyKeywords = [
      // Strong indicators (3 points)
      { term: /\bNHL\b|\bNATIONAL HOCKEY LEAGUE\b/i, weight: 3 },
      { term: /\bHOCKEY\b/i, weight: 3 },
      { term: /\bSTANLEY CUP\b/i, weight: 3 },
      
      // Team names (2 points)
      { term: /\bBRUINS\b|\bBLACKHAWKS\b|\bRED WINGS\b|\bMAP(LE)? LEAFS\b|\bCANADIENS\b|\bPENGUINS\b|\bRANGERS\b|\bLIGHTNING\b|\bFLYERS\b|\bKINGS\b|\bOILERS\b|\bCANUCKS\b|\bDEVILS\b|\bISLANDERS\b|\bGOLDEN KNIGHTS\b|\bFLAMES\b|\bBLUES\b|\bCANES\b|\bHURRICANES\b|\bDALLAS STARS\b|\bSTARS\b|\bSENATORS\b|\bSABRES\b|\bWILD\b|\bDUCKS\b|\bPREDATORS\b|\bAVALANCHE\b|\bSHARKS\b|\bBLUE JACKETS\b|\bJETS\b|\bKRAKEN\b/i, weight: 2 },
      
      // Positions (2 points)
      { term: /\bGOALIE\b|\bGOALTENDER\b|\bCENTER\b|\bWINGER\b|\bDEFENSEMAN\b|\bLEFT WING\b|\bRIGHT WING\b|\bLW\b|\bRW\b|\bD\b|\bG\b/i, weight: 2 },
      
      // Hockey terms (1 point)
      { term: /\bPUCK\b|\bSTICK\b|\bICE\b|\bRINK\b|\bNET\b|\bGOAL\b|\bASSIST\b|\bSAVE\b|\bSAVE PERCENTAGE\b|\bPENALTY\b|\bPENALTY BOX\b|\bPOWER PLAY\b|\bSHORT HANDED\b|\bHAT TRICK\b/i, weight: 1 }
    ];
    
    // SOCCER KEYWORDS WITH WEIGHTS
    const soccerKeywords = [
      // Strong indicators (3 points)
      { term: /\bFIFA\b|\bMLS\b|\bMAJOR LEAGUE SOCCER\b|\bSOCCER\b/i, weight: 3 },
      { term: /\bWORLD CUP\b|\bPREMIER LEAGUE\b|\bLA LIGA\b|\bBUNDESLIGA\b|\bSERIE A\b|\bLIGUE 1\b/i, weight: 3 },
      
      // Team names (2 points)
      { term: /\bREAL MADRID\b|\bBARCELONA\b|\bMAN UNITED\b|\bMANCHESTER UNITED\b|\bMANCHESTER CITY\b|\bLIVERPOOL\b|\bCHELSEA\b|\bARSENAL\b|\bJUVENTUS\b|\bBAYERN\b|\bPSG\b|\bAC MILAN\b|\bINTER\b|\bATLETICO\b|\bBOCA JUNIORS\b|\bRIVER PLATE\b|\bGALAXY\b|\bSEATTLE SOUNDERS\b|\bINTER MIAMI\b|\bATLANTA UNITED\b/i, weight: 2 },
      
      // Positions (2 points)
      { term: /\bGOALKEEPER\b|\bGK\b|\bDEFENDER\b|\bMIDFIELDER\b|\bFORWARD\b|\bSTRIKER\b|\bWINGER\b|\bSWEEPER\b/i, weight: 2 },
      
      // Soccer terms (1 point)
      { term: /\bGOAL\b|\bCLEAN SHEET\b|\bYELLOW CARD\b|\bRED CARD\b|\bFREE KICK\b|\bPENALTY KICK\b|\bCORNER\b|\bOFFSIDE\b|\bPITCH\b|\bSTOPPAGE TIME\b|\bSTRIKE\b/i, weight: 1 }
    ];
    
    // Calculate scores for each sport
    for (const keyword of baseballKeywords) {
      if (cleanText.match(keyword.term)) {
        baseballScore += keyword.weight;
      }
    }
    
    for (const keyword of footballKeywords) {
      if (cleanText.match(keyword.term)) {
        footballScore += keyword.weight;
      }
    }
    
    for (const keyword of basketballKeywords) {
      if (cleanText.match(keyword.term)) {
        basketballScore += keyword.weight;
      }
    }
    
    for (const keyword of hockeyKeywords) {
      if (cleanText.match(keyword.term)) {
        hockeyScore += keyword.weight;
      }
    }
    
    for (const keyword of soccerKeywords) {
      if (cleanText.match(keyword.term)) {
        soccerScore += keyword.weight;
      }
    }
    
    // Determine the sport with the highest score
    const sportScores = [
      { sport: "Baseball", score: baseballScore },
      { sport: "Football", score: footballScore },
      { sport: "Basketball", score: basketballScore },
      { sport: "Hockey", score: hockeyScore },
      { sport: "Soccer", score: soccerScore }
    ];
    
    // Sort by score (highest first)
    sportScores.sort((a, b) => b.score - a.score);
    
    // Log scores for debugging
    console.log("Sport detection scores:", sportScores.map(s => `${s.sport}: ${s.score}`).join(", "));
    
    // If highest score is zero, default to Baseball
    if (sportScores[0].score === 0) {
      cardDetails.sport = "Baseball"; // Default
      console.log("No sport indicators found, defaulting to Baseball");
    } else {
      // Use sport with highest score
      cardDetails.sport = sportScores[0].sport;
      console.log(`Sport detected with highest score (${sportScores[0].score}): ${cardDetails.sport}`);
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
  
  // ENHANCED PLAYER NAME DETECTION
  // For non-Stars of MLB cards, use a more sophisticated approach
  
  // Common sports terms that might be in the text (not player-specific)
  const sportKeywords = [
    'BASEBALL', 'FOOTBALL', 'BASKETBALL', 'HOCKEY', 'SOCCER', 
    'MLB', 'NFL', 'NBA', 'NHL', 'MLS', 'FIFA',
    'PITCHER', 'CATCHER', 'OUTFIELDER', 'INFIELDER', 'SHORTSTOP', 'QUARTERBACK',
    'WIDE RECEIVER', 'RUNNING BACK', 'GOALIE'
  ];
  
  // Brand names and card terminology to exclude 
  const excludedTerms = [
    // Card companies
    'TOPPS', 'PANINI', 'BOWMAN', 'UPPER DECK', 'FLEER', 'DONRUSS', 'LEAF', 
    'SCORE', 'PLAYOFF', 'PACIFIC', 'SAGE', 'FINEST', 'SELECT', 
    
    // Standard card text
    'TRADING CARD', 'BASEBALL CARD', 'FOOTBALL CARD', 'BASKETBALL CARD',
    'ROOKIE CARD', 'FUTURE STAR', 'ALL STAR', 'MVP', 'CHAMPION',
    
    // Leagues and organizations
    'MAJOR LEAGUE', 'BASEBALL', 'NATIONAL LEAGUE', 'AMERICAN LEAGUE',
    'WORLD SERIES', 'HALL OF FAME', 'ALL-STAR',
    
    // Collection names
    'CHROME', 'HERITAGE', 'STARS OF MLB', 'PRIZM', 'SERIES ONE', 'SERIES TWO'
  ];
  
  // Special case: Identify a copyright line (to avoid extracting names from it)
  const copyrightMatch = text.match(/©|Ⓒ|\([cC]\)/);
  const copyrightLine = copyrightMatch && copyrightMatch.index !== undefined ? 
    text.substring(copyrightMatch.index).split('\n')[0] : '';
  
  // Clean the text for better name extraction
  let cleanText = text
    // Remove copyright line from consideration
    .replace(copyrightLine, '')
    // Remove card numbers to avoid confusion
    .replace(/\b(CARD|NO\.)\s*\d+\b/ig, '')
    // Remove common text prefixes often on cards
    .replace(/^(TOPPS|BOWMAN|PANINI|DONRUSS|UPPER DECK)\s+/i, '')
    // Remove obvious non-name parts
    .replace(/\b(MLB|NFL|NBA|NHL|ROOKIE|RC)\b/g, '');
    
  // Split into lines for better analysis
  const lines = cleanText.split('\n').filter(line => line.trim() !== '');
  
  // Approach 1: Examine the first line, which often contains the player name
  if (lines.length > 0) {
    const firstLine = lines[0].trim();
    const firstLineWords = firstLine.split(/\s+/);
    
    // If first line has 2-3 words (typical for "FirstName LastName")
    if (firstLineWords.length >= 2 && firstLineWords.length <= 3) {
      // Check if none of the words are excluded terms
      const isValidName = !firstLineWords.some(word => 
        excludedTerms.some(term => term.includes(word) || word.includes(term))
      );
      
      // Check if words appear to be names (start with capital, no numbers, reasonable length)
      const wordLooksLikeName = (word: string) => 
        word.length > 1 && 
        /^[A-Z]/.test(word) && 
        !/\d/.test(word) && 
        word.length < 15;
        
      if (isValidName && firstLineWords.every(wordLooksLikeName)) {
        cardDetails.playerFirstName = firstLineWords[0].toLowerCase()
          .split(' ')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
          .join(' ');
          
        cardDetails.playerLastName = firstLineWords.slice(1).join(' ').toLowerCase()
          .split(' ')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
          .join(' ');
        
        console.log(`Detected player name from first line: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
        return;
      }
    }
  }
  
  // Approach 2: Look for name patterns in the entire text
  // Define a regex pattern that looks for potential names - Two capitalized words in sequence
  const nameRegex = /\b([A-Z][a-zA-Z']{1,20})\s+([A-Z][a-zA-Z'-]{1,20})\b/g;
  
  // Use Array.from instead of spread operator for better TypeScript compatibility
  const nameMatches = Array.from(cleanText.matchAll(nameRegex));
  
  for (const match of nameMatches) {
    const firstName = match[1];
    const lastName = match[2];
    
    // Skip if either part matches excluded terms
    const isExcluded = excludedTerms.some(term => 
      firstName.includes(term) || lastName.includes(term) ||
      term.includes(firstName) || term.includes(lastName)
    );
    
    // Skip if either part matches sport keywords
    const isSportTerm = sportKeywords.some(term => 
      firstName.includes(term) || lastName.includes(term) ||
      term.includes(firstName) || term.includes(lastName)
    );
    
    if (!isExcluded && !isSportTerm && firstName !== lastName) {
      cardDetails.playerFirstName = firstName.toLowerCase()
        .split(' ')
        .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
        
      cardDetails.playerLastName = lastName.toLowerCase()
        .split(' ')
        .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
      
      console.log(`Detected player name from name pattern: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
      return;
    }
  }
  
  // Approach 3: Try to find player name using positional analysis 
  // Player names are often positioned near a team name or position indicator
  
  // Expanded list of MLB teams
  const mlbTeams = [
    'YANKEES', 'RED SOX', 'DODGERS', 'CUBS', 'ANGELS', 'BRAVES', 'TWINS', 'PADRES', 'BREWERS',
    'ASTROS', 'MARINERS', 'CARDINALS', 'BLUE JAYS', 'ORIOLES', 'RANGERS', 'METS', 'PHILLIES',
    'NATIONALS', 'MARLINS', 'PIRATES', 'REDS', 'DIAMONDBACKS', 'ROCKIES', 'GIANTS', 'ATHLETICS',
    'WHITE SOX', 'ROYALS', 'TIGERS', 'GUARDIANS', 'RAYS'
  ];
  
  // Expanded list of positions across sports
  const positions = [
    // Baseball
    'PITCHER', 'CATCHER', 'INFIELDER', 'OUTFIELDER', 'SHORTSTOP', 'FIRST BASE', 'SECOND BASE', 
    'THIRD BASE', 'LEFT FIELD', 'RIGHT FIELD', 'CENTER FIELD', 'DESIGNATED HITTER',
    
    // Other sports positions
    'QUARTERBACK', 'RUNNING BACK', 'WIDE RECEIVER', 'TIGHT END', 'LINEBACKER', 'CORNERBACK',
    'SAFETY', 'KICKER', 'PUNTER', 'GUARD', 'FORWARD', 'CENTER', 'POINT GUARD', 'SHOOTING GUARD',
    'GOALIE', 'DEFENSEMAN', 'LEFT WING', 'RIGHT WING'
  ];
  
  // Search for a team name or position, then look for nearby words that might be a player name
  for (const keyword of [...mlbTeams, ...positions]) {
    if (text.includes(keyword)) {
      const index = text.indexOf(keyword);
      const beforeKeyword = text.substring(0, index).trim().split(/\s+/);
      
      // Take the last few words before the team/position as the potential name
      if (beforeKeyword.length >= 2) {
        const firstName = beforeKeyword[beforeKeyword.length - 2];
        const lastName = beforeKeyword[beforeKeyword.length - 1];
        
        // Skip if undefined or empty strings
        if (!firstName || !lastName || firstName.length < 2 || lastName.length < 2) {
          continue;
        }
        
        // Basic validation
        const isValidNamePart = (part: string) => {
          return part.length >= 2 && // Reasonable length
                 /^[A-Z]/.test(part) && // Starts with capital letter
                 !/[0-9*#@<>]/.test(part) && // No digits or special chars
                 !/MLB|NFL|NBA|NHL/.test(part); // Not a league abbreviation
        };
        
        // Check if either part matches excluded terms
        const isExcluded = excludedTerms.some(term => 
          firstName.includes(term) || lastName.includes(term) ||
          term.includes(firstName) || term.includes(lastName)
        );
        
        // Skip if either part matches sport keywords
        const isSportTerm = sportKeywords.some(term => 
          firstName.includes(term) || lastName.includes(term) ||
          term.includes(firstName) || term.includes(lastName)
        );
        
        if (isValidNamePart(firstName) && isValidNamePart(lastName) && !isExcluded && !isSportTerm) {
          cardDetails.playerFirstName = firstName.toLowerCase()
            .split(' ')
            .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
            
          cardDetails.playerLastName = lastName.toLowerCase()
            .split(' ')
            .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
          
          console.log(`Detected player name near team/position: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
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
  
  // ENHANCED YEAR DETECTION WITH COPYRIGHT PRIORITIZATION
  // Year detection with sophisticated patterns focusing on copyright year
  const yearPatterns = [
    // Copyright symbol patterns - highest priority as these are the most reliable
    { regex: /[©Ⓒ]\s*(?:&\s*[©Ⓒ])?\s*((?:19|20)\d{2})/, description: "Copyright symbol year", priority: 1 },
    { regex: /[©Ⓒ](?:&[©Ⓒ])?\s*(?:TOPPS|MLB|NFL|NBA|NHL).*?((?:19|20)\d{2})/, description: "Copyright with brand year", priority: 1 },
    { regex: /&[©Ⓒ]\s*((?:19|20)\d{2})/, description: "Ampersand copyright year", priority: 1 },
    
    // Text-based copyright indicators
    { regex: /COPYRIGHT\s*((?:19|20)\d{2})/, description: "Copyright text", priority: 2 },
    { regex: /\bCOPR\.\s*((?:19|20)\d{2})/, description: "Copr. abbreviation", priority: 2 },
    { regex: /\(C\)\s*((?:19|20)\d{2})/, description: "Parentheses C year", priority: 2 },
    
    // Company info with year
    { regex: /(?:TOPPS|PANINI|DONRUSS|UPPER DECK|FLEER|BOWMAN).*?(?:COMPANY|INC).*?((?:19|20)\d{2})/, description: "Company copyright", priority: 3 },
    { regex: /(?:THE TOPPS COMPANY).*?((?:19|20)\d{2})/, description: "Topps Company year", priority: 3 },
    
    // Collection year patterns
    { regex: /\b((?:19|20)\d{2})\s+(?:TOPPS|BOWMAN|PANINI|DONRUSS|UPPER DECK|FLEER)\b/, description: "Year + brand", priority: 4 },
    { regex: /\b(?:TOPPS|BOWMAN|PANINI|DONRUSS|UPPER DECK|FLEER)\s+((?:19|20)\d{2})\b/, description: "Brand + year", priority: 4 },
    
    // Card set years in names
    { regex: /\b((?:19|20)\d{2})\s+(?:SERIES|UPDATE|CHROME|HERITAGE|PRIZM|OPTIC)\b/, description: "Year + collection", priority: 5 },
    { regex: /\b(?:SERIES|UPDATE|CHROME|HERITAGE|PRIZM|OPTIC)\s+((?:19|20)\d{2})\b/, description: "Collection + year", priority: 5 },
    
    // Years with specific context
    { regex: /\b((?:19|20)\d{2})\s+(?:EDITION|COLLECTION)\b/, description: "Year edition", priority: 6 },
    { regex: /\b((?:19|20)\d{2})\s+(?:SEASON|STATS|STATISTICS)\b/, description: "Year season", priority: 7 },
    { regex: /\bROOKIE.*?((?:19|20)\d{2})/, description: "Rookie year", priority: 7 },
    
    // Special location pattern - years at the end of text are often copyright years
    { regex: /((?:19|20)\d{2})(?:.{0,20})$/, description: "Year near end of text", priority: 8 },
    
    // Standalone year as a last resort
    { regex: /\b((?:19|20)\d{2})\b/, description: "Plain year", priority: 9 }
  ];
  
  // Sort patterns by priority (lower = higher priority)
  const sortedPatterns = [...yearPatterns].sort((a, b) => a.priority - b.priority);
  
  // Try to detect year with priority order - with enhanced copyright detection
  // First, specifically search for copyright year pattern with logging to help troubleshoot
  let copyrightText = '';
  const copyrightPattern = /(?:[©Ⓒ&]|COPYRIGHT|COPR\.|THE TOPPS COMPANY|PANINI).*?((?:19|20)\d{2})/i;
  const copyrightMatch = text.match(copyrightPattern);
  
  if (copyrightMatch) {
    const fullMatch = copyrightMatch[0];
    const copyrightYear = parseInt(copyrightMatch[1], 10);
    const currentYear = new Date().getFullYear();
    
    // Log the full copyright text for debugging
    copyrightText = fullMatch.trim();
    console.log(`Detected copyright text: "${copyrightText}"`);
    
    // If year is valid, use it directly
    if (copyrightYear >= 1950 && copyrightYear <= currentYear + 1) {
      cardDetails.year = copyrightYear;
      console.log(`Using copyright year as card date: ${cardDetails.year}`);
      // Skip the general pattern matching since we found a high-confidence copyright year
      return;
    }
  }
  
  // Fall back to the regular priority-based pattern matching if no copyright year was found
  for (const pattern of sortedPatterns) {
    const match = text.match(pattern.regex);
    if (match) {
      const year = parseInt(match[1], 10);
      
      // Validate the detected year (must be between 1950 and current year + 1)
      const currentYear = new Date().getFullYear();
      if (year >= 1950 && year <= currentYear + 1) {
        cardDetails.year = year;
        console.log(`Detected year (${pattern.description}): ${cardDetails.year} (priority: ${pattern.priority})`);
        break;
      }
    }
  }
  
  // If no year detected, make an educated guess based on card appearance 
  // and copyright year patterns
  if (!cardDetails.year) {
    // Check for modern-era copyright pattern which often has © YEAR MLB
    const modernCopyrightMatch = text.match(/[©Ⓒ®]\s*(?:20\d{2})?\s*MLB/i);
    if (modernCopyrightMatch) {
      // Most likely a recent card, default to latest common year
      cardDetails.year = 2024;
      console.log('No specific year detected, but found modern MLB copyright format. Using default year 2024.');
    }
    // For heritage/throwback cards, detect years from common vintage year sets
    else if (text.includes('HERITAGE') && text.match(/\b(19\d{2})\b/)) {
      const vintageYearMatch = text.match(/\b(19\d{2})\b/);
      if (vintageYearMatch) {
        // For heritage cards, set the current production year (not the vintage year)
        cardDetails.year = 2024;
        console.log(`Heritage card referencing vintage year ${vintageYearMatch[1]}, using current production year 2024.`);
      }
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
  // ENHANCED ROOKIE CARD DETECTION
  // Look for any of these common rookie indicators on cards with expanded terminology
  const rookieIndicators = [
    // Standard rookie indicators
    'ROOKIE', 'RC', 'R.C.', 'FIRST YEAR', 'DEBUT', 
    'ROOKIE CARD', '1ST YEAR', 'FIRST MLB', '1ST MLB',
    
    // Sport-specific rookie indicators
    'NFL DEBUT', 'MLB DEBUT', 'NBA DEBUT', 'NHL DEBUT',
    'FRESHMAN', 'FUTURE STARS', 'PROSPECT',
    
    // Card-specific rookie indicators
    'RATED ROOKIE', 'TRUE ROOKIE', 'ROOKIE DEBUT',
    
    // Brand-specific rookie indicators
    'BOWMAN 1ST', 'BOWMAN 1ST CARD', 'BOWMAN ROOKIE',
    'TOPPS RC', 'TOPPS ROOKIE', 'PANINI RC', 
    'DONRUSS RATED ROOKIE'
  ];
  
  // More precise rookie detection - look for specific boundaries
  // to ensure we don't match substrings inside other words
  const hasStrongRookieIndicator = rookieIndicators.some(indicator => {
    // Convert indicator to regex-safe string by escaping special characters
    const escapedIndicator = indicator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // Check for either:
    // - Exact match with word boundaries
    // - Match inside brackets/graphics like [RC] or {RC}
    // - Match with a colon after it like "RC:"
    const regexPattern = new RegExp(`(^|[\\s\\[\\{\\(])${escapedIndicator}($|[\\s\\]\\}\\)\\:])`, 'i');
    return regexPattern.test(text);
  });
  
  // Also check for the RC logo that appears in recent cards
  // This is usually printed as "RC" in a small logo/graphic form
  const hasRCLogo = /\bRC\b|\[RC\]|\{RC\}|\(RC\)|RC logo/i.test(text);
  
  if (hasStrongRookieIndicator || hasRCLogo) {
    cardDetails.isRookieCard = true;
    console.log('Detected rookie card indicator with high confidence');
  }
  
  // ENHANCED AUTOGRAPH DETECTION
  // Check for autograph indicators with more context and precision
  const autographIndicators = [
    // Standard indicators
    'AUTOGRAPH', 'SIGNED', 'SIGNATURE', 'CERTIFIED AUTOGRAPH',
    
    // Brand-specific autograph indicators
    'CERTIFIED AUTO', 'ON-CARD AUTO', 'STICKER AUTO',
    'AUTHENTIC SIGNATURES', 'AUTOGRAPHED', 'HAND SIGNED',
    
    // Card type indicators
    'AUTO JERSEY', 'AUTO PATCH', 'AUTO RELIC', 'AUTO RC'
  ];
  
  // More precise autograph detection with word boundaries
  const hasAutographIndicator = autographIndicators.some(indicator => {
    // Convert indicator to regex-safe string by escaping special characters
    const escapedIndicator = indicator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // Similar pattern as rookie detection but customized for auto detection
    const regexPattern = new RegExp(`(^|[\\s\\[\\{\\(])${escapedIndicator}($|[\\s\\]\\}\\)\\:])`, 'i');
    return regexPattern.test(text);
  });
  
  // Special case for "AUTO" which needs more context to avoid false positives
  // as it's a common substring in many words
  const hasAutoKeyword = /\bAUTO\b|\[AUTO\]|\{AUTO\}|\(AUTO\)|AUTO:/i.test(text);
  
  if (hasAutographIndicator || hasAutoKeyword) {
    cardDetails.isAutographed = true;
    console.log('Detected autographed card indicator with high confidence');
  }
  
  // ENHANCED NUMBERED CARD DETECTION
  // Check for indicators of numbered cards, with better context
  const numberedCardIndicators = [
    'NUMBERED', 'LIMITED EDITION', 'SERIAL', 'SERIALED', 
    'PRINT RUN', 'PRINT RUN OF', 'EDITION OF', 'EDITION SIZE',
    'RARE', 'SCARCE', 'LOW PRINT RUN', 'SHORT PRINT'
  ];
  
  // More precise numbered card detection
  const hasNumberedIndicator = numberedCardIndicators.some(indicator => {
    // Convert indicator to regex-safe string by escaping special characters
    const escapedIndicator = indicator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // Check with word boundaries
    const regexPattern = new RegExp(`(^|[\\s\\[\\{\\(])${escapedIndicator}($|[\\s\\]\\}\\)\\:])`, 'i');
    return regexPattern.test(text);
  });
  
  // Also check for common numbered card patterns
  const hasNumberedPattern = /\/\d+|OF \d+|EDITION OF \d+|LIMITED TO \d+/i.test(text);
  
  if (!cardDetails.isNumbered && (hasNumberedIndicator || hasNumberedPattern)) {
    cardDetails.isNumbered = true;
    console.log('Detected numbered card with high confidence');
  }
  
  // ENHANCED VARIANT DETECTION
  // More comprehensive list of card variants with organized categories
  const variants = [
    // Finish/Treatment variants
    { keyword: 'REFRACTOR', name: 'Refractor' },
    { keyword: 'CHROME', name: 'Chrome' },
    { keyword: 'PRIZM', name: 'Prizm' },
    { keyword: 'OPTI-CHROME', name: 'Opti-Chrome' },
    { keyword: 'HOLOGRAM', name: 'Hologram' },
    { keyword: 'HOLO', name: 'Holo' },
    { keyword: 'FOIL', name: 'Foil' },
    { keyword: 'RAINBOW FOIL', name: 'Rainbow Foil' },
    { keyword: 'SHIMMER', name: 'Shimmer' },
    { keyword: 'GLOSSY', name: 'Glossy' },
    { keyword: 'LAVA', name: 'Lava' },
    { keyword: 'CRACKED ICE', name: 'Cracked Ice' },
    { keyword: 'CRUSADE', name: 'Crusade' },
    { keyword: 'ETCHED', name: 'Etched' },
    
    // Color/Material variants
    { keyword: 'GOLD', name: 'Gold' },
    { keyword: 'SILVER', name: 'Silver' },
    { keyword: 'BLUE', name: 'Blue' },
    { keyword: 'GREEN', name: 'Green' },
    { keyword: 'RED', name: 'Red' },
    { keyword: 'PURPLE', name: 'Purple' },
    { keyword: 'ORANGE', name: 'Orange' },
    { keyword: 'YELLOW', name: 'Yellow' },
    { keyword: 'PINK', name: 'Pink' },
    { keyword: 'BLACK', name: 'Black' },
    { keyword: 'SAPPHIRE', name: 'Sapphire' },
    { keyword: 'RUBY', name: 'Ruby' },
    { keyword: 'EMERALD', name: 'Emerald' },
    { keyword: 'DIAMOND', name: 'Diamond' },
    { keyword: 'BRONZE', name: 'Bronze' },
    { keyword: 'PLATINUM', name: 'Platinum' },
    { keyword: 'TITANIUM', name: 'Titanium' },
    
    // Special editions
    { keyword: 'PARALLEL', name: 'Parallel' },
    { keyword: 'SP', name: 'Short Print' },
    { keyword: 'SSP', name: 'Super Short Print' },
    { keyword: 'KABOOM', name: 'Kaboom' },
    { keyword: 'DOWNTOWN', name: 'Downtown' },
    { keyword: 'CANVAS', name: 'Canvas' },
    { keyword: 'SEPIA', name: 'Sepia' },
    { keyword: 'VINTAGE STOCK', name: 'Vintage Stock' },
    { keyword: 'INDEPENDENCE DAY', name: 'Independence Day' },
    { keyword: 'FATHERS DAY', name: 'Father\'s Day' },
    { keyword: 'MOTHERS DAY', name: 'Mother\'s Day' },
    { keyword: 'MEMORIAL DAY', name: 'Memorial Day' },
    { keyword: 'BLACK FRIDAY', name: 'Black Friday' },
    { keyword: 'CYBER MONDAY', name: 'Cyber Monday' },
    
    // Brand-specific variants
    { keyword: 'TOPPS CHROME', name: 'Chrome' },
    { keyword: 'BOWMAN CHROME', name: 'Chrome' },
    { keyword: 'FINEST', name: 'Finest' },
    { keyword: 'OPTIC', name: 'Optic' },
    { keyword: 'VELOCITY', name: 'Velocity' },
    { keyword: 'SELECT', name: 'Select' },
    { keyword: 'MOSAIC', name: 'Mosaic' },
    { keyword: 'DONRUSS OPTIC', name: 'Optic' },
    { keyword: 'DONRUSS ELITE', name: 'Elite' },
    { keyword: 'HERITAGE HIGH NUMBER', name: 'High Number' },
    { keyword: 'HIGH NUMBER', name: 'High Number' },
    { keyword: 'HIGH TEK', name: 'High Tek' },
    { keyword: 'FIVE STAR', name: 'Five Star' }
  ];
  
  // For better variant detection, use a more precise approach with word boundaries
  for (const variant of variants) {
    // Convert variant keyword to regex-safe string by escaping special characters
    const escapedKeyword = variant.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // Create a regex pattern that looks for the keyword with word boundaries or in specific contexts
    const regexPattern = new RegExp(`(^|[\\s\\[\\{\\(])${escapedKeyword}($|[\\s\\]\\}\\)\\:])`, 'i');
    
    if (regexPattern.test(text)) {
      // Only set the variant if it's not already set (prioritize specific variants over generic ones)
      if (!cardDetails.variant) {
        cardDetails.variant = variant.name;
        console.log(`Detected variant: ${variant.name}`);
      } 
      // If the current variant is Chrome and we find a more specific one, use that instead
      else if (cardDetails.variant === 'Chrome' && variant.name !== 'Chrome') {
        cardDetails.variant = variant.name;
        console.log(`Updated variant from Chrome to more specific: ${variant.name}`);
      }
      // If we find Gold/Silver/etc after Refractor, combine them
      else if (cardDetails.variant === 'Refractor' && 
              ['Gold', 'Silver', 'Blue', 'Green', 'Red', 'Purple', 'Orange'].includes(variant.name)) {
        cardDetails.variant = `${variant.name} Refractor`;
        console.log(`Enhanced variant to: ${cardDetails.variant}`);
      }
    }
  }
}