import { CardFormValues } from "@shared/schema";
import { extractTextFromImage } from "./googleVisionFetch";
import { detectFoilVariant } from "./foilVariantDetector";

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
    console.log('=== STARTING DYNAMIC CARD ANALYSIS ===');
    // Extract the text from the image
    const { fullText, textAnnotations } = await getTextFromImage(base64Image);
    
    console.log('=== RAW OCR TEXT FROM IMAGE ===');
    console.log(fullText);
    console.log('=== END RAW OCR TEXT ===');
    
    // Initialize card details object with default values
    const cardDetails: Partial<CardFormValues> = {
      condition: 'PSA 8', // Default condition per requirements
      playerFirstName: '',
      playerLastName: '',
      brand: '',
      collection: '',
      cardNumber: '',
      year: 0,
      variant: '',
      serialNumber: '',
      estimatedValue: 0, // Default value
      sport: '', // No default sport - will be detected
      isRookieCard: false,
      isAutographed: false,
      isNumbered: false,
      isFoil: false,
      foilType: null
    };
    
    // Parse all extracted text
    const cleanText = fullText.toUpperCase().replace(/\s+/g, ' ').trim();
    
    // PLAYER NAME DETECTION - Extract player name using positional and context analysis
    extractPlayerName(cleanText, cardDetails, fullText);
    
    // CARD NUMBER DETECTION - Extract card number using regex patterns
    extractCardNumber(cleanText, cardDetails, fullText);
    
    // COLLECTION, BRAND & YEAR DETECTION - Extract using pattern recognition
    extractCardMetadata(cleanText, cardDetails, fullText);
    
    // SERIAL NUMBER DETECTION - Look for serial numbering with enhanced detection
    await extractSerialNumber(cleanText, cardDetails, textAnnotations);
    
    // CARD FEATURES DETECTION - Rookie cards, autographs, etc.
    detectCardFeatures(cleanText, cardDetails);
    
    // SPORT DETECTION - Try to detect the sport if not already set
    detectSport(cleanText, cardDetails);
    
    // FOIL VARIANT DETECTION - Check for foil, chrome, refractor, and other special finishes
    console.log('=== FOIL DETECTION START ===');
    console.log('Full text for foil detection:', fullText.substring(0, 200) + '...');
    const foilResult = detectFoilVariant(fullText);
    console.log(`Foil detection result: isFoil=${foilResult.isFoil}, type=${foilResult.foilType}, confidence=${foilResult.confidence}`);
    console.log(`Foil indicators found: [${foilResult.indicators.join(', ')}]`);
    
    // TEMPORARILY DISABLE AUTOMATIC FOIL DETECTION TO DEBUG FALSE POSITIVES
    console.log('TEMP: Skipping automatic foil detection - will be handled in dual-side combine function');
    /* 
    if (foilResult.isFoil) {
      // Special handling for Chrome cards - set as collection, not variant
      if (foilResult.foilType === 'Chrome' && !cardDetails.collection) {
        cardDetails.collection = 'Chrome';
        console.log(`Detected Chrome collection (not variant)`);
      } else {
        cardDetails.isFoil = true;
        cardDetails.foilType = foilResult.foilType;
        console.log(`Detected foil variant: ${foilResult.foilType} (confidence: ${foilResult.confidence})`);
      }
      console.log(`Foil indicators: ${foilResult.indicators.join(', ')}`);
    } else {
      console.log('No foil variant detected');
    }
    */
    console.log('=== FOIL DETECTION END ===');
    
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
function extractPlayerName(text: string, cardDetails: Partial<CardFormValues>, originalText?: string): void {
  try {
    // Special case for All-Star cards - look for player name after "ALL-STAR" or before it
    if (text.includes('ALL-STAR') || text.includes('ALL STAR')) {
      console.log('Found All-Star card, looking for player name');
      
      // General All-Star card processing - look for player name around "ALL-STAR"
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // If this line contains ALL-STAR, check adjacent lines for player name
        if (line.includes('ALL-STAR') || line.includes('ALL STAR')) {
          // Check the line before and after for player names
          const checkLines = [
            i > 0 ? lines[i-1].trim() : '',
            i < lines.length - 1 ? lines[i+1].trim() : ''
          ];
          
          for (const checkLine of checkLines) {
            // Look for a line that could be a player name (2+ words, all caps, no numbers)
            if (checkLine && 
                /^[A-Z][A-Z\s\-'\.]{5,40}$/.test(checkLine) && 
                !checkLine.includes('ALL') && 
                !checkLine.includes('STAR') && 
                !checkLine.includes('TOPPS') &&
                !checkLine.includes('SERIES') &&
                !/^\d/.test(checkLine)) {
              
              const nameParts = checkLine.split(' ').filter(part => part.length > 1);
              
              if (nameParts.length >= 2) {
                cardDetails.playerFirstName = nameParts[0].charAt(0).toUpperCase() + 
                                             nameParts[0].slice(1).toLowerCase();
                cardDetails.playerLastName = nameParts.slice(1).join(' ')
                                            .split(' ')
                                            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                                            .join(' ');
                
                console.log(`Detected player name from All-Star card: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
                return;
              }
            }
          }
        }
      }
    }
    
    // Special case for Stars of MLB cards
    if (text.includes('STARS OF MLB') || text.includes('SMLB-')) {
      console.log('Found Stars of MLB card');
      
      const lines = text.split('\n');
      
      // Look for the player name which typically comes right after the card number line
      for (let i = 0; i < Math.min(7, lines.length); i++) {
        // Look directly for the line with player name after SMLB-76
        if (lines[i].includes('SMLB-') && i + 1 < lines.length) {
          console.log(`Found SMLB line: "${lines[i]}", next line: "${lines[i+1]}"`);
          
          const nameLine = lines[i + 1].trim();
          // Check if this line looks like a player name (all caps, no numbers)
          if (nameLine && /^[A-Z][A-Z\s\-']{2,30}$/.test(nameLine) && 
              !nameLine.includes('STARS') && !nameLine.includes('MLB')) {
            
            const nameParts = nameLine.split(' ');
            
            if (nameParts.length >= 2) {
              cardDetails.playerFirstName = nameParts[0].charAt(0).toUpperCase() + 
                                            nameParts[0].slice(1).toLowerCase();
              cardDetails.playerLastName = nameParts.slice(1).join(' ')
                                            .split(' ')
                                            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                                            .join(' ');
              
              console.log(`Detected player name from Stars of MLB card: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
              
              // Set collection and fix card number
              cardDetails.collection = "Stars of MLB";
              cardDetails.brand = 'Topps';
              
              // Extract card number - keep the full SMLB-XX format
              const smlbMatch = lines[i].match(/SMLB-\d+/);
              if (smlbMatch) {
                cardDetails.cardNumber = smlbMatch[0];
              }
              
              return;
            }
          }
        }
      }
      
      // If still can't find, try explicit pattern match across the entire text
      const volpeMatch = text.match(/SMLB-(\d+)\s+([A-Z]+)\s+([A-Z]+)/i);
      if (volpeMatch && volpeMatch[2] && volpeMatch[3]) {
        const firstName = volpeMatch[2];
        const lastName = volpeMatch[3];
        
        // Make sure these aren't generic words
        if (!/STARS|OF|MLB|NEW|YORK/.test(firstName + lastName)) {
          cardDetails.playerFirstName = firstName.charAt(0).toUpperCase() + 
                                        firstName.slice(1).toLowerCase();
          cardDetails.playerLastName = lastName.charAt(0).toUpperCase() + 
                                      lastName.slice(1).toLowerCase();
          
          console.log(`Detected player name from SMLB pattern: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
          
          // Set collection info
          cardDetails.collection = "Stars of MLB";
          cardDetails.brand = 'Topps';
          cardDetails.cardNumber = volpeMatch[1];
          return;
        }
      }
      
    }
    
    // Special case for multi-word last names and special formats like Collector's Choice
    const brandWords = new Set(['TOPPS', 'BOWMAN', 'DONRUSS', 'PANINI', 'FLEER', 'SCORE', 'LEAF', 'PRINTED', 'USA']);
    const multiWordNameMatch = text.match(/([A-Z][a-zA-Z]+)\s+([A-Z][A-Z\s]+)\s+(?:•|\.|\*|:|,)\s*([A-Z]+)/);
    if (multiWordNameMatch) {
      const firstName = multiWordNameMatch[1];
      const lastName = multiWordNameMatch[2];
      
      const lastNameTokens = lastName.trim().split(/\s+/);
      const hasBrandInFirst = brandWords.has(firstName.toUpperCase());
      const hasBrandInLast = lastNameTokens.some(t => brandWords.has(t.toUpperCase()));
      if (!hasBrandInFirst && !hasBrandInLast) {
        cardDetails.playerFirstName = firstName;
        cardDetails.playerLastName = lastName;
        console.log(`Detected player with multi-word last name: ${firstName} ${lastName}`);
        return;
      }
    }
    
    // First, look for name patterns in the first few lines of the card
    const lines = text.split('\n');
    
    console.log('Starting enhanced player name detection across full text...');
    
    const nonNameWords = new Set([
      'TOPPS', 'LOPPS', 'OPPS', 'TOPPE', 'CHROME', 'BOWMAN', 'FLEER', 'DONRUSS', 'PANINI', 'SCORE', 'LEAF',
      'UPPER', 'DECK', 'SERIES', 'ONE', 'TWO', 'THREE', 'OPENING', 'DAY', 'STADIUM', 'CLUB',
      'BASEBALL', 'CARD', 'ROOKIE', 'STARS', 'MLB', 'TILB', 'SMLB',
      'MAJOR', 'LEAGUE', 'BATTING', 'RECORD', 'PITCHING', 'FIELDING',
      'OUTFIELDER', 'INFIELDER', 'PITCHER', 'CATCHER', 'SHORTSTOP', 'DESIGNATED', 'HITTER',
      'FIRST', 'SECOND', 'THIRD', 'BASEMAN', 'LEFT', 'RIGHT', 'CENTER', 'FIELDER',
      'OF', 'SS', 'DH', 'SP', 'RP', 'CF', 'LF', 'RF',
      'QB', 'WR', 'RB', 'TE', 'LB', 'CB', 'DE', 'DT', 'OL', 'OT', 'OG',
      'PG', 'SG', 'SF', 'PF',
      'KC', 'TB', 'LA', 'NY', 'SF', 'SD', 'STL', 'CLE', 'DET', 'MIN', 'CHC', 'CHW', 'CWS',
      'MIL', 'PIT', 'CIN', 'ATL', 'MIA', 'PHI', 'NYM', 'NYY', 'BOS', 'BAL', 'TOR',
      'HOU', 'TEX', 'SEA', 'OAK', 'LAA', 'LAD', 'ARI', 'COL',
      'PHILLIES', 'PHILLIE', 'YANKEES', 'DODGERS', 'METS', 'CUBS', 'RED', 'SOX', 'BRAVES',
      'ASTROS', 'RANGERS', 'PADRES', 'GIANTS', 'CARDINALS', 'NATIONALS', 'ORIOLES', 'GUARDIANS',
      'TWINS', 'RAYS', 'MARLINS', 'PIRATES', 'REDS', 'BREWERS', 'TIGERS', 'ROYALS', 'ATHLETICS',
      'MARINERS', 'ANGELS', 'ROCKIES', 'DIAMONDBACKS', 'WHITE', 'INDIANS',
      'PHILADELPHIA', 'CHICAGO', 'BOSTON', 'ANGELES', 'YORK',
      'NEW', 'SAN', 'LOS', 'SAINT', 'LOUIS', 'KANSAS', 'CITY',
      'SLG', 'OPS', 'AVG', 'WHIP', 'IP', 'AB',
      'BATS', 'THROWS', 'DRAFTED', 'BORN', 'HOME', 'ACQ', 'FREE', 'AGENT',
      'HT', 'WT', 'HEIGHT', 'WEIGHT', 'PRINTED', 'USA',
      'ALL', 'STAR', 'COLLECTION', 'FLAGSHIP', 'HERITAGE', 'PRIZM', 'SELECT', 'MOSAIC',
      'REFRACTOR', 'FOIL', 'GOLD', 'SILVER', 'BRONZE', 'PLATINUM', 'SAPPHIRE',
      'OFFICIALLY', 'LICENSED', 'PRODUCT', 'TRADEMARKS', 'COPYRIGHTS', 'RESERVED', 'RIGHTS',
      'REGISTERED', 'COMPANY', 'INC', 'VISIT', 'CODE', 'WWW', 'COM',
      'THE', 'AND', 'FOR', 'WITH', 'FROM', 'THAT', 'THIS', 'WAS', 'OVER', 'WENT',
      'KEPT', 'GOING', 'REACHED', 'BASE', 'CLIP', 'THOSE', 'MONTHS', 'PLAYERS',
      'JUNE', 'JULY', 'MAY', 'AUGUST', 'SEPTEMBER', 'OCTOBER',
      'HUGE', 'PART', 'LEADOFF', 'MAN', 'OBP', 'ERA', 'AVG', 'RBI', 'WAR',
      'CHOICE', 'WEB', 'PLAYERA', 'TAPPS', 'XTOPPS', 'ITALICS', 'LEADER', 'TIE',
      'TOTALS', 'MAJ', 'LEA', 'CUBS', 'NATIONALS',
    ]);
    
    const isNonNameWord = (word: string): boolean => {
      const cleaned = word.toUpperCase().replace(/(?:TM|™|®|\.+)$/gi, '');
      return nonNameWords.has(cleaned) || word.length <= 1 || /^\d/.test(word);
    };
    
    const potentialNames: Array<{firstName: string, lastName: string, source: string, priority: number}> = [];
    
    const rawLines = (originalText || text).split('\n');
    
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (!line) continue;
      
      const words = line.split(/\s+/).filter(w => w.length > 0);
      
      if (words.length >= 2 && words.length <= 5) {
        let nameWords = words
          .map(w => w.replace(/[,;]+$/, ''))
          .filter(w => /^[A-Z][A-Za-z'\-\.]+$/.test(w) || /^[A-Z]{2,}$/.test(w))
          .filter(w => !/^(II|III|IV|JR|SR)$/i.test(w));
        
        while (nameWords.length > 0 && isNonNameWord(nameWords[nameWords.length - 1])) {
          nameWords.pop();
        }
        while (nameWords.length > 0 && isNonNameWord(nameWords[0])) {
          nameWords.shift();
        }
        
        if (nameWords.length >= 2 && nameWords.length <= 3) {
          const noNonNameWords = nameWords.every(w => !isNonNameWord(w));
          const noNumbers = nameWords.every(w => !/\d/.test(w));
          const eachWordLen = nameWords.every(w => w.length >= 2);
          
          if (noNonNameWords && noNumbers && eachWordLen) {
            const firstName = nameWords[0].charAt(0).toUpperCase() + nameWords[0].slice(1).toLowerCase();
            const lastName = nameWords.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
            
            const isFollowedByTeamPosition = (i + 1 < rawLines.length) && 
              /PHILLIES|YANKEES|DODGERS|METS|CUBS|OUTFIELDER|INFIELDER|PITCHER|CATCHER|SHORTSTOP|BASEMAN/i.test(rawLines[i + 1]);
            
            const priority = isFollowedByTeamPosition ? 0 : (i < 5 ? 1 : 2);
            
            console.log(`Line-based player name candidate: "${firstName} ${lastName}" (priority: ${priority}, line: ${i})`);
            potentialNames.push({ firstName, lastName, source: 'line', priority });
          }
        }
      }
      
      const cardNumberPrefix = words[0];
      if (/^[A-Z0-9]+-\d+$/.test(cardNumberPrefix) || /^\d+$/.test(cardNumberPrefix)) {
        const remainingWords = words.slice(1);
        if (remainingWords.length >= 2 && remainingWords.length <= 3) {
          const allAlphaRemaining = remainingWords.every(w => /^[A-Z][A-Za-z'\-\.]+$/.test(w) || /^[A-Z]{2,}$/.test(w));
          const noNonNameWordsRemaining = remainingWords.every(w => !isNonNameWord(w));
          const noNumbersRemaining = remainingWords.every(w => !/\d/.test(w));
          const eachWordLenRemaining = remainingWords.every(w => w.length >= 2);
          
          if (allAlphaRemaining && noNonNameWordsRemaining && noNumbersRemaining && eachWordLenRemaining) {
            const firstName = remainingWords[0].charAt(0).toUpperCase() + remainingWords[0].slice(1).toLowerCase();
            const lastName = remainingWords.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
            
            const isFollowedByTeamPosition = (i + 1 < rawLines.length) && 
              /PHILLIES|YANKEES|DODGERS|METS|CUBS|OUTFIELDER|INFIELDER|PITCHER|CATCHER|SHORTSTOP|BASEMAN|ASTROS|BREWERS|PADRES|GIANTS|THIRD BASE|FIRST BASE|SECOND BASE/i.test(rawLines[i + 1]);
            
            const priority = isFollowedByTeamPosition ? 0 : (i < 5 ? 1 : 2);
            
            console.log(`Card-number-prefixed name candidate: "${firstName} ${lastName}" (priority: ${priority}, line: ${i})`);
            potentialNames.push({ firstName, lastName, source: 'card-number-prefix', priority });
          }
        }
      }
    }
    
    if (potentialNames.length === 0) {
      const upperText = text.toUpperCase();
      const twoWordNameRegex = /\b([A-Z][A-Z]+)\s+([A-Z][A-Z]+(?:\s+[A-Z][A-Z]+)?)\b/g;
      let match;
      
      while ((match = twoWordNameRegex.exec(upperText)) !== null) {
        const words = match[0].split(/\s+/);
        if (words.length > 3) continue;
        
        const noNonNameWords = words.every(w => !isNonNameWord(w));
        const eachWordLen = words.every(w => w.length >= 2);
        
        if (noNonNameWords && eachWordLen) {
          const firstName = words[0].charAt(0).toUpperCase() + words[0].slice(1).toLowerCase();
          const lastName = words.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
          potentialNames.push({ firstName, lastName, source: 'regex', priority: 3 });
          console.log(`Regex-based player name candidate: "${firstName} ${lastName}"`);
        }
      }
    }
    
    if (potentialNames.length > 0) {
      potentialNames.sort((a, b) => a.priority - b.priority);
      const selected = potentialNames[0];
      cardDetails.playerFirstName = selected.firstName;
      cardDetails.playerLastName = selected.lastName;
      console.log(`Selected player name: ${selected.firstName} ${selected.lastName} (source: ${selected.source}, priority: ${selected.priority})`);
      return;
    }
    
    // FALLBACK: Check the second line of text for player name (original logic)
    if (lines.length > 1) {
      const secondLine = lines[1].trim();
      
      console.log(`Checking second line for player name: "${secondLine}"`);
      
      // If the second line looks like a name (all caps, no numbers, reasonable length)
      if (secondLine && 
          secondLine.length > 0 &&
          /^[A-Z][A-Z\s\-\.']{2,30}$/.test(secondLine) && 
          !secondLine.includes('TOPPS') && 
          !secondLine.includes('SERIES') &&
          !secondLine.includes('OPENING DAY')) {
        
        const nameParts = secondLine.split(' ');
        
        if (nameParts.length >= 2) {
          const firstName = nameParts[0];
          const lastName = nameParts.slice(1).join(' ');
          
          cardDetails.playerFirstName = firstName.charAt(0).toUpperCase() + 
                                       firstName.slice(1).toLowerCase();
          cardDetails.playerLastName = lastName.charAt(0).toUpperCase() + 
                                      lastName.slice(1).toLowerCase();
          
          console.log(`Detected player name from second line: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
          return;
        }
      }
    }
    
    // Check for multi-line player names (common in some cards like Score)
    // This handles cases like "JUAN\nBELL" where the name is split across lines
    for (let i = 0; i < Math.min(5, lines.length - 1); i++) {
      // Check for two consecutive short lines that might be first name + last name
      const line1 = lines[i].trim();
      const line2 = lines[i+1].trim();
      
      // Check for Collector's Choice collection in the first few lines
      if (line1.includes("COLLECTOR") && (line1.includes("CHOICE") || line2.includes("CHOICE"))) {
        cardDetails.collection = "Collector's Choice";
        cardDetails.brand = "Upper Deck";
        console.log(`Detected Collector's Choice collection and Upper Deck brand from text`);
      }
      
      // Each line should be a single word, all caps, and a reasonable length for a name
      // Special handling for Score cards where player names are on consecutive lines
      const isNonName = (text: string) => {
        const nonNames = ['TOPPS', 'SCORE', 'BOWMAN', 'FLEER', 'LEAF', 'DONRUSS', 'UPPER', 'DECK', 
                          'SERIES', 'ONE', 'TWO', 'BASE', 'CARD', 'MLB', 'FRONT', 'BACK',
                          'SS', 'DH', 'SP', 'RP', 'CF', 'LF', 'RF', 'OF',
                          'QB', 'WR', 'RB', 'TE', 'LB', 'CB', 'DE', 'DT', 'OL', 'OT', 'OG',
                          'PG', 'SG', 'SF', 'PF',
                          'KC', 'TB', 'LA', 'NY', 'SD', 'STL', 'CLE', 'DET', 'MIN', 'CHC', 'CHW',
                          'MIL', 'PIT', 'CIN', 'ATL', 'MIA', 'PHI', 'NYM', 'NYY', 'BOS', 'BAL', 'TOR',
                          'HOU', 'TEX', 'SEA', 'OAK', 'LAA', 'LAD', 'ARI', 'COL',
                          'RC', 'ROOKIE', 'BASEBALL', 'FOOTBALL', 'BASKETBALL', 'HOCKEY',
                          'ROYALS', 'METS', 'YANKEES', 'DODGERS', 'CUBS', 'PHILLIES', 'BRAVES',
                          'ASTROS', 'RANGERS', 'PADRES', 'GIANTS', 'CARDINALS', 'NATIONALS',
                          'ORIOLES', 'GUARDIANS', 'TWINS', 'RAYS', 'MARLINS', 'PIRATES',
                          'REDS', 'BREWERS', 'TIGERS', 'ATHLETICS', 'MARINERS', 'ANGELS',
                          'TOTALS', 'MAJ', 'LEA', 'RECORD', 'PITCHING', 'BATTING', 'FIELDING'];
        const cleaned = text.replace(/\.+$/g, '').toUpperCase();
        return nonNames.includes(cleaned) || cleaned.length < 2 || /^\d+$/.test(cleaned);
      };
      
      if (line1 && line2 && 
          /^[A-Z]{2,15}$/.test(line1) && // First name is all caps, single word, 2-15 letters
          /^[A-Z]{2,15}$/.test(line2) && // Last name is all caps, single word, 2-15 letters
          !isNonName(line1) && !isNonName(line2)) {
        
        console.log(`Found potential multi-line player name: ${line1} ${line2}`);
        
        // Format the name properly
        cardDetails.playerFirstName = line1.charAt(0).toUpperCase() + line1.slice(1).toLowerCase();
        cardDetails.playerLastName = line2.charAt(0).toUpperCase() + line2.slice(1).toLowerCase();
        
        console.log(`Detected player name from consecutive lines: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
        return;
      }
    }
      
    // Next, look for specific pattern like "NORMAN (NORM) WOOD CHARLTON"
    for (let i = 0; i < Math.min(5, lines.length); i++) {
      const line = lines[i].trim();
      const parenthesesNameMatch = line.match(/([A-Z][A-Za-z]+)\s+\(([A-Za-z]+)\)\s+([A-Za-z]+)\s+([A-Za-z]+)/);
      
      if (parenthesesNameMatch) {
        const [_, firstName, nickname, middleName, lastName] = parenthesesNameMatch;
        // Use the nickname if available, otherwise use the first name
        cardDetails.playerFirstName = nickname || firstName;
        cardDetails.playerLastName = lastName;
        
        // Format the names properly
        cardDetails.playerFirstName = cardDetails.playerFirstName.charAt(0).toUpperCase() + 
                                     cardDetails.playerFirstName.slice(1).toLowerCase();
        cardDetails.playerLastName = cardDetails.playerLastName.charAt(0).toUpperCase() + 
                                    cardDetails.playerLastName.slice(1).toLowerCase();
        
        console.log(`Detected player name with parenthetical nickname: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
        return;
      }
    }
    
    // Focus on the first 5 lines, which typically contain the player name
    for (let i = 0; i < Math.min(5, lines.length); i++) {
      const line = lines[i].trim();
      
      // Skip empty lines, numbers-only lines, or very long lines
      if (!line || line.match(/^\d+$/) || line.length > 30) {
        continue;
      }
      
      const nonNameWords = [
        'PITCHER','CATCHER','INFIELDER','OUTFIELDER','DESIGNATED','HITTER',
        'BATS','THROWS','THROW','LEFT','RIGHT','SWITCH',
        'HEIGHT','WEIGHT','BORN','BIRTH','DOB',
        'MAJOR','LEAGUE','CLUB','RECORD','COMPLETE','ERA',
        'POSITION','TEAM','OF','THE',
        'TOPPS','LOPPS','LAPPS','BOWMAN','DONRUSS','PANINI','FLEER','SCORE','LEAF',
        'SERIES','CHROME','METS','YANKEES','DODGERS','CUBS','PHILLIES','BRAVES',
        'ASTROS','RANGERS','PADRES','GIANTS','CARDINALS','NATIONALS','ORIOLES',
        'GUARDIANS','TWINS','RAYS','ROYALS','BREWERS','TIGERS','REDS','PIRATES',
        'BASEBALL','FOOTBALL','BASKETBALL','HOCKEY','MLB','STARS','ROOKIE',
        'SLG','OPS','AVG','WHIP','RBI','WAR','TOTALS'
      ];
      let isNonNameLine = false;
      for (const word of nonNameWords) {
        if (line.includes(word)) {
          isNonNameLine = true;
          break;
        }
      }
      if (isNonNameLine) continue;
      
      // Check for lines that look like "FIRST LAST" or "FIRST MIDDLE LAST"
      if (line.match(/^[A-Z]+(\s+[A-Z]+){1,2}$/)) {
        const nameParts = line.split(/\s+/);
        if (nameParts.length >= 2) {
          cardDetails.playerFirstName = nameParts[0].toLowerCase()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
            
          cardDetails.playerLastName = nameParts.slice(1).join(' ').toLowerCase()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
          
          console.log(`Detected player name from early line: ${line}`);
          return;
        }
      }
    }
    
    // If we couldn't find a name in the first few lines, try the traditional top pattern
    const topNamePattern = /^[\s\n]*([A-Z]+)[\s\n]+([A-Z]+)[\s\n]/;
    const topNameMatch = text.match(topNamePattern);
    
    if (topNameMatch && topNameMatch[1] && topNameMatch[2]) {
      const firstName = topNameMatch[1].trim();
      const lastName = topNameMatch[2].trim();
      
      const nonNameWords = ['PITCHER', 'CATCHER', 'COMPLETE', 'RECORD', 'MAJOR', 'LEAGUE', 'CLUB', 'ERA',
        'TOPPS', 'LOPPS', 'LAPPS', 'BOWMAN', 'DONRUSS', 'PANINI', 'FLEER', 'SCORE', 'LEAF',
        'SERIES', 'CHROME', 'METS', 'YANKEES', 'DODGERS', 'CUBS', 'PHILLIES', 'BRAVES',
        'ASTROS', 'RANGERS', 'PADRES', 'GIANTS', 'CARDINALS', 'NATIONALS', 'ORIOLES',
        'GUARDIANS', 'TWINS', 'RAYS', 'ROYALS', 'BREWERS', 'TIGERS', 'REDS', 'PIRATES',
        'MARLINS', 'ATHLETICS', 'MARINERS', 'ANGELS', 'ROCKIES', 'DIAMONDBACKS',
        'BASEBALL', 'FOOTBALL', 'BASKETBALL', 'HOCKEY', 'ROOKIE', 'STARS', 'MLB',
        'SLG', 'OPS', 'AVG', 'WHIP', 'RBI', 'WAR', 'TOTALS', 'MAJ', 'LEA'];
      if (!nonNameWords.includes(firstName) && !nonNameWords.includes(lastName)) {
        cardDetails.playerFirstName = firstName.toLowerCase()
          .split(' ')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
          .join(' ');
          
        cardDetails.playerLastName = lastName.toLowerCase()
          .split(' ')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
          .join(' ');
        
        console.log(`Detected player name from name pattern: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
        return;
      }
    }
    
  } catch (error) {
    console.error('Error detecting player name:', error);
  }
}

/**
 * Extract card number using regex patterns for common formats
 */
function extractCardNumber(text: string, cardDetails: Partial<CardFormValues>, originalText?: string): void {
  try {
    // Look for known card number formats
    
    // Filter out birthday/date formats first
    // Common date formats to avoid: MM-DD-YY, M-D-YY, MM-DD, M-D
    const isDOBFormat = (text: string): boolean => {
      // Check for birthdate patterns like "Born 7-17-63" or similar
      return /BORN|BIRTH|DOB|B-DAY|DATE OF BIRTH|HT|WT|HEIGHT|WEIGHT/i.test(text) ||
             // Date format with year: MM-DD-YY or M-D-YY
             /\b\d{1,2}-\d{1,2}-\d{2,4}\b/.test(text) ||
             // Trade or draft dates
             /TRADE|DRAFT|ACQUIRED|SIGNED|GRADUATED/i.test(text) ||
             // Player stats with dates
             /SEASON|RECORD|\b(?:ERA|HR|RBI|AVG|OBP|SLG)\b/i.test(text) ||
             // Date format without year near words indicating dates
             /(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)[.\s,-]+\d{1,2}/.test(text);
    };
    
    // Use originalText (with newlines preserved) for line-based analysis when available
    // This prevents the entire back text from being treated as one giant line
    const textForLines = originalText || text;
    const lines = textForLines.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    // Check for birthdate-related lines
    const birthdateLines = lines.filter(line => isDOBFormat(line));
    if (birthdateLines.length > 0) {
      console.log(`Skipping potential birthdate/stat lines for card number detection:`, birthdateLines);
    }
    
    // Helper: check if a number appears in a player bio context (height, weight, draft pick, etc.)
    const isPlayerBioNumber = (num: string, contextLine: string): boolean => {
      const numVal = parseInt(num);
      const upper = contextLine.toUpperCase();
      // Weight pattern: WT: 229, WT 229, WEIGHT: 229
      if (new RegExp(`WT[:\\s]+${num}\\b`, 'i').test(upper)) return true;
      // Height pattern: HT: 6'0" (not a number we'd extract but guard against)
      if (/HT[:\s]+\d/.test(upper) && upper.includes(num)) return true;
      // Draft pick pattern: DRAFTED: CUBS #1, PICK #5
      if (/DRAFTED|DRAFT\s*PICK/i.test(upper) && new RegExp(`#${num}\\b`).test(upper)) return true;
      // Stats table headers/rows: lines with team abbreviations and many numbers
      if (/\b(CUBS|REDS|PHILLIES|NATIONALS|RED SOX|YANKEES|DODGERS|GIANTS|BRAVES|ATHLETICS|ANGELS|CARDINALS|BLUE JAYS|WHITE SOX|PIRATES|MARLINS|RANGERS|MARINERS|TIGERS|TWINS|ROYALS|INDIANS|GUARDIANS|DIAMONDBACKS|ROCKIES|PADRES|RAYS|METS|ASTROS|BREWERS|ORIOLES)\b/i.test(upper)) {
        // If the line has many numbers (stat line), skip it
        const numberCount = (upper.match(/\b\d+\b/g) || []).length;
        if (numberCount >= 4) return true;
      }
      // MAJ. LEA. TOTALS line
      if (/MAJ\.?\s*LEA|TOTALS/i.test(upper)) return true;
      return false;
    };
    
    // Special handling for All-Star card numbers (e.g., 89ASB-28)
    const allStarCardPattern = /\b(\d+ASB?-\d+)\b/i;
    const allStarMatch = text.match(allStarCardPattern);
    
    if (allStarMatch && allStarMatch[0]) {
      cardDetails.cardNumber = allStarMatch[0].toUpperCase();
      cardDetails.collection = "1989 All-Star";
      console.log(`Detected All-Star card number: ${cardDetails.cardNumber}`);
      return;
    }
    
    // Format: 89B-2, T91-13 (alphanumeric-with-digits prefix, dash, digits)
    // Loop through ALL matches so a skipped date pattern doesn't block later valid card numbers.
    const dashNumberPatternGlobal = /\b([A-Z][A-Z0-9]*\d[A-Z0-9]*|[A-Z]{1,4})-([0-9]{1,4})\b/g;
    let dashNumberMatch;
    let foundDashCardNumber = false;
    while ((dashNumberMatch = dashNumberPatternGlobal.exec(text)) !== null) {
      const matchedText = dashNumberMatch[0];
      const digits = dashNumberMatch[2];
      if (parseInt(digits) > 999) continue;
      const lineWithMatch = lines.find(line => line.toLowerCase().includes(matchedText.toLowerCase()));
      if (lineWithMatch && isDOBFormat(lineWithMatch)) {
        console.log(`Skipping date-like pattern "${matchedText}" that appears to be a birthdate/date`);
        continue;
      }
      if (lineWithMatch && /\b(DRAFTED|DRAFT|BORN|SIGNED|OVERALL|ROUND|PICK|AGENT|FREE)\b/i.test(lineWithMatch)) {
        console.log(`Skipping pattern "${matchedText}" in biographical context`);
        continue;
      }
      cardDetails.cardNumber = matchedText;
      console.log(`Detected card number with dash: ${cardDetails.cardNumber}`);
      // 35th Anniversary cards have format like 89B-2
      if (matchedText.match(/^\d+[A-Z]\d*-\d+$/)) {
        cardDetails.collection = "35th Anniversary";
        console.log(`Setting collection from card number pattern: 35th Anniversary`);
      }
      foundDashCardNumber = true;
      break;
    }
    if (foundDashCardNumber) return;
    
    // Format: 89-B (number-letter)
    const numberLetterPattern = /\b(\d+)-([A-Z])\b/;
    const numberLetterMatch = text.match(numberLetterPattern);
    
    if (numberLetterMatch && numberLetterMatch[0]) {
      const matchedText = numberLetterMatch[0];
      const lineWithMatch = lines.find(line => line.includes(matchedText));
      
      if (lineWithMatch && isDOBFormat(lineWithMatch)) {
        console.log(`Skipping date-like pattern "${matchedText}" that appears to be a birthdate/date`);
      } else {
        cardDetails.cardNumber = matchedText;
        console.log(`Detected number-letter card number: ${cardDetails.cardNumber}`);
        return;
      }
    }
    
    // Plain number format: #123 or No. 123
    const plainNumberPattern = /(?:#|No\.?\s*)(\d+)/;
    const plainNumberMatch = text.match(plainNumberPattern);
    if (plainNumberMatch && plainNumberMatch[1]) {
      const candidate = plainNumberMatch[1];
      const lineWithMatch = lines.find(line => line.includes(plainNumberMatch[0]));

      if (lineWithMatch && isDOBFormat(lineWithMatch)) {
        console.log(`Skipping plain number "${candidate}" that appears in a date/stat line`);
      } else if (candidate.length === 1) {
        cardDetails.cardNumber = candidate;
      } else {
        cardDetails.cardNumber = candidate;
        return;
      }
    }
    
    // Look for standalone numbers at the very beginning of the card text
    // This prioritizes the number that appears at the top of the card
    
    // HIGHEST PRIORITY: Look for a number near the brand name - most card numbers are physically near the brand
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      const line = lines[i].trim();
      
      // If line contains a card brand, check for nearby card numbers
      // But skip lines that are clearly player bio/stat lines
      if (/TOPPS|BOWMAN|FLEER|DONRUSS|SCORE|LEAF|UPPER DECK/i.test(line) && !isDOBFormat(line)) {
        console.log(`Found brand mention in line ${i+1}: "${line}"`);
        
        // First check if the brand line itself contains a number pattern like "FLEER 549"
        // Look specifically for the pattern BRAND followed by a number
        const brandWithNumberPattern = new RegExp(`\\b(TOPPS|BOWMAN|FLEER|DONRUSS|SCORE|LEAF|UPPER DECK)\\s+(\\d{1,3})\\b`, 'i');
        const brandWithNumberMatch = line.match(brandWithNumberPattern);
        
        if (brandWithNumberMatch && brandWithNumberMatch[2]) {
          const number = brandWithNumberMatch[2];
          const numVal = parseInt(number);
          
          const isLikelyYear = (number.length === 2 && (
            (numVal >= 80 && numVal <= 99) || 
            (numVal >= 0 && numVal <= 30)   
          ));
          
          if (isLikelyYear) {
            const fullYear = numVal >= 80 ? 1900 + numVal : 2000 + numVal;
            if (!cardDetails.year || cardDetails.year === 0) {
              cardDetails.year = fullYear;
            }
            console.log(`Number ${number} after brand "${brandWithNumberMatch[1]}" is a year (${fullYear}), not a card number`);
          } else if (numVal > 0 && numVal < 1000) {
            cardDetails.cardNumber = number;
            console.log(`Detected card number ${number} immediately after brand "${brandWithNumberMatch[1]}" - highest confidence`);
            return;
          }
        }
        
        // If no direct brand+number pattern, check for any standalone number in the line
        const brandLineNumbers = line.match(/\b(\d{1,3})\b/g);
        if (brandLineNumbers) {
          const commonIncorrectNumbers = new Set(['00', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
          for (const number of brandLineNumbers) {
            const numVal = parseInt(number);
            if (commonIncorrectNumbers.has(number)) continue;
            const isYearLike = number.length === 2 && ((numVal >= 80 && numVal <= 99) || (numVal >= 0 && numVal <= 30));
            if (isYearLike) {
              console.log(`Skipping number ${number} on brand line - looks like a year`);
              continue;
            }
            // Skip numbers that appear in player bio context (height, weight, draft pick, stats)
            if (isPlayerBioNumber(number, line)) {
              console.log(`Skipping number ${number} on brand line - appears in player bio context (HT/WT/draft/stats)`);
              continue;
            }
            if (numVal > 0 && numVal < 1000) {
              cardDetails.cardNumber = number;
              console.log(`Detected card number ${number} in same line as brand - high confidence`);
              return;
            }
          }
        }
        
        // Check lines near the brand (up to 2 lines away)
        const surroundingLines: string[] = [];
        for (let offset = 1; offset <= 2; offset++) {
          if (i - offset >= 0) surroundingLines.push(lines[i - offset].trim());
          if (i + offset < lines.length) surroundingLines.push(lines[i + offset].trim());
        }
        
        for (const nearbyLine of surroundingLines) {
          // Check for hyphenated alphanumeric card numbers first (BD-7, HRC-42)
          const nearbyHyphenMatch = nearbyLine.match(/\b([A-Z]{1,4})-(\d{1,4})\b/);
          if (nearbyHyphenMatch && nearbyHyphenMatch[0]) {
            cardDetails.cardNumber = nearbyHyphenMatch[0];
            console.log(`Detected hyphenated card number ${nearbyHyphenMatch[0]} near brand line - high confidence`);
            return;
          }
          // Check for non-hyphenated alphanumeric card numbers (T119, TC12, BDP5)
          const nearbyAlphaNumMatch = nearbyLine.match(/^([A-Z]{1,3})(\d{1,4})$/);
          if (nearbyAlphaNumMatch) {
            const prefix = nearbyAlphaNumMatch[1];
            const digits = nearbyAlphaNumMatch[2];
            if (parseInt(digits) <= 999 && !/^(OF|IN|AT|TO|BY|OR|ON|IS|IT|AS|IF|UP|NO|SO|DO|AN|AM|BE|HE|WE|MY|US|THE|AND|FOR|ARE|BUT|NOT|YOU|ALL|HAS|HIS|HOW|ITS|MAY|OUR|OUT|WAY|WHO|DID|GET|HIM|LET|SAY|SHE|TOO|USE|MLB|NFL|NBA|NHL|USA|NL|AL|FT|LB|HR|AB|BB|SO|IP|ER|GS|SV|WL|GP|GF|RS|BA|HT|WT|ACQ)$/i.test(prefix)) {
              cardDetails.cardNumber = nearbyAlphaNumMatch[0];
              console.log(`Detected alphanumeric card number ${nearbyAlphaNumMatch[0]} near brand line - high confidence`);
              return;
            }
          }
          const nearbyNumberMatch = nearbyLine.match(/\b(\d{1,3})\b/);
          if (nearbyNumberMatch && nearbyNumberMatch[1]) {
            const number = nearbyNumberMatch[1];
            if (parseInt(number) > 0 && parseInt(number) < 1000 && !isDOBFormat(nearbyLine)) {
              cardDetails.cardNumber = number;
              console.log(`Detected card number ${number} near brand line - high confidence`);
              return;
            }
          }
        }
      }
    }
    
    // Check for hyphenated alphanumeric card numbers (BD-7, BDC-15, HRC-42, etc.)
    // These are high-confidence and should be checked before standalone numbers
    const nonCardCodePrefixes = new Set(['CMP', 'CODE', 'WWW', 'COM', 'INC', 'MLB', 'OBP', 'ERA', 'AVG', 'WAR', 'SLG', 'RBI', 'HT', 'WT', 'ACQ', 'RD', 'RND', 'PK', 'OVR']);
    const hyphenAlphaNumPatternEarly = /\b([A-Z]{1,4})-(\d{1,4})\b/g;
    let hyphenMatchEarly;
    while ((hyphenMatchEarly = hyphenAlphaNumPatternEarly.exec(text)) !== null) {
      const prefix = hyphenMatchEarly[1];
      const digits = hyphenMatchEarly[2];
      const fullMatch = hyphenMatchEarly[0];
      if (nonCardCodePrefixes.has(prefix)) continue;
      if (text.includes('CODE ' + fullMatch)) continue;
      if (parseInt(digits) > 999) continue;
      cardDetails.cardNumber = fullMatch;
      console.log(`Detected hyphenated card number: ${cardDetails.cardNumber}`);
      return;
    }
    
    // Alphanumeric patterns like: T27, T119, TC12, etc. (letter prefix + digits, no dash)
    // Check these BEFORE standalone numbers to avoid "59" overriding "T119"
    const alphaNumPatternEarly = /\b([A-Z]{1,3})(\d{1,4})\b/g;
    let alphaNumMatchEarly;
    
    while ((alphaNumMatchEarly = alphaNumPatternEarly.exec(text)) !== null) {
      const prefix = alphaNumMatchEarly[1];
      const digits = alphaNumMatchEarly[2];
      const fullMatch = alphaNumMatchEarly[0];
      
      if (nonCardCodePrefixes.has(prefix)) continue;
      if (text.includes('CODE ' + fullMatch)) continue;
      if (parseInt(digits) > 999) continue;
      // Skip patterns that look like brand abbreviations, common words, stat/bio prefixes, or draft round (RD)
      if (/^(OF|IN|AT|TO|BY|OR|ON|IS|IT|AS|IF|UP|NO|SO|DO|AN|AM|BE|HE|WE|MY|US|THE|AND|FOR|ARE|BUT|NOT|YOU|ALL|HAS|HIS|HOW|ITS|MAY|OUR|OUT|WAY|WHO|DID|GET|HIM|LET|SAY|SHE|TOO|USE|MLB|NFL|NBA|NHL|USA|NL|AL|FT|LB|LBS|HR|AB|BB|SO|IP|ER|GS|SV|WL|GP|GF|RS|BA|RD|RND|PK|OVR)$/i.test(prefix)) continue;
      // Skip if the match appears in a bio/stat line (case-insensitive search for the line)
      const lineWithAlphaNum = lines.find(line => line.toLowerCase().includes(fullMatch.toLowerCase()));
      if (lineWithAlphaNum && isDOBFormat(lineWithAlphaNum)) continue;
      if (lineWithAlphaNum && isPlayerBioNumber(digits, lineWithAlphaNum)) continue;
      // Skip if match appears in a DRAFTED/DRAFT/BORN/SIGNED biographical line
      if (lineWithAlphaNum && /\b(DRAFTED|DRAFT|BORN|SIGNED|OVERALL|ROUND|PICK|AGENT|FREE)\b/i.test(lineWithAlphaNum)) continue;
      
      cardDetails.cardNumber = fullMatch;
      console.log(`Detected Alphanumeric card number (early check): ${cardDetails.cardNumber}`);
      return;
    }
    
    // Second priority: Check if the very first line is ONLY a number
    // This is also a reliable way to detect card numbers at the top of a card
    const firstLine = lines[0].trim();
    if (/^\d+$/.test(firstLine) && parseInt(firstLine) > 0 && parseInt(firstLine) < 10000) {
      cardDetails.cardNumber = firstLine;
      console.log(`Detected standalone card number at top of card: ${cardDetails.cardNumber}`);
      return;
    }
    
    // Second attempt: Try to extract a number from the beginning of the first line
    const firstLineMatch = firstLine.match(/^(\d{1,4})\s/);
    if (firstLineMatch && firstLineMatch[1]) {
      const number = firstLineMatch[1];
      // Make sure it's a reasonable card number (1-9999)
      if (parseInt(number) > 0 && parseInt(number) < 10000) {
        cardDetails.cardNumber = number;
        console.log(`Detected card number at very beginning of OCR text: ${cardDetails.cardNumber}`);
        return;
      }
    }
    
    // Check the first 3 lines for a standalone number as fallback
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      const trimmedLine = lines[i].trim();
      // If the line is just a number and it's a reasonable card number (1-999)
      if (/^\d{1,3}$/.test(trimmedLine) && parseInt(trimmedLine) > 0 && parseInt(trimmedLine) < 1000) {
        cardDetails.cardNumber = trimmedLine;
        console.log(`Detected top card number: ${cardDetails.cardNumber}`);
        return;
      }
    }
    
    // Look for standalone numbers that might be card numbers
    // This catches single numbers like "206" on their own line (common in Opening Day cards)
    const textForStandalone = originalText || text;
    const standaloneNumberPattern = /(?:^|\n)\s*(\d{1,3})\s*(?:\n|$)/;
    const standaloneNumberMatch = textForStandalone.match(standaloneNumberPattern);
    
    if (standaloneNumberMatch && standaloneNumberMatch[1]) {
      // Make sure it's a reasonable card number (not too large)
      const number = standaloneNumberMatch[1];
      if (parseInt(number) < 1000) {
        cardDetails.cardNumber = number;
        console.log(`Detected standalone card number: ${cardDetails.cardNumber}`);
        return;
      }
    }
    
    // Alphanumeric patterns already checked earlier in priority chain
  } catch (error) {
    console.error('Error detecting card number:', error);
  }
}

/**
 * Extract card metadata (collection, brand, year) using context analysis
 */
function extractCardMetadata(text: string, cardDetails: Partial<CardFormValues>, originalText?: string): void {
  try {
    // BRAND DETECTION - Look for common card manufacturers with proper capitalization
    const brands = [
      { search: 'BOWMAN', display: 'Bowman' },
      { search: 'TOPPS', display: 'Topps' },
      { search: 'UPPER DECK', display: 'Upper Deck' },
      { search: 'PANINI', display: 'Panini' },
      { search: 'DONRUSS', display: 'Donruss' },
      { search: 'FLEER', display: 'Fleer' },
      { search: 'SCORE', display: 'Score' },
      { search: 'PLAYOFF', display: 'Playoff' },
      { search: 'LEAF', display: 'Leaf' },
      { search: 'PACIFIC', display: 'Pacific' },
      { search: 'SKYBOX', display: 'Skybox' },
      { search: 'SAGE', display: 'Sage' },
      { search: 'PRESS PASS', display: 'Press Pass' },
      { search: 'CLASSIC', display: 'Classic' },
      { search: 'PINNACLE', display: 'Pinnacle' },
      { search: 'ULTRA', display: 'Ultra' }
    ];
    
    // Use original text with newlines for brand detection to distinguish
    // contextual brand mentions from legal/trademark text
    const brandDetectionText = originalText || text;
    const brandLines = brandDetectionText.toUpperCase().split(/\r?\n/);
    const legalLinePattern = /(?:REGISTERED\s+)?TRADEMARK|ALL\s+RIGHTS\s+RESERVED|©|\(C\)|OFFICIALLY\s+LICENSED|THE\s+TOPPS\s+COMPANY|WWW\.\w+\.COM|CODE#|\b(?:TOPPS|BOWMAN|FLEER|DONRUSS|SCORE|LEAF|UPPER DECK|PANINI|PLAYOFF|PACIFIC|SKYBOX|PINNACLE)\b.*?\b(?:INC|LTD|CORP|LLC)\b|\b\d{4}\s+\w+.*?\b(?:INC|LTD|CORP|LLC)\b/i;
    
    // First pass: look for brand mentions in non-legal lines (high confidence)
    let brandFromLegal: string | null = null;
    for (const brand of brands) {
      let foundInNonLegal = false;
      let foundInLegal = false;
      const escapedSearch = brand.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const brandRegex = new RegExp(`\\b${escapedSearch}\\b`, 'i');
      for (const line of brandLines) {
        if (brandRegex.test(line)) {
          if (legalLinePattern.test(line)) {
            foundInLegal = true;
          } else {
            foundInNonLegal = true;
            break;
          }
        }
      }
      if (foundInNonLegal) {
        cardDetails.brand = brand.display;
        console.log(`Detected brand: ${cardDetails.brand} (from non-legal text)`);
        break;
      }
      if (foundInLegal && !brandFromLegal) {
        brandFromLegal = brand.display;
      }
    }
    
    // Fallback: use brand found only in legal text if no non-legal brand found
    if (!cardDetails.brand && brandFromLegal) {
      cardDetails.brand = brandFromLegal;
      console.log(`Detected brand: ${cardDetails.brand} (from legal text fallback)`);
    }
    
    // COLLECTION DETECTION - Look for common collections/sets
    // Prefer to use regex for collections to avoid false positives
    
    const collectionPatterns = [
      { pattern: /RIFLEMAN/i, name: "Rifleman" },
      { pattern: /CHROME STARS OF MLB|CSMLB/, name: "Stars of MLB", variant: "Chrome" },
      { pattern: /STARS OF MLB|SMLB/, name: "Stars of MLB" },
      { pattern: /HERITAGE/i, name: "Heritage" },
      { pattern: /ALLEN & GINTER|ALLEN AND GINTER/i, name: "Allen & Ginter" },
      { pattern: /BOWMAN CHROME/i, name: "Bowman Chrome" },
      { pattern: /PRIZM/i, name: "Prizm" },
      { pattern: /OPTIC/i, name: "Optic" },
      { pattern: /OPENING DAY/i, name: "Opening Day" },
      { pattern: /UPDATE SERIES/i, name: "Update Series" },
      { pattern: /GOLD LABEL/i, name: "Gold Label" },
      { pattern: /STADIUM CLUB/i, name: "Stadium Club" },
      { pattern: /35TH ANNIVERSARY/i, name: "35th Anniversary" },
      { pattern: /40\s*YEARS?\s+OF\s+BASEBALL/i, name: "40 Years of Baseball" },
      { pattern: /\d+\s*YEARS?\s+OF\s+BASEBALL/i, name: "Years of Baseball" },
      { pattern: /YEARS?\s+OF\s+BASEBALL/i, name: "Years of Baseball" },
      { pattern: /COLLECTOR'?S?[\s-]*CHOICE/i, name: "Collector's Choice", brandOverride: "Upper Deck" },
      { pattern: /SERIES ONE|SERIES 1/i, name: "Series One" },
      { pattern: /SERIES TWO|SERIES 2/i, name: "Series Two" },
      { pattern: /DONRUSS OPTIC/i, name: "Donruss Optic", brandOverride: "Panini" },
      { pattern: /\bULTRA\b/i, name: "Ultra" },
      { pattern: /\bSELECT\b/i, name: "Select" },
      { pattern: /\bMOSAIC\b/i, name: "Mosaic" },
      { pattern: /\bTRIBUTE\b/i, name: "Tribute" },
      { pattern: /\bGALLERY\b/i, name: "Gallery" },
      { pattern: /\bSKYLINES?\b/i, name: "Skylines" },
      { pattern: /\bDIAMOND KINGS?\b/i, name: "Diamond Kings" },
      { pattern: /\bBOWMAN DRAFT\b/i, name: "Draft" },
      { pattern: /\bBOWMAN BEST\b/i, name: "Bowman's Best" },
      { pattern: /\bARCHIVES?\b/i, name: "Archives" },
      { pattern: /\bFINEST\b/i, name: "Finest" },
      { pattern: /\bGYPSY QUEEN\b/i, name: "Gypsy Queen" }
    ];
    
    const legalTextPattern = /(?:REGISTERED\s+)?TRADEMARK|ALL\s+RIGHTS\s+RESERVED|©|\(C\)|OFFICIALLY\s+LICENSED|\b(?:TOPPS|BOWMAN|FLEER|DONRUSS|SCORE|LEAF|UPPER DECK|PANINI|PLAYOFF|PACIFIC|SKYBOX|PINNACLE)\b.*?\b(?:INC|LTD|CORP|LLC)\b|\b\d{4}\s+\w+.*?\b(?:INC|LTD|CORP|LLC)\b/i;
    const rawLines = (originalText || text).toUpperCase().split(/\r?\n/);
    const filteredLines = rawLines.filter(line => !legalTextPattern.test(line));
    const nonLegalText = filteredLines.length > 0 ? filteredLines.join(' ') : text;
    
    const fullTextUpper = (originalText || text).toUpperCase().replace(/\r?\n/g, ' ');
    
    const applyCollectionMatch = (collectionData: typeof collectionPatterns[0], matchText: string, source: string) => {
      if (collectionData.name) {
        if (collectionData.name === 'Years of Baseball') {
          const yobMatch = matchText.match(/(\d+)\s*YEARS?\s+OF\s+BASEBALL/i);
          cardDetails.collection = yobMatch ? `${yobMatch[1]} Years of Baseball` : collectionData.name;
        } else {
          cardDetails.collection = collectionData.name;
        }
        console.log(`Detected collection${source}: ${cardDetails.collection}`);
      }
      if (collectionData.variant) {
        cardDetails.variant = collectionData.variant;
        console.log(`Detected variant${source}: ${cardDetails.variant}`);
      }
      if (collectionData.brandOverride) {
        cardDetails.brand = collectionData.brandOverride;
        console.log(`Brand override${source} for ${cardDetails.collection}: ${cardDetails.brand}`);
      }
    };

    for (const collectionData of collectionPatterns) {
      if (nonLegalText.match(collectionData.pattern)) {
        applyCollectionMatch(collectionData, nonLegalText, '');
        break;
      }
    }
    
    if (!cardDetails.collection) {
      for (const collectionData of collectionPatterns) {
        if (fullTextUpper.match(collectionData.pattern)) {
          applyCollectionMatch(collectionData, fullTextUpper, ' from legal/full text fallback');
          break;
        }
      }
    }
    
    if (!cardDetails.variant && /\bCHROME\b/i.test(nonLegalText)) {
      const collectionHasChrome = cardDetails.collection && /chrome/i.test(cardDetails.collection);
      if (cardDetails.collection && !collectionHasChrome) {
        cardDetails.variant = 'Chrome';
        console.log(`Detected Chrome as variant (collection already set to "${cardDetails.collection}")`);
      } else if (!cardDetails.collection) {
        cardDetails.collection = 'Chrome';
        console.log(`Detected Chrome as collection (no other collection found)`);
      }
    }
    
    // YEAR DETECTION - Look for copyright years and isolated 4-digit years
    // Important: Look for copyright symbols as they usually indicate production year
    
    // First check for year followed by brand company name - highest confidence source
    // Handles: "2024 THE TOPPS COMPANY", "2025 TOPPS, INC", "1991 SCORE INC"
    const brandYearPattern = /(\d{4})\s+(?:THE\s+)?(TOPPS|LEAF|BOWMAN|FLEER|DONRUSS|SCORE|UPPER DECK|PANINI)(?:\s+COMPANY|\s+INC\.?|,\s+INC\.?)?/i;
    const brandYearMatch = text.match(brandYearPattern);
    
    if (brandYearMatch && brandYearMatch[1]) {
      const year = parseInt(brandYearMatch[1], 10);
      if (year >= 1900 && year <= new Date().getFullYear()) {
        cardDetails.year = year;
        console.log(`Using brand year as card date: ${cardDetails.year}`);
        return;
      }
    }
    
    // Check for copyright year pattern next
    // Also handles OCR-garbled copyright symbols like "LO2024", "IO2024", "O2024" which are common OCR misreads of "© 2024"
    const copyrightYearPattern = /(?:©|\(C\)|\&copy;|\&\s*©|\&\s*\(C\)|[LlIi]?[OoQ])(?:\s*)(\d{4})/i;
    const copyrightMatch = text.match(copyrightYearPattern);
    
    if (copyrightMatch && copyrightMatch[1]) {
      const year = parseInt(copyrightMatch[1], 10);
      if (year >= 1900 && year <= new Date().getFullYear()) {
        cardDetails.year = year;
        console.log(`Using copyright year as card date: ${cardDetails.year}`);
        return;
      }
    }
    
    // Check for "YEAR Team" pattern often used in older cards
    const yearTeamPattern = /\b(19\d{2}|20\d{2})\s+(REDS|YANKEES|CUBS|DODGERS|GIANTS|BRAVES|ATHLETICS|ANGELS|CARDINALS|BLUE JAYS|WHITE SOX|RED SOX|PIRATES|MARLINS|RANGERS|NATIONALS|MARINERS|TIGERS|TWINS|ROYALS|INDIANS|GUARDIANS|DIAMONDBACKS|ROCKIES|PADRES|RAYS|PHILLIES|METS|ASTROS|BREWERS|ORIOLES)\b/i;
    const yearTeamMatch = text.match(yearTeamPattern);
    
    if (yearTeamMatch && yearTeamMatch[1]) {
      const year = parseInt(yearTeamMatch[1], 10);
      if (year >= 1900 && year <= new Date().getFullYear()) {
        cardDetails.year = year;
        console.log(`Using team-year pattern as card date: ${cardDetails.year}`);
        return;
      }
    }
    
    // Fall back to looking for 4-digit years (but this is less reliable)
    // This is more risky as it can pick up birth years
    const yearPattern = /\b(19\d{2}|20\d{2})\b/;
    const yearMatches = text.match(new RegExp(yearPattern, 'g')) || [];
    
    if (yearMatches.length > 0) {
      // Get all matches and find the most likely card year
      const years = yearMatches
        .map(match => parseInt(match.replace(/[^\d]/g, ''), 10))
        .filter(year => year >= 1900 && year <= new Date().getFullYear());
      
      if (years.length > 0) {
        // When multiple years are found, prefer years from 1980-2025 as card years
        // since these are most likely to be production years not birth years
        const modernYears = years.filter(year => year >= 1980 && year <= 2025);
        if (modernYears.length > 0) {
          cardDetails.year = modernYears[0];
          console.log(`Selected modern year as most likely card date: ${cardDetails.year}`);
        } else {
          cardDetails.year = years[0];
          console.log(`Using first detected year as card date: ${cardDetails.year}`);
        }
      }
    }
  } catch (error) {
    console.error('Error detecting card metadata:', error);
  }
}

/**
 * Extract serial number if present using enhanced detection
 */
async function extractSerialNumber(text: string, cardDetails: Partial<CardFormValues>, textAnnotations?: any[]): Promise<void> {
  try {
    // Use the enhanced serial number detector
    const { detectSerialNumber } = await import('./serialNumberDetector');
    const result = detectSerialNumber(text, textAnnotations || []);
    
    if (result.isNumbered) {
      cardDetails.serialNumber = result.serialNumber;
      cardDetails.isNumbered = true;
      console.log(`Enhanced detection found serial number via ${result.detectionMethod}: ${result.serialNumber}`);
    } else {
      console.log("No serial number found via enhanced detection");
    }
  } catch (error) {
    console.error('Error in enhanced serial number detection:', error);
    
    // Fallback to simple pattern matching if enhanced detection fails
    const simplePattern = /\b(\d{1,3}\/\d{2,4})\b/;
    const match = text.match(simplePattern);
    if (match && match[1]) {
      cardDetails.serialNumber = match[1];
      cardDetails.isNumbered = true;
      console.log(`Fallback detection found serial number: ${match[1]}`);
    }
  }
}

/**
 * Detect special card features (rookie, autograph, etc.)
 */
function detectCardFeatures(text: string, cardDetails: Partial<CardFormValues>): void {
  try {
    // Check for special card types that are NOT rookie cards
    const isHomeRunChallengeCard = 
      text.includes('HOME RUN CHALLENGE') || 
      text.includes('HR CHALLENGE') || 
      (cardDetails.cardNumber && cardDetails.cardNumber.startsWith('HRC-'));
    
    // If it's a Home Run Challenge card, explicitly mark as NOT a rookie card
    if (isHomeRunChallengeCard) {
      cardDetails.isRookieCard = false;
      console.log("Identified as Home Run Challenge card - not a rookie card");
      return;
    }
    
    // ROOKIE CARD DETECTION
    // Check for explicit rookie indicators
    const rookiePatterns = [
      /\bRC\b/,
      /\bROOKIE\s+CARD\b/i,
      /\bROOKIE\b/i,
      /\b1ST\s+BOWMAN\b/i,
      /\b1ST\s+CARD\b/i,
      /\bFIRST\s+BOWMAN\b/i,
      /\bFIRST\s+CARD\b/i,
      /\bDEBUT\s+CARD\b/i
    ];
    
    for (const pattern of rookiePatterns) {
      if (text.match(pattern)) {
        cardDetails.isRookieCard = true;
        console.log("Detected rookie card status");
        break;
      }
    }
    
    // AUTOGRAPHED CARD DETECTION
    // Check for autograph indicators
    const autographPatterns = [
      /\bAUTOGRAPH\b/i,
      /\bAUTO\b/i,
      /\bSIGNED\b/i,
      /\bSIGNATURE\b/i,
      /\bCERTIFIED\s+AUTOGRAPH\b/i
    ];
    
    for (const pattern of autographPatterns) {
      if (text.match(pattern)) {
        cardDetails.isAutographed = true;
        console.log("Detected autographed card status");
        break;
      }
    }
    
    // FOIL VARIANT DETECTION
    console.log(`=== FOIL DETECTION DEBUG ===`);
    console.log(`OCR text for foil detection: "${text}"`);
    console.log(`Text length: ${text.length}`);
    console.log(`Card is numbered: ${cardDetails.isNumbered}`);
    console.log(`Serial number: ${cardDetails.serialNumber}`);
    
    // Use the imported foil variant detector
    const foilResult = detectFoilVariant(text);
    console.log(`Foil detection result:`, foilResult);
    
    // TEMPORARILY DISABLE ALL FOIL DETECTION IN detectCardFeatures
    console.log('TEMP: Skipping all foil detection in detectCardFeatures - will be handled in dual-side combine function');
    console.log(`Foil indicators found: [${foilResult.indicators.join(', ')}]`);
    /*
    if (foilResult.isFoil) {
      cardDetails.isFoil = true;
      cardDetails.foilType = foilResult.foilType;
      console.log(`✅ Detected foil variant: ${foilResult.foilType} (confidence: ${foilResult.confidence})`);
      console.log(`Foil indicators: ${foilResult.indicators.join(', ')}`);
      
      // For numbered cards, likely aqua foil or similar special variant
      if (cardDetails.isNumbered && cardDetails.serialNumber) {
        // Check if it's a low-numbered card (likely premium foil)
        const serialMatch = cardDetails.serialNumber.match(/(\d+)\/(\d+)/);
        if (serialMatch) {
          const total = parseInt(serialMatch[2]);
          if (total <= 999) { // Most aqua foils are /399 or similar
            cardDetails.foilType = 'Aqua Foil';
            cardDetails.variant = 'Aqua Foil';
            console.log(`Updated to Aqua Foil variant based on serial number: ${cardDetails.serialNumber}`);
          }
        }
      }
    } else {
      // Enhanced visual-based foil detection for cards with limited OCR text
      // This is common with foil cards due to reflective surfaces interfering with OCR
      if (text.length < 50 && cardDetails.isNumbered) {
        // Short OCR text + numbered card often indicates foil
        cardDetails.isFoil = true;
        cardDetails.foilType = 'Aqua Foil';
        cardDetails.variant = 'Aqua Foil';
        console.log('✅ Detected Aqua Foil variant based on limited OCR text and numbered status');
      } else {
        // Special case for Topps Series Two numbered cards
        // Looking at the OCR pattern: "LOPPS\nEW YORK\nSEAN\nMANAEA P"
        if (cardDetails.isNumbered && cardDetails.serialNumber && 
            (text.includes('LOPPS') || text.includes('TOPPS'))) {
          const serialMatch = cardDetails.serialNumber.match(/(\d+)\/(\d+)/);
          if (serialMatch) {
            const total = parseInt(serialMatch[2]);
            if (total <= 999) { // Low numbered parallels are usually foil variants
              cardDetails.isFoil = true;
              cardDetails.foilType = 'Aqua Foil';
              cardDetails.variant = 'Aqua Foil';
              console.log('✅ Detected Aqua Foil based on Topps + low serial number pattern');
            }
          }
        }
      }
    }
    */
    
    console.log(`Final foil status: isFoil=${cardDetails.isFoil}, foilType=${cardDetails.foilType}`);
    console.log(`=== END FOIL DETECTION ===`);
  } catch (error) {
    console.error('Error detecting card features:', error);
  }
}

/**
 * Detect the sport category of the card using context clues
 */
function detectSport(text: string, cardDetails: Partial<CardFormValues>): void {
  try {
    console.log(`=== SPORT DETECTION START ===`);
    console.log(`Input text (first 200 chars): ${text.substring(0, 200)}`);
    console.log(`Current sport before detection: ${cardDetails.sport}`);
    console.log(`Current player: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
    
    // If sport is already explicitly set to non-baseball, don't override it
    if (cardDetails.sport && cardDetails.sport !== 'Baseball' && cardDetails.sport !== '') {
      console.log(`Sport already set to ${cardDetails.sport}, skipping detection`);
      return;
    }
    
    // First, check for explicit sport indicators that should override everything else
    if (text.match(/\bBASKETBALL\b|\bNBA\b|\bNATIONAL BASKETBALL ASSOCIATION\b/i)) {
      cardDetails.sport = "Basketball";
      console.log("Sport detected (explicit indicator): Basketball");
      return;
    }
    else if (text.match(/\bBASEBALL CARD\b|\bMAJOR LEAGUE BASEBALL\b|\bMLB\b/i)) {
      cardDetails.sport = "Baseball";
      console.log("Sport detected (explicit indicator): Baseball");
      return;
    } 
    else if (text.match(/\bFOOTBALL CARD\b|\bNATIONAL FOOTBALL LEAGUE\b|\bNFL\b/i)) {
      cardDetails.sport = "Football";
      console.log("Sport detected (explicit indicator): Football");
      return;
    } 
    else if (text.match(/\bHOCKEY CARD\b|\bNATIONAL HOCKEY LEAGUE\b|\bNHL\b/i)) {
      cardDetails.sport = "Hockey";
      console.log("Sport detected (explicit indicator): Hockey");
      return;
    } 
    else if (text.match(/\bSOCCER CARD\b|\bMAJOR LEAGUE SOCCER\b|\bMLS\b|\bFIFA\b/i)) {
      cardDetails.sport = "Soccer";
      console.log("Sport detected (explicit indicator): Soccer");
      return;
    }
    
    // For card collections with known sports
    if (text.includes("STARS OF MLB") || text.includes("SMLB-")) {
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
      { term: /\bMLB\b|\bMAJOR LEAGUE BASEBALL\b/i, weight: 3 },
      { term: /\bBASEBALL\b/i, weight: 3 },
      { term: /\bWORLD SERIES\b/i, weight: 3 },
      { term: /\bYANKEES\b|\bRED SOX\b|\bDODGERS\b|\bCUBS\b|\bGIANTS\b|\bCARDINALS\b|\bBRAVES\b|\bASTROS\b|\bPHILLIES\b|\bNATIONALS\b|\bMETS\b|\bBLUE JAYS\b|\bANGELS\b|\bRANGERS\b|\bMARINERS\b|\bROYALS\b|\bMARLINS\b|\bATHLETICS\b|\bTWINS\b|\bBREWERS\b|\bGUARDIANS\b|\bINDIANS\b|\bPIRATES\b|\bPADRES\b|\bRAYS\b|\bORIOLES\b|\bROCKIES\b|\bDIAMONDBACKS\b|\bWHITE SOX\b|\bREDS\b|\bTIGERS\b/i, weight: 2 },
      { term: /\bPITCHER\b|\bCATCHER\b|\bFIRST BASE\b|\bSECOND BASE\b|\bTHIRD BASE\b|\bSHORTSTOP\b|\bOUTFIELDER\b|\bINFIELDER\b|\bDESIGNATED HITTER\b/i, weight: 2 },
      { term: /\b1B\b|\b2B\b|\b3B\b|\bSS\b|\bOF\b|\bLF\b|\bCF\b|\bRF\b|\bDH\b/i, weight: 2 },
      { term: /\bHOME RUN\b|\bHOMERUN\b|\bRBI\b|\bERN\b|\bBATTING\b|\bPITCHING\b|\bHITTER\b|\bMOUND\b|\bINNING\b|\bBULLPEN\b|\bBAT\b|\bGLOVE\b/i, weight: 1 },
      { term: /\bMLB DEBUT\b|\bROOKIE CARD\b|\bALL[\s-]STAR\b/i, weight: 1 }
    ];
    
    // FOOTBALL KEYWORDS WITH WEIGHTS
    const footballKeywords = [
      { term: /\bNFL\b|\bNATIONAL FOOTBALL LEAGUE\b/i, weight: 3 },
      { term: /\bFOOTBALL\b/i, weight: 3 },
      { term: /\bSUPER BOWL\b/i, weight: 3 },
      { term: /\bPATRIOTS\b|\bCOWBOYS\b|\bPACKERS\b|\b49ERS\b|\bSTEELERS\b|\bBRONCOS\b|\bSEAHAWKS\b|\bRAVENS\b|\bCHIEFS\b|\bEAGLES\b|\bRAIMS\b|\bVIKINGS\b|\bRAIDERS\b|\bGIANTS\b|\bCOLTS\b|\bBEARS\b|\bPANTHERS\b|\bCHARGERS\b|\bSAINTS\b|\bTITANS\b|\bBENGALS\b|\bJETS\b|\bBILLS\b|\bBUCCANEERS\b|\bBROWNS\b|\bCOMMANDERS\b|\bLIONS\b|\bJAGUARS\b|\bTEXANS\b|\bDOLPHINS\b|\bCARDINALS\b|\bFALCONS\b/i, weight: 2 },
      { term: /\bQUARTERBACK\b|\bQB\b|\bRUNNING BACK\b|\bRB\b|\bWIDE RECEIVER\b|\bWR\b|\bTIGHT END\b|\bTE\b|\bOFFENSIVE LINE\b|\bOL\b|\bTACKLE\b|\bGUARD\b|\bCENTER\b|\bDEFENSIVE END\b|\bDE\b|\bDEFENSIVE TACKLE\b|\bDT\b|\bLINEBACKER\b|\bLB\b|\bCORNERBACK\b|\bCB\b|\bSAFETY\b|\bKICKER\b|\bPUNTER\b/i, weight: 2 },
      { term: /\bTOUCHDOWN\b|\bTD\b|\bYARD\b|\bSACK\b|\bINTERCEPTION\b|\bINT\b|\bFUMBLE\b|\bFIELD GOAL\b|\bFG\b|\bPUNT\b|\bKICKOFF\b|\bPASS\b|\bRUSH\b|\bBLOCK\b|\bPASS COMPLETION\b|\bDRAFT PICK\b/i, weight: 1 }
    ];
    
    // BASKETBALL KEYWORDS WITH WEIGHTS
    const basketballKeywords = [
      { term: /\bNBA\b|\bNATIONAL BASKETBALL ASSOCIATION\b/i, weight: 3 },
      { term: /\bBASKETBALL\b/i, weight: 3 },
      { term: /\bLAKERS\b|\bCELTICS\b|\bBULLS\b|\bWARRIORS\b|\bSPURS\b|\bHEAT\b|\bKNICKS\b|\bNETS\b|\bMAVERICKS\b|\bSIXERS\b|\b76ERS\b|\bCLIPPERS\b|\bROCKETS\b|\bBUCKS\b|\bTHUNDER\b|\bCAVALIERS\b|\bCAVS\b|\bNUGGETS\b|\bGRIZZLIES\b|\bTRAIL BLAZERS\b|\bBLAZERS\b|\bJAZZ\b|\bSUNS\b|\bHAWKS\b|\bHORNETS\b|\bPACERS\b|\bKINGS\b|\bTIMBERWOLVES\b|\bWOLVES\b|\bPELICANS\b|\bRAPTORS\b|\bMAGIC\b|\bWIZARDS\b|\bPISTONS\b/i, weight: 2 },
      { term: /\bPOINT GUARD\b|\bPG\b|\bSHOOTING GUARD\b|\bSG\b|\bSMALL FORWARD\b|\bSF\b|\bPOWER FORWARD\b|\bPF\b|\bCENTER\b|\bC\b/i, weight: 2 },
      { term: /\bPOINTS\b|\bPTS\b|\bREBOUNDS\b|\bREB\b|\bASSISTS\b|\bAST\b|\bSTEALS\b|\bSTL\b|\bBLOCKS\b|\bBLK\b|\bDUNK\b|\bTHREE-POINTER\b|\b3-POINTER\b|\bFREE THROW\b|\bFT\b|\bDOUBLE-DOUBLE\b|\bTRIPLE-DOUBLE\b/i, weight: 1 }
    ];
    
    // HOCKEY KEYWORDS WITH WEIGHTS
    const hockeyKeywords = [
      { term: /\bNHL\b|\bNATIONAL HOCKEY LEAGUE\b/i, weight: 3 },
      { term: /\bHOCKEY\b/i, weight: 3 },
      { term: /\bSTANLEY CUP\b/i, weight: 3 },
      { term: /\bBLACKHAWKS\b|\bBRUINS\b|\bCANADIENS\b|\bMAP.E LEAFS\b|\bRED WINGS\b|\bLIGHTNING\b|\bAVALANCHE\b|\bPENGUINS\b|\bRANGERS\b|\bFLYERS\b|\bCAPITALS\b|\bSTARS\b|\bKINGS\b|\bSHARKS\b|\bBLUES\b|\bISLANDERS\b|\bGOLDEN KNIGHTS\b|\bDUCKS\b|\bJETS\b|\bWILD\b|\bHURRICANES\b|\bPREDATORS\b|\bPANTHERS\b|\bFLAMES\b|\bSABRES\b|\bOILERS\b|\bBLUE JACKETS\b|\bCANUCKS\b|\bDEVILS\b|\bSENATORS\b|\bKRAKEN\b|\bCOYOTES\b/i, weight: 2 },
      { term: /\bCENTER\b|\bWINGER\b|\bLEFT WING\b|\bRIGHT WING\b|\bDEFENSEMAN\b|\bGOALIE\b|\bGOALTENDER\b/i, weight: 2 },
      { term: /\bGOAL\b|\bASSIST\b|\bSAVE\b|\bSHOT\b|\bPENALTY\b|\bPOWER PLAY\b|\bSHORT-HANDED\b|\bFACEOFF\b|\bCHECK\b|\bSLAP SHOT\b|\bWRIST SHOT\b|\bPUCK\b|\bSTICK\b|\bSKATES\b/i, weight: 1 }
    ];
    
    // SOCCER KEYWORDS WITH WEIGHTS
    const soccerKeywords = [
      { term: /\bMLS\b|\bMAJOR LEAGUE SOCCER\b|\bFIFA\b/i, weight: 3 },
      { term: /\bSOCCER\b|\bFOOTBALL\b/i, weight: 3 }, // Note: "FOOTBALL" will also match for American football
      { term: /\bWORLD CUP\b/i, weight: 3 },
      { term: /\bUNITED\b|\bCITY\b|\bFC\b|\bGALAXY\b|\bCREW\b|\bINTER\b|\bDYNAMO\b|\bREVOLUTION\b|\bTIMBERS\b|\bSOUNDERS\b|\bREAL\b|\bSPORTING\b|\bRAPIDS\b|\bWHITECAPS\b|\bIMPACT\b|\bLOONS\b|\bNYCFC\b|\bORLANDO\b|\bUNION\b/i, weight: 1 }, // MLS/soccer team patterns
      { term: /\bFORWARD\b|\bSTRIKER\b|\bMIDFIELDER\b|\bDEFENDER\b|\bGOALKEEPER\b|\bGOALIE\b|\bFULLBACK\b|\bWINGER\b/i, weight: 2 },
      { term: /\bGOAL\b|\bASSIST\b|\bPENALTY\b|\bRED CARD\b|\bYELLOW CARD\b|\bFREE KICK\b|\bCORNER KICK\b|\bPENALTY KICK\b|\bOFFSIDE\b|\bDRIBBLE\b|\bPASS\b|\bSHOT\b|\bCLEAN SHEET\b/i, weight: 1 }
    ];
    
    // Process the keyword lists to calculate scores
    for (const keyword of baseballKeywords) {
      if (text.match(keyword.term)) {
        baseballScore += keyword.weight;
      }
    }
    
    for (const keyword of footballKeywords) {
      if (text.match(keyword.term)) {
        footballScore += keyword.weight;
      }
    }
    
    for (const keyword of basketballKeywords) {
      if (text.match(keyword.term)) {
        basketballScore += keyword.weight;
      }
    }
    
    for (const keyword of hockeyKeywords) {
      if (text.match(keyword.term)) {
        hockeyScore += keyword.weight;
      }
    }
    
    for (const keyword of soccerKeywords) {
      if (text.match(keyword.term)) {
        soccerScore += keyword.weight;
      }
    }
    
    // Create a sorted array of scores
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
    
    // If highest score is zero, set to "Not detected"
    if (sportScores[0].score === 0) {
      cardDetails.sport = "Not detected"; // No default sport
      console.log("No sport indicators found, setting to 'Not detected'");
    } else {
      // Use sport with highest score
      cardDetails.sport = sportScores[0].sport;
      console.log(`Sport detected with highest score (${sportScores[0].score}): ${cardDetails.sport}`);
    }
    console.log(`=== SPORT DETECTION END ===`);
    console.log(`Final sport: ${cardDetails.sport}`);
  } catch (error) {
    console.error('Error detecting sport:', error);
    // Set to "Not detected" if there's an error
    cardDetails.sport = "Not detected";
    console.log(`Sport detection error, set to: ${cardDetails.sport}`);
  }
}