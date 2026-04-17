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
export async function analyzeSportsCardImage(
  base64Image: string,
  side: 'front' | 'back' | 'unknown' = 'unknown'
): Promise<Partial<CardFormValues>> {
  try {
    console.log(`=== STARTING DYNAMIC CARD ANALYSIS (side=${side}) ===`);
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
    
    // Pre-process: join split card numbers where OCR breaks them across lines
    // e.g., "T91-\n13" becomes "T91-13" before whitespace collapse
    const joinedText = fullText.replace(/\b([A-Z]{1,4}\d*)-\s*\n\s*(\d{1,4})\b/gm, '$1-$2');

    // Parse all extracted text
    const cleanText = joinedText.toUpperCase().replace(/\s+/g, ' ').trim();
    
    // PLAYER NAME DETECTION - Extract player name using positional and context analysis
    extractPlayerName(cleanText, cardDetails, joinedText);
    
    // CARD NUMBER DETECTION - Extract card number using regex patterns
    // Pass textAnnotations so the detector can prefer top-of-card matches and
    // reject middle/bottom matches like graphic insert text (e.g. "CALL-UP").
    // The `side` hint lets the detector log which face the chosen candidate
    // came from and (eventually) lets the dual-side combiner rank back over
    // front candidates without needing to re-derive the source.
    extractCardNumber(cleanText, cardDetails, joinedText, textAnnotations, side);
    
    // COLLECTION, BRAND & YEAR DETECTION - Extract using pattern recognition
    extractCardMetadata(cleanText, cardDetails, joinedText);
    
    // SERIAL NUMBER DETECTION - Look for serial numbering with enhanced detection
    // Pass original multi-line text so line-by-line pattern matching works correctly
    await extractSerialNumber(joinedText, cardDetails, textAnnotations);

    // FOCUSED SERIAL RECOVERY (front side only) - run a high-contrast OCR pass
    // when the regular OCR either missed the serial entirely or only managed to
    // recover the limit ("/150") via the fuzzy fallback. Foil-stamped serials
    // over busy card art (jersey pinstripes, gradient star backgrounds, etc.)
    // routinely defeat the standard Vision pass; the enhanced-contrast pipeline
    // recovers them without affecting the colour-image foil/parallel detector,
    // which still uses the original unmodified buffer downstream.
    if (side === 'front') {
      const initialSerial = (cardDetails.serialNumber || '').trim();
      const haveCompleteSerial =
        initialSerial.length > 0 && !initialSerial.startsWith('/');
      if (!haveCompleteSerial) {
        try {
          const { runFocusedSerialOCR } = await import('./focusedSerialOCR');
          const focused = await runFocusedSerialOCR(base64Image);
          if (focused?.isNumbered && focused.serialNumber) {
            const focusedHasNumerator = !focused.serialNumber.startsWith('/');
            // Adopt the focused result if it's strictly more informative:
            //  - we had nothing → take whatever it found
            //  - we had a limit-only "/150" → take a full "041/150" if available,
            //    otherwise keep the limit
            if (!initialSerial || focusedHasNumerator) {
              console.log(
                `[FocusedOCR] Replacing serial "${initialSerial || '(none)'}" with focused result "${focused.serialNumber}"`
              );
              cardDetails.serialNumber = focused.serialNumber;
              cardDetails.isNumbered = true;
            }
          }
        } catch (err: any) {
          console.warn('[FocusedOCR] Skipped (non-fatal):', err?.message || err);
        }
      }
    }
    
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

    // CMP CODE DETECTION - Look for CMP reference codes in the fine print on the back of a card
    // These appear as "CMP" followed by 4–10 digits (e.g. "CMP100358") in the copyright/legal text.
    extractCmpNumber(fullText, cardDetails);
    
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
      'BASEBALL', 'FOOTBALL', 'BASKETBALL', 'HOCKEY', 'SOCCER',
      'CARD', 'ROOKIE', 'STARS', 'MLB', 'NBA', 'NFL', 'NHL', 'MLS', 'TILB', 'SMLB',
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
      'REFRACTOR', 'FOIL', 'GOLD', 'SILVER', 'BRONZE', 'PLATINUM', 'SAPPHIRE', 'BLACK',
      'OFFICIALLY', 'LICENSED', 'PRODUCT', 'TRADEMARKS', 'COPYRIGHTS', 'RESERVED', 'RIGHTS',
      'REGISTERED', 'COMPANY', 'INC', 'VISIT', 'CODE', 'WWW', 'COM',
      'THE', 'AND', 'FOR', 'WITH', 'FROM', 'THAT', 'THIS', 'WAS', 'OVER', 'WENT',
      'KEPT', 'GOING', 'REACHED', 'BASE', 'CLIP', 'THOSE', 'MONTHS', 'PLAYERS',
      'JUNE', 'JULY', 'MAY', 'AUGUST', 'SEPTEMBER', 'OCTOBER',
      'HUGE', 'PART', 'LEADOFF', 'MAN', 'OBP', 'ERA', 'AVG', 'RBI', 'WAR',
      'CHOICE', 'WEB', 'PLAYERA', 'TAPPS', 'XTOPPS', 'ITALICS', 'LEADER', 'TIE',
      'TOTALS', 'MAJ', 'LEA', 'CUBS', 'NATIONALS',
      // Common birthplace/hometown abbreviations that look like names
      'VENEZ', 'VENEZUELA', 'DOMINICAN', 'REPUBLIC', 'MEXICO', 'CUBA', 'PANAMA', 'COLOMBIA',
      'CANADA', 'JAPAN', 'KOREA', 'AUSTRALIA', 'PUERTO', 'RICO',
      // Set/product/collection words that can be confused for player names
      'PIXEL', 'PORTRAITS', 'PORTRAIT', 'FINEST', 'FUTURES', 'ROOKIES', 'GALLERY',
      'ICONS', 'CONTENDERS', 'PRESTIGE', 'CHRONICLES', 'HARDWARE', 'ELITE',
      'IMMACULATE', 'LUMINANCE', 'SPECTRA', 'OBSIDIAN', 'NOIR', 'OPTIC',
      'THREADS', 'CERTIFIED', 'ABSOLUTE', 'LIMITED', 'TRIBUTE', 'BRILLIANCE',
      'CLASSICS', 'LEGENDS', 'PROSPECTS', 'SIGNATURES', 'AUTOGRAPHS', 'PARALLELS',
      'AUTOGRAPH', 'ISSUE', 'ISSUES',
      'VALUED', 'PRIVATE', 'EXCLUSIVE', 'PREMIER', 'PRIME',
      'NATIONAL', 'DIGITAL', 'VINTAGE', 'RETRO', 'REVIVAL', 'REPRINT',
      // Stat/bio terms that appear on card backs and can look like 2-word names
      'AVERAGE', 'AGAINST', 'EARNED', 'OPPONENT', 'BATTERS', 'FACED',
      'INNINGS', 'PITCHED', 'STRIKEOUT', 'STRIKEOUTS', 'COMPLETE', 'SHUTOUT',
      'GAMES', 'STARTED', 'HOLDS', 'SAVES', 'WALKS', 'ALLOWED',
      'ALSO', 'PACED', 'PACES', 'LED', 'HIS', 'WHILE', 'DURING', 'THEIR',
      'POSTED', 'HELPED', 'BECAME', 'AMONG', 'MADE', 'RANKED', 'NAMED',
      'PITTSBURGH', 'HOUSTON', 'TORONTO', 'SEATTLE', 'OAKLAND', 'TAMPA', 'MIAMI',
      'MINNESOTA', 'CINCINNATI', 'MILWAUKEE', 'DETROIT', 'CLEVELAND', 'BALTIMORE',
      'ARIZONA', 'COLORADO', 'TEXAS', 'DENVER', 'MONTREAL', 'WASHINGTON',
    ]);
    
    const isNonNameWord = (word: string): boolean => {
      const cleaned = word.toUpperCase().replace(/(?:TM|™|®|\.+)$/gi, '');
      return nonNameWords.has(cleaned) || word.length <= 1 || /^\d/.test(word);
    };
    
    // Unicode-aware letter check: matches A-Z plus common accented/diacritical characters
    // Used so names like "JOSÉ BUTTÓ", "HERNÁNDEZ", "PEÑA" are not filtered out
    const isValidNameChar = /^[A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'\-\.]+$|^[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ]{2,}$/;

    const potentialNames: Array<{firstName: string, lastName: string, source: string, priority: number}> = [];
    
    const rawLines = (originalText || text).split('\n');
    
    // Bio-info line prefixes — these lines contain biographical data, never player names
    const bioPrefixPattern = /^(BORN|HOME|ACQ|SIGNED|DRAFTED|HT|WT|HEIGHT|WEIGHT|BATS|THROWS)[\s:]/i;

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (!line) continue;
      
      // Skip biographical info lines entirely — they contain birthplace/hometown that can
      // look like player names (e.g. "HOME: CUMANA, VENEZ." → "Cumana Venez.")
      if (bioPrefixPattern.test(line)) continue;

      const words = line.split(/\s+/).filter(w => w.length > 0);
      
      if (words.length >= 2 && words.length <= 5) {
        let nameWords = words
          .map(w => w.replace(/[,;]+$/, ''))
          .filter(w => isValidNameChar.test(w))
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
              /PHILLIES|YANKEES|DODGERS|METS|CUBS|BRAVES|ASTROS|RANGERS|PADRES|GIANTS|CARDINALS|NATIONALS|ORIOLES|GUARDIANS|TWINS|RAYS|MARLINS|PIRATES|REDS|BREWERS|TIGERS|ROYALS|ATHLETICS|MARINERS|ANGELS|ROCKIES|DIAMONDBACKS|OUTFIELDER|INFIELDER|PITCHER|CATCHER|SHORTSTOP|BASEMAN|STARTING|CLOSER|RELIEVER/i.test(rawLines[i + 1]);
            
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
          const allAlphaRemaining = remainingWords.every(w => isValidNameChar.test(w));
          const noNonNameWordsRemaining = remainingWords.every(w => !isNonNameWord(w));
          const noNumbersRemaining = remainingWords.every(w => !/\d/.test(w));
          const eachWordLenRemaining = remainingWords.every(w => w.length >= 2);
          
          if (allAlphaRemaining && noNonNameWordsRemaining && noNumbersRemaining && eachWordLenRemaining) {
            const firstName = remainingWords[0].charAt(0).toUpperCase() + remainingWords[0].slice(1).toLowerCase();
            const lastName = remainingWords.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
            
            const isFollowedByTeamPosition = (i + 1 < rawLines.length) && 
              /PHILLIES|YANKEES|DODGERS|METS|CUBS|BRAVES|ASTROS|RANGERS|PADRES|GIANTS|CARDINALS|NATIONALS|ORIOLES|GUARDIANS|TWINS|RAYS|MARLINS|PIRATES|REDS|BREWERS|TIGERS|ROYALS|ATHLETICS|MARINERS|ANGELS|ROCKIES|DIAMONDBACKS|OUTFIELDER|INFIELDER|PITCHER|CATCHER|SHORTSTOP|BASEMAN|STARTING|CLOSER|RELIEVER/i.test(rawLines[i + 1]);
            
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
      potentialNames.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        // Tie-break: prefer 2-word names (firstName + lastName) over 3-word names.
        // 3-word names are more likely to be partial OCR artifacts (e.g. "Apps Aats Ew")
        const aWordCount = [a.firstName, ...a.lastName.split(/\s+/)].length;
        const bWordCount = [b.firstName, ...b.lastName.split(/\s+/)].length;
        return aWordCount - bWordCount;
      });
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
 * Position helper: build a map of token text → bounding-box Y positions and the
 * overall image height, so card-number candidates can be ranked by where they
 * physically appear on the card. Real card numbers live in the top portion of
 * the back; mid/bottom matches (e.g. graphic insert text like "CALL-UP") are
 * almost always false positives.
 */
type CardNumPosMap = {
  imageHeight: number;
  tokens: Array<{ text: string; minY: number; maxY: number }>;
};

function buildCardNumberPositionMap(textAnnotations?: TextAnnotation[]): CardNumPosMap | null {
  if (!textAnnotations || textAnnotations.length < 2) return null;
  const tokens: CardNumPosMap['tokens'] = [];
  let imageHeight = 0;
  // Annotation[0] is the full-page text block; per-token annotations follow.
  const a0 = textAnnotations[0];
  const v0 = a0?.boundingPoly?.vertices;
  if (v0 && v0.length > 0) {
    imageHeight = Math.max(imageHeight, ...v0.map(p => p.y || 0));
  }
  for (let i = 1; i < textAnnotations.length; i++) {
    const a = textAnnotations[i];
    const v = a.boundingPoly?.vertices;
    if (!v || v.length === 0) continue;
    const ys = v.map(p => p.y || 0);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    if (maxY > imageHeight) imageHeight = maxY;
    tokens.push({ text: (a.description || '').toUpperCase(), minY, maxY });
  }
  if (imageHeight === 0 || tokens.length === 0) return null;
  return { imageHeight, tokens };
}

/**
 * Look up the normalized Y position (0 = top, 1 = bottom) of a candidate
 * card-number string by anchoring it to a SPATIALLY CONTIGUOUS group of
 * source tokens. This avoids artificially top-biased Y when a hyphenated
 * candidate's parts each appear in unrelated places on the card (e.g. the
 * digits "119" appearing both at the top as the card number AND in a stats
 * row at the bottom — we don't want the bottom occurrence to "borrow" the
 * top occurrence's Y just because the parts share text).
 *
 * Strategy:
 *   1) If the entire candidate matches a single token verbatim, use that
 *      token's minY (multiple verbatim hits → return them all and pick
 *      the contiguous group by minY span).
 *   2) Otherwise split the candidate by [-\s#.]+ and find the combination
 *      of tokens (one per part) whose bounding boxes form the tightest
 *      cluster (min span across X+Y). Reject if no part can be matched
 *      or if the tightest cluster spans more than ~15% of the image
 *      height (i.e. parts aren't actually next to each other on the card).
 *   3) Fallback: any token whose text contains the full upper match.
 *
 * Returns the topmost (min) Y of the chosen contiguous group divided by
 * imageHeight, or null if no acceptable anchoring exists.
 */
function getCardNumNormalizedY(matched: string, posMap: CardNumPosMap): number | null {
  const upper = matched.toUpperCase();

  // 1) Full-string verbatim match — use topmost occurrence
  const fullHits = posMap.tokens.filter(t => t.text === upper);
  if (fullHits.length > 0) {
    return Math.min(...fullHits.map(t => t.minY)) / posMap.imageHeight;
  }

  // 2) Multi-part contiguous anchoring
  const parts = upper.split(/[-\s#.]+/).filter(p => p.length > 0);
  if (parts.length === 0) return null;

  const partHits = parts.map(p => posMap.tokens.filter(t => t.text === p));
  if (parts.length > 1 && partHits.every(arr => arr.length > 0)) {
    // Find the (one-per-part) combination with the smallest total Y span.
    // For 2-part candidates this is exhaustive; for 3+ we use a greedy
    // anchor-on-first-part approach to keep cost bounded.
    const MAX_CLUSTER_SPAN_FRACTION = 0.15; // 15% of image height
    const heightThreshold = posMap.imageHeight * MAX_CLUSTER_SPAN_FRACTION;
    let bestSpan = Infinity;
    let bestMinY: number | null = null;
    for (const anchor of partHits[0]) {
      // Greedy: for each remaining part, pick the token closest in Y to anchor
      let groupMinY = anchor.minY;
      let groupMaxY = anchor.maxY;
      let usable = true;
      for (let p = 1; p < partHits.length; p++) {
        let nearest: { minY: number; maxY: number } | null = null;
        let nearestDist = Infinity;
        for (const cand of partHits[p]) {
          const dist = Math.abs(cand.minY - anchor.minY);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearest = cand;
          }
        }
        if (!nearest) { usable = false; break; }
        groupMinY = Math.min(groupMinY, nearest.minY);
        groupMaxY = Math.max(groupMaxY, nearest.maxY);
      }
      if (!usable) continue;
      const span = groupMaxY - groupMinY;
      if (span <= heightThreshold && span < bestSpan) {
        bestSpan = span;
        bestMinY = groupMinY;
      }
    }
    if (bestMinY !== null) {
      return bestMinY / posMap.imageHeight;
    }
    // No contiguous combination found → don't trust isolated part matches
    return null;
  }

  // Single-part fallback (e.g. "#119" → ["119"])
  if (parts.length === 1 && partHits[0].length > 0) {
    return Math.min(...partHits[0].map(t => t.minY)) / posMap.imageHeight;
  }

  // 3) Last-resort substring match
  const containsHits = posMap.tokens.filter(t => t.text.includes(upper));
  if (containsHits.length > 0) {
    return Math.min(...containsHits.map(t => t.minY)) / posMap.imageHeight;
  }

  return null;
}

/**
 * Extract card number using regex patterns for common formats.
 *
 * Position-aware behavior: when textAnnotations are available, the detector
 * runs a STRICT pass that only accepts candidates whose source token sits in
 * the top 40% of the image (where real card numbers are physically printed).
 * If no top-region candidate is found, it falls back to a RELAXED pass that
 * matches the original text-only behavior so callers without positional data
 * (or images where no top match exists) keep working.
 */
function extractCardNumber(
  text: string,
  cardDetails: Partial<CardFormValues>,
  originalText?: string,
  textAnnotations?: TextAnnotation[],
  side: 'front' | 'back' | 'unknown' = 'unknown'
): void {
  const posMap = buildCardNumberPositionMap(textAnnotations);
  const sideTag = `side=${side}`;

  const runPass = (strictMode: boolean) => {
    const acceptCandidate = (matched: string, source: string): boolean => {
      if (!posMap) {
        console.log(`[CardNum] Accepting "${matched}" via ${source} (${sideTag}, no positional data)`);
        return true;
      }
      const ny = getCardNumNormalizedY(matched, posMap);
      const region = ny == null ? 'UNKNOWN' : ny < 0.40 ? 'TOP' : ny < 0.65 ? 'MIDDLE' : 'BOTTOM';
      const nyStr = ny == null ? 'n/a' : ny.toFixed(2);
      if (!strictMode) {
        console.log(`[CardNum] Accepting "${matched}" via ${source} (${sideTag}, relaxed pass, normY=${nyStr}, ${region})`);
        return true;
      }
      if (ny == null) {
        console.log(`[CardNum-pos] Skipping "${matched}" via ${source} (${sideTag}) — no contiguous token position (strict pass)`);
        return false;
      }
      if (ny < 0.40) {
        console.log(`[CardNum-pos] Accepting "${matched}" via ${source} (${sideTag}) at normY=${nyStr} (${region})`);
        return true;
      }
      console.log(`[CardNum-pos] Rejecting "${matched}" via ${source} (${sideTag}) at normY=${nyStr} (${region}) — not in top 40%`);
      return false;
    };

    extractCardNumberPass(text, cardDetails, originalText, acceptCandidate);
  };

  if (posMap) {
    console.log(`[CardNum-pos] Position-aware strict pass (${sideTag}): imageHeight=${posMap.imageHeight}, tokens=${posMap.tokens.length}`);
    runPass(true);
    if (cardDetails.cardNumber) return;
    console.log(`[CardNum-pos] No top-region card number found (${sideTag}) — falling back to text-only relaxed pass`);
  }
  runPass(false);
}

/**
 * Inner pass that runs the existing pattern chain. Each accept site is gated
 * by the supplied acceptCandidate(matchedText, source) callback so the strict
 * top-region filter can be applied uniformly across all patterns.
 */
function extractCardNumberPass(
  text: string,
  cardDetails: Partial<CardFormValues>,
  originalText: string | undefined,
  acceptCandidate: (matched: string, source: string) => boolean
): void {
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
      const candidate = allStarMatch[0].toUpperCase();
      if (acceptCandidate(candidate, 'all-star')) {
        cardDetails.cardNumber = candidate;
        cardDetails.collection = "1989 All-Star";
        console.log(`Detected All-Star card number: ${cardDetails.cardNumber}`);
        return;
      }
    }
    
    // Format: 89B2-32, 89B-2 (year-digit prefix then letters then dash then digits)
    // These are year-prefixed inserts like "2024 Topps 89B2-32" style card numbers.
    // Must run BEFORE dashNumberPatternGlobal since that only matches letter-leading prefixes.
    const yearPrefixedCardPattern = /\b(\d{2}[A-Z][A-Z0-9]*)-(\d{1,4})\b/g;
    let yearPrefixedMatch;
    while ((yearPrefixedMatch = yearPrefixedCardPattern.exec(text)) !== null) {
      const fullMatch = yearPrefixedMatch[0];
      const lineWithMatch = lines.find(line => line.toLowerCase().includes(fullMatch.toLowerCase()));
      if (lineWithMatch && isDOBFormat(lineWithMatch)) continue;
      if (lineWithMatch && /\b(DRAFTED|DRAFT|BORN|SIGNED|OVERALL|ROUND|PICK|AGENT|FREE)\b/i.test(lineWithMatch)) continue;
      if (!acceptCandidate(fullMatch, 'year-prefixed')) continue;
      cardDetails.cardNumber = fullMatch;
      console.log(`Detected year-prefixed card number: ${cardDetails.cardNumber}`);
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
      if (!acceptCandidate(matchedText, 'dash-number')) continue;
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
      } else if (acceptCandidate(matchedText, 'number-letter')) {
        cardDetails.cardNumber = matchedText;
        console.log(`Detected number-letter card number: ${cardDetails.cardNumber}`);
        return;
      }
    }
    
    // Autograph card numbers: letters-dash-letters (e.g. CPA-LRE, HA-RJ, BA-XX, RC-JD)
    // These appear on Bowman Prospect Autographs, Heritage Autographs, etc.
    // Must run BEFORE the plainNumberPattern so CODE#065939 doesn't win over CPA-LRE.
    const nonCardLetterPrefixes = new Set([
      // Legal / boilerplate
      'CMP', 'CODE', 'WWW', 'COM', 'INC', 'MLB', 'NFL', 'NBA', 'NHL', 'MLS', 'USA', 'URL',
      'AKA', 'DBA', 'LLC', 'LTD', 'REG', 'TM',
      // Stat abbreviations
      'WALK', 'OFF', 'RBI', 'ERA', 'AVG', 'OBP', 'OPS', 'WAR', 'SLG', 'WHIP',
      'PPG', 'RPG', 'APG', 'FGP', 'FTP', 'TD', 'YDS', 'ATT', 'QBR', 'INT',
      'SOG', 'PIM', 'SHG', 'GWG', 'GP', 'PKS', 'GA', 'CS', 'YC', 'RC',
      'ALL', 'STAR', 'PRO', 'MVP', 'HOF', 'NL', 'AL',
      // Common English bio-text words that get hyphenated on card backs
      // (e.g. "TWO-GAME SPAN", "FIVE-TOOL", "BIG-LEAGUE", "ALL-STAR", "PRO-DEBUT",
      // "STAT-LINE", "GAME-DAY", "CALL-UP", "WALK-OFF", "FREE-AGENT", "RIGHT-HAND").
      'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
      'GAME', 'GAMES', 'TIME', 'TIMES', 'YEAR', 'YEARS', 'DAY', 'DAYS',
      'TEAM', 'HIT', 'HITS', 'RUN', 'RUNS', 'WIN', 'WINS', 'LOSS', 'PLAY',
      'CALL', 'TOOL', 'TOOLS', 'SPAN', 'LEAGUE', 'DEBUT', 'LINE', 'BACK', 'FRONT',
      'RIGHT', 'LEFT', 'FAST', 'SLOW', 'NEW', 'OLD', 'BIG', 'TOP', 'END', 'OUT',
      'WAY', 'NIGHT', 'AGENT', 'HAND', 'HEAD', 'NAME', 'HOME', 'AWAY', 'BASE',
      'FIRST', 'LAST', 'BEST', 'NEXT', 'EVEN', 'ALSO', 'BORN', 'JUNE', 'JULY',
    ]);
    const autographCardPattern = /\b([A-Z]{1,4})-([A-Z]{2,5})\b/g;
    let autographMatch;
    while ((autographMatch = autographCardPattern.exec(text)) !== null) {
      const prefix = autographMatch[1];
      const suffix = autographMatch[2];
      const fullMatch = autographMatch[0];
      const matchStart = autographMatch.index;
      if (nonCardLetterPrefixes.has(prefix)) {
        console.log(`Skipping autograph candidate "${fullMatch}" — prefix "${prefix}" is a known non-card word`);
        continue;
      }
      if (nonCardLetterPrefixes.has(suffix)) {
        console.log(`Skipping autograph candidate "${fullMatch}" — suffix "${suffix}" is a known non-card word`);
        continue;
      }

      // Body-text guard: real autograph card numbers stand alone or sit
      // next to player info ("RYAN RITTER  CPA-RR"). They are NOT embedded
      // inside sentences ("HOMERED FIVE TIMES IN ONE TWO-GAME SPAN"). If
      // the immediate textual neighbourhood looks like a sentence — many
      // uppercase word tokens on either side — reject the match. We use
      // 60-char windows on each side and consider 4+ word tokens per
      // window to be sentence-like.
      const before = text.slice(Math.max(0, matchStart - 60), matchStart);
      const after = text.slice(matchStart + fullMatch.length, matchStart + fullMatch.length + 60);
      // Strong positive signal: an immediate "NO.", "No.", "No", or "#" prefix
      // is the canonical card-number marker. When present we trust the match
      // and bypass body-text / long-line heuristics that exist to filter out
      // accidental hits inside bio paragraphs.
      const hasCardNumberMarker = /(?:^|[\s(])(?:NO\.?|#)\s*$/i.test(before);
      const wordTokenCount = (s: string) => (s.match(/\b[A-Z]{2,}\b/g) || []).length;
      const beforeWords = wordTokenCount(before);
      const afterWords = wordTokenCount(after);
      if (!hasCardNumberMarker && (beforeWords >= 4 || afterWords >= 4)) {
        console.log(`Skipping autograph candidate "${fullMatch}" — embedded in body text (before=${beforeWords} words, after=${afterWords} words)`);
        continue;
      }

      const lineWithMatch = lines.find(line => line.toLowerCase().includes(fullMatch.toLowerCase()));
      if (!lineWithMatch) continue;
      // Skip if this appears in a biographical/legal line
      if (!hasCardNumberMarker && /\b(DRAFTED|DRAFT|BORN|SIGNED|OVERALL|ROUND|PICK|AGENT|FREE|RIGHTS|RESERVED|LICENSED|TRADEMARK|COMPANY|VISIT|HOMERED|SLUGGED|PROMOTED|MONSTER|PITCHED|BATTED|FIELDED|SCORED)\b/i.test(lineWithMatch)) continue;
      if (/CODE#/i.test(lineWithMatch)) continue;
      // Require the line to be short (autograph card # lines are typically standalone or near player info)
      // or appear on a line that isn't a long bio paragraph — unless we have a
      // hard NO./# marker right before the match.
      if (!hasCardNumberMarker && lineWithMatch.length > 120) continue;
      if (!acceptCandidate(fullMatch, 'autograph-letter-letter')) continue;
      cardDetails.cardNumber = fullMatch;
      console.log(`Detected autograph-format card number (letter-letter): ${fullMatch}`);
      return;
    }

    // Plain number format: #123 or No. 123
    // Guard: must NOT be a CODE# token from the legal text (e.g. CODE#065939 → skip).
    // Use global iteration so a CODE# hit doesn't block a later valid #123 match.
    const plainNumberPatternGlobal = /(?:#|No\.?\s*)(\d+)/g;
    let plainNumberMatch;
    while ((plainNumberMatch = plainNumberPatternGlobal.exec(text)) !== null) {
      const candidate = plainNumberMatch[1];
      const matchedToken = plainNumberMatch[0];
      const lineWithMatch = lines.find(line => line.includes(matchedToken));

      if (lineWithMatch && isDOBFormat(lineWithMatch)) {
        console.log(`Skipping plain number "${candidate}" that appears in a date/stat line`);
        continue;
      }
      if (lineWithMatch && /CODE#/i.test(lineWithMatch)) {
        console.log(`Skipping plain number "${candidate}" — matched # is part of a CODE# legal token`);
        continue;
      }
      if (!acceptCandidate(candidate, 'plain-number')) continue;
      if (candidate.length === 1) {
        cardDetails.cardNumber = candidate;
        break;
      } else {
        cardDetails.cardNumber = candidate;
        return;
      }
    }
    
    // HIGHEST PRIORITY (before brand search): If the very first line is a standalone number
    // or alphanumeric card number (e.g. US56, RC12, BDP5), that is the card number.
    // Topps/Bowman cards often put the card number as the topmost line on the back.
    // This must run before brand-near-number detection so it isn't overridden by a false match.
    const firstLineEarly = lines[0]?.trim() ?? '';
    const earlyCodePrefixSkip = new Set(['CMP', 'CODE', 'WWW', 'INC', 'MLB', 'NFL', 'NBA', 'NHL']);
    if (/^\d+$/.test(firstLineEarly) && parseInt(firstLineEarly) > 0 && parseInt(firstLineEarly) < 10000) {
      if (acceptCandidate(firstLineEarly, 'first-line-digit')) {
        cardDetails.cardNumber = firstLineEarly;
        console.log(`Detected standalone card number at very top of text (highest priority): ${firstLineEarly}`);
        return;
      }
    }
    // Alphanumeric first-line check: e.g. "US56", "RC12", "BDP42", "B24-YC"
    // The optional (-[A-Z]{1,4}) suffix captures formats like "B24-YC" (Bowman prospect cards).
    const alphaNumFirstLine = firstLineEarly.match(/^([A-Z]{1,4})(\d{1,4})(-[A-Z]{1,4})?$/);
    if (alphaNumFirstLine && !earlyCodePrefixSkip.has(alphaNumFirstLine[1]) && parseInt(alphaNumFirstLine[2]) > 0 && parseInt(alphaNumFirstLine[2]) < 10000) {
      if (acceptCandidate(firstLineEarly, 'first-line-alphanum')) {
        cardDetails.cardNumber = firstLineEarly;
        console.log(`Detected alphanumeric card number at very top of text (highest priority): ${firstLineEarly}`);
        return;
      }
    }

    // HIGH PRIORITY: Look for a number near the brand name - most card numbers are physically near the brand
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
            if (acceptCandidate(number, 'brand+number')) {
              cardDetails.cardNumber = number;
              console.log(`Detected card number ${number} immediately after brand "${brandWithNumberMatch[1]}" - highest confidence`);
              return;
            }
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
              if (acceptCandidate(number, 'brand-line-number')) {
                cardDetails.cardNumber = number;
                console.log(`Detected card number ${number} in same line as brand - high confidence`);
                return;
              }
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
          // Skip lines that are clearly biographical/acquisition context — not card numbers
          if (/\b(SIGNED|DRAFTED|DRAFT|BORN|FREE AGENT|ACQ|ACQUIRED|TRADED|AGENT)\b/i.test(nearbyLine)) {
            console.log(`Skipping nearby line with biography/acquisition context: "${nearbyLine.substring(0, 60)}"`);
            continue;
          }
          // Check for alphanumeric+letter card numbers first (B24-YC, BDP24-AB)
          // These have an alphanumeric prefix ending in digit + hyphen + letter suffix
          const nearbyAlphaDigitLetter = nearbyLine.match(/^([A-Z][A-Z0-9]*\d)-([A-Z]{1,4})$/);
          if (nearbyAlphaDigitLetter) {
            if (acceptCandidate(nearbyAlphaDigitLetter[0], 'nearby-alpha-digit-letter')) {
              cardDetails.cardNumber = nearbyAlphaDigitLetter[0];
              console.log(`Detected alphanumeric+letter card number near brand: ${nearbyAlphaDigitLetter[0]}`);
              return;
            }
          }
          // Check for hyphenated alphanumeric card numbers (BD-7, HRC-42)
          const nearbyHyphenMatch = nearbyLine.match(/\b([A-Z]{1,4})-(\d{1,4})\b/);
          if (nearbyHyphenMatch && nearbyHyphenMatch[0]) {
            const nearbyHyphenDigits = parseInt(nearbyHyphenMatch[2]);
            // Skip if the numeric part looks like a year (> 999) rather than a card number
            if (nearbyHyphenDigits > 999) {
              console.log(`Skipping hyphenated match "${nearbyHyphenMatch[0]}" near brand — digit value ${nearbyHyphenDigits} looks like a year`);
              continue;
            }
            if (acceptCandidate(nearbyHyphenMatch[0], 'nearby-hyphen')) {
              cardDetails.cardNumber = nearbyHyphenMatch[0];
              console.log(`Detected hyphenated card number ${nearbyHyphenMatch[0]} near brand line - high confidence`);
              return;
            }
          }
          // Check for non-hyphenated alphanumeric card numbers (T119, TC12, BDP5)
          const nearbyAlphaNumMatch = nearbyLine.match(/^([A-Z]{1,3})(\d{1,4})$/);
          if (nearbyAlphaNumMatch) {
            const prefix = nearbyAlphaNumMatch[1];
            const digits = nearbyAlphaNumMatch[2];
            if (parseInt(digits) <= 999 && !/^(OF|IN|AT|TO|BY|OR|ON|IS|IT|AS|IF|UP|NO|SO|DO|AN|AM|BE|HE|WE|MY|US|THE|AND|FOR|ARE|BUT|NOT|YOU|ALL|HAS|HIS|HOW|ITS|MAY|OUR|OUT|WAY|WHO|DID|GET|HIM|LET|SAY|SHE|TOO|USE|MLB|NFL|NBA|NHL|MLS|USA|NL|AL|FT|LB|HR|AB|BB|SO|IP|ER|GS|SV|WL|GP|GF|RS|BA|HT|WT|ACQ|PPG|RPG|APG|FGP|FTP|TD|YDS|ATT|QBR|INT|SOG|PIM|SHG|GWG|PKS)$/i.test(prefix)) {
              if (acceptCandidate(nearbyAlphaNumMatch[0], 'nearby-alphanum')) {
                cardDetails.cardNumber = nearbyAlphaNumMatch[0];
                console.log(`Detected alphanumeric card number ${nearbyAlphaNumMatch[0]} near brand line - high confidence`);
                return;
              }
            }
          }
          const nearbyNumberMatch = nearbyLine.match(/\b(\d{1,3})\b/);
          if (nearbyNumberMatch && nearbyNumberMatch[1]) {
            const number = nearbyNumberMatch[1];
            if (parseInt(number) > 0 && parseInt(number) < 1000 && !isDOBFormat(nearbyLine)) {
              if (acceptCandidate(number, 'nearby-number')) {
                cardDetails.cardNumber = number;
                console.log(`Detected card number ${number} near brand line - high confidence`);
                return;
              }
            }
          }
        }
      }
    }
    
    // Alphanumeric-prefix + letter-suffix card numbers: B24-YC, BDP24-AB, etc.
    // Format: letter(s)+digit(s) prefix (ending in digit), hyphen, letter(s) suffix (1-4 letters).
    // Must run BEFORE alphaNumPatternEarly which would truncate "B24-YC" → "B24".
    const alphaDigitLetterPattern = /\b([A-Z][A-Z0-9]*\d)-([A-Z]{1,4})\b/g;
    let alphaDigitLetterMatch;
    while ((alphaDigitLetterMatch = alphaDigitLetterPattern.exec(text)) !== null) {
      const fullMatch = alphaDigitLetterMatch[0];
      const lineWithMatch = lines.find(line => line.toLowerCase().includes(fullMatch.toLowerCase()));
      if (!lineWithMatch) continue;
      if (/\b(DRAFTED|DRAFT|BORN|SIGNED|OVERALL|ROUND|PICK|AGENT|FREE|RIGHTS|RESERVED|LICENSED|TRADEMARK|COMPANY|VISIT)\b/i.test(lineWithMatch)) continue;
      if (/CODE#/i.test(lineWithMatch)) continue;
      if (lineWithMatch.length > 120) continue;
      if (!acceptCandidate(fullMatch, 'alpha-digit-letter')) continue;
      cardDetails.cardNumber = fullMatch;
      console.log(`Detected alphanumeric+letter card number (e.g. B24-YC): ${fullMatch}`);
      return;
    }

    // Check for hyphenated alphanumeric card numbers (BD-7, BDC-15, HRC-42, etc.)
    // These are high-confidence and should be checked before standalone numbers
    const nonCardCodePrefixes = new Set(['CMP', 'CODE', 'WWW', 'COM', 'INC', 'MLB', 'NFL', 'NBA', 'NHL', 'MLS', 'OBP', 'ERA', 'AVG', 'WAR', 'SLG', 'RBI', 'HT', 'WT', 'ACQ', 'RD', 'RND', 'PK', 'OVR', 'PPG', 'RPG', 'APG', 'FGP', 'FTP', 'TD', 'YDS', 'ATT', 'QBR', 'INT', 'SOG', 'PIM', 'SHG', 'GWG', 'GP', 'PKS', 'GA', 'CS', 'YC', 'RC']);
    const hyphenAlphaNumPatternEarly = /\b([A-Z]{1,4})-(\d{1,4})\b/g;
    let hyphenMatchEarly;
    while ((hyphenMatchEarly = hyphenAlphaNumPatternEarly.exec(text)) !== null) {
      const prefix = hyphenMatchEarly[1];
      const digits = hyphenMatchEarly[2];
      const fullMatch = hyphenMatchEarly[0];
      if (nonCardCodePrefixes.has(prefix)) continue;
      if (text.includes('CODE ' + fullMatch)) continue;
      if (parseInt(digits) > 999) continue;
      if (!acceptCandidate(fullMatch, 'hyphen-alphanum-early')) continue;
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
      if (/^(OF|IN|AT|TO|BY|OR|ON|IS|IT|AS|IF|UP|NO|SO|DO|AN|AM|BE|HE|WE|MY|US|THE|AND|FOR|ARE|BUT|NOT|YOU|ALL|HAS|HIS|HOW|ITS|MAY|OUR|OUT|WAY|WHO|DID|GET|HIM|LET|SAY|SHE|TOO|USE|MLB|NFL|NBA|NHL|MLS|USA|NL|AL|FT|LB|LBS|HR|AB|BB|SO|IP|ER|GS|SV|WL|GP|GF|RS|BA|RD|RND|PK|OVR|PPG|RPG|APG|FGP|FTP|TD|YDS|ATT|QBR|INT|SOG|PIM|SHG|GWG|PKS)$/i.test(prefix)) continue;
      // Skip if the match appears in a bio/stat line (case-insensitive search for the line)
      const lineWithAlphaNum = lines.find(line => line.toLowerCase().includes(fullMatch.toLowerCase()));
      if (lineWithAlphaNum && isDOBFormat(lineWithAlphaNum)) continue;
      if (lineWithAlphaNum && isPlayerBioNumber(digits, lineWithAlphaNum)) continue;
      // Skip if match appears in a DRAFTED/DRAFT/BORN/SIGNED biographical line
      if (lineWithAlphaNum && /\b(DRAFTED|DRAFT|BORN|SIGNED|OVERALL|ROUND|PICK|AGENT|FREE)\b/i.test(lineWithAlphaNum)) continue;
      
      if (!acceptCandidate(fullMatch, 'alphanum-early')) continue;
      cardDetails.cardNumber = fullMatch;
      console.log(`Detected Alphanumeric card number (early check): ${cardDetails.cardNumber}`);
      return;
    }
    
    // Second priority: Check if the very first line is ONLY a number
    // This is also a reliable way to detect card numbers at the top of a card
    const firstLine = lines[0].trim();
    if (/^\d+$/.test(firstLine) && parseInt(firstLine) > 0 && parseInt(firstLine) < 10000) {
      if (acceptCandidate(firstLine, 'first-line-number')) {
        cardDetails.cardNumber = firstLine;
        console.log(`Detected standalone card number at top of card: ${cardDetails.cardNumber}`);
        return;
      }
    }
    
    // Second attempt: Try to extract a number from the beginning of the first line
    const firstLineMatch = firstLine.match(/^(\d{1,4})\s/);
    if (firstLineMatch && firstLineMatch[1]) {
      const number = firstLineMatch[1];
      // Make sure it's a reasonable card number (1-9999)
      if (parseInt(number) > 0 && parseInt(number) < 10000) {
        if (acceptCandidate(number, 'first-line-leading-digit')) {
          cardDetails.cardNumber = number;
          console.log(`Detected card number at very beginning of OCR text: ${cardDetails.cardNumber}`);
          return;
        }
      }
    }
    
    // Check the first 3 lines for a standalone number as fallback
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      const trimmedLine = lines[i].trim();
      // If the line is just a number and it's a reasonable card number (1-999)
      if (/^\d{1,3}$/.test(trimmedLine) && parseInt(trimmedLine) > 0 && parseInt(trimmedLine) < 1000) {
        if (acceptCandidate(trimmedLine, 'top-3-lines')) {
          cardDetails.cardNumber = trimmedLine;
          console.log(`Detected top card number: ${cardDetails.cardNumber}`);
          return;
        }
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
        if (acceptCandidate(number, 'standalone-line-number')) {
          cardDetails.cardNumber = number;
          console.log(`Detected standalone card number: ${cardDetails.cardNumber}`);
          return;
        }
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
    //
    // IMPORTANT: multi-word / compound brand names (e.g. "TOPPS CHROME",
    // "BOWMAN CHROME") MUST appear before their single-word parents
    // ("TOPPS", "BOWMAN"). The detector picks the first brand found in
    // non-legal text and stops, so if "TOPPS" is listed first it would
    // claim the match before "TOPPS CHROME" ever gets a chance. Ordering
    // by specificity (most specific first) lets the compound brand win
    // on Chrome cards while still falling through to plain "Topps" on
    // flagship cards that never print "CHROME" anywhere.
    // `fuzzy` is an optional secondary regex matched only after the strict
    // exact-word pass fails to find a brand. It covers common Vision OCR
    // misreads of stylized front-of-card wordmarks (e.g. the "D" in
    // "DONRUSS" being read as "J"/"O"/"Q"/"U" because of the 'D' glyph's
    // open shape on a busy background; the double-S being collapsed to
    // single-S; "FLEER" reading "ELEER"; etc.). The fuzzy pass is still
    // gated on the same legal-line / blocklist logic, so it can't be
    // hijacked by publisher-imprint text.
    const brands: Array<{ search: string; display: string; fuzzy?: RegExp }> = [
      { search: 'TOPPS CHROME', display: 'Topps Chrome' },
      { search: 'BOWMAN CHROME', display: 'Bowman Chrome' },
      { search: 'BOWMAN',       display: 'Bowman',       fuzzy: /\bB[O0Q]WM[A4]N\b/i },
      { search: 'TOPPS',        display: 'Topps',        fuzzy: /\b[T7][O0Q]PP[S5]?\b/i },
      { search: 'UPPER DECK',   display: 'Upper Deck' },
      { search: 'PANINI',       display: 'Panini',       fuzzy: /\bP[A4]N[1I]N[1I]\b/i },
      // DONRUSS: D often misreads as J/O/Q/U on stylized wordmarks (closed-loop
      // glyph). N→W is also common. Allow optional trailing S (DONRUS).
      { search: 'DONRUSS',      display: 'Donruss',      fuzzy: /\b[DJOQU0][O0Q][NW]RU[S5]{1,2}\b/i },
      { search: 'FLEER',        display: 'Fleer',        fuzzy: /\b[FE]LEER\b/i },
      { search: 'SCORE',        display: 'Score',        fuzzy: /\b[S5]C[O0Q]RE\b/i },
      { search: 'PLAYOFF',      display: 'Playoff' },
      { search: 'LEAF',         display: 'Leaf',         fuzzy: /\bLE[A4]F\b/i },
      { search: 'PACIFIC',      display: 'Pacific' },
      { search: 'SKYBOX',       display: 'Skybox' },
      { search: 'SAGE',         display: 'Sage' },
      { search: 'PRESS PASS',   display: 'Press Pass' },
      { search: 'CLASSIC',      display: 'Classic' },
      { search: 'PINNACLE',     display: 'Pinnacle' },
      { search: 'ULTRA',        display: 'Ultra' }
    ];
    
    // Use original text with newlines for brand detection to distinguish
    // contextual brand mentions from legal/trademark text
    const brandDetectionText = originalText || text;
    const brandLines = brandDetectionText.toUpperCase().split(/\r?\n/);
    const legalLinePattern = /(?:REGISTERED\s+)?TRADEMARK|ALL\s+RIGHTS\s+RESERVED|©|\(C\)|OFFICIALLY\s+LICENSED|THE\s+TOPPS\s+COMPANY|WWW\.\w+\.COM|CODE#|\b(?:TOPPS|BOWMAN|FLEER|DONRUSS|SCORE|LEAF|UPPER DECK|PANINI|PLAYOFF|PACIFIC|SKYBOX|PINNACLE)\b.*?\b(?:INC|LTD|CORP|LLC)\b|\b\d{4}\s+\w+.*?\b(?:INC|LTD|CORP|LLC)\b/i;
    
    // Brands whose name appears in the legal/copyright line of OTHER brands' cards
    // and therefore can't be trusted as a legal-text fallback. The classic case is
    // "LEAF": Leaf, Inc. produced every Donruss baseball card from 1981–1993, so
    // the back of every Donruss card from that era reads "© [year] LEAF, INC." —
    // not Donruss. Without this exclusion, a Donruss card whose front-side OCR
    // fails to read the "DONRUSS" wordmark would be incorrectly classified as a
    // Leaf card based on the publisher imprint alone (and then matched to a
    // totally different player at the same #/year in the Leaf set). Real Leaf
    // cards still resolve fine because their fronts (and usually their non-legal
    // back text) say "LEAF" outside the copyright line.
    const legalFallbackBlocklist = new Set(['Leaf']);
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
      if (foundInLegal && !brandFromLegal && !legalFallbackBlocklist.has(brand.display)) {
        brandFromLegal = brand.display;
      } else if (foundInLegal && legalFallbackBlocklist.has(brand.display)) {
        console.log(`Skipping legal-text brand fallback for "${brand.display}" — appears in publisher imprint of other brands' cards (e.g. Leaf, Inc. printed all Donruss 1981–1993).`);
      }
    }
    
    // Fuzzy pass — only runs if strict matching found nothing in non-legal text.
    // This catches OCR-mangled stylized wordmarks (e.g. "JONRUSS" on a Donruss
    // front, "ELEER" on a Fleer front) WITHOUT changing behavior on cards whose
    // wordmark OCR'd cleanly. Same legal-line filtering applies — we only
    // accept fuzzy hits in non-legal text, so the publisher imprint can never
    // win via fuzzy match either.
    if (!cardDetails.brand) {
      for (const brand of brands) {
        if (!brand.fuzzy) continue;
        for (const line of brandLines) {
          if (legalLinePattern.test(line)) continue;
          if (brand.fuzzy.test(line)) {
            cardDetails.brand = brand.display;
            console.log(`Detected brand: ${cardDetails.brand} (fuzzy non-legal match against "${line.trim()}")`);
            break;
          }
        }
        if (cardDetails.brand) break;
      }
    }

    // Fallback: use brand found only in legal text if no non-legal brand found
    if (!cardDetails.brand && brandFromLegal) {
      cardDetails.brand = brandFromLegal;
      console.log(`Detected brand: ${cardDetails.brand} (from legal text fallback)`);
    }
    
    // COLLECTION DETECTION - Look for common collections/sets
    // Prefer to use regex for collections to avoid false positives
    
    const collectionPatterns: Array<{
      pattern: RegExp;
      name: string;
      variant?: string;
      brandOverride?: string;
      /**
       * When true, this pattern will NOT be matched against the legal/full-text
       * fallback. Use for brand/product names that appear verbatim in the
       * copyright line of EVERY card from that brand (base or Chrome), e.g.
       * "BOWMAN AND BOWMAN CHROME ARE REGISTERED TRADEMARKS...". Without this
       * guard, a base Bowman card would be misclassified as "Bowman Chrome"
       * solely because the trademark line mentions both product names.
       */
      skipLegalFallback?: boolean;
    }> = [
      { pattern: /RIFLEMAN/i, name: "Rifleman" },
      { pattern: /HERITAGE/i, name: "Heritage" },
      { pattern: /ALLEN & GINTER|ALLEN AND GINTER/i, name: "Allen & Ginter" },
      { pattern: /BOWMAN CHROME/i, name: "Bowman Chrome", skipLegalFallback: true },
      { pattern: /PRIZM/i, name: "Prizm" },
      { pattern: /OPTIC/i, name: "Optic" },
      { pattern: /\bOPENING DAY\b(?!\s+(?:of|for|the|in|an|at|to|period|roster|ceremony|signing)\b)/i, name: "Opening Day" },
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
        // Skip patterns flagged as unsafe for legal-text matching (brand/product
        // names that appear in the copyright line of every card in that family).
        if (collectionData.skipLegalFallback) continue;
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
    // Handles: "2024 THE TOPPS COMPANY", "2025 TOPPS, INC", "1991 SCORE INC",
    //          "1979, TOPPS CHEWING GUM" (vintage comma-separator), "1979 TOPPS"
    // Also handles reverse order: "TOPPS 1979", "TOPPS, INC 1979", "CHEWING GUM, INC. 1979"
    //
    // `[\s,.;:]+` matches any combination of whitespace/punctuation between the
    // year and brand — vintage Topps cards print "© 1979, TOPPS" with a comma
    // that broke the stricter `\s+` version.
    const brandYearPattern = /(\d{4})[\s,.;:]+(?:THE\s+)?(TOPPS|LEAF|BOWMAN|FLEER|DONRUSS|SCORE|UPPER\s+DECK|PANINI)(?:[\s,.]+(?:CHEWING\s+GUM|COMPANY|INC\.?|LTD|CORP|LLC))?/i;
    const brandYearMatch = text.match(brandYearPattern);

    // Brands whose printed copyright year is unreliable as the card's release year.
    // The Leaf, Inc. publisher imprint on every Donruss card 1981–1993 commonly
    // pre-dates the actual card year by one (1991 Donruss prints "© 1990 LEAF,
    // INC." because production began in late 1990). DONRUSS is included for the
    // same publisher relationship — the copyright line on these eras can be off
    // by a year in either direction. We still record the year as a tentative
    // value (it's usually correct), but mark it as low-confidence so the
    // dual-side combine step can prefer a year detected from the front.
    const unreliableCopyrightBrands = /^(LEAF|DONRUSS)$/i;
    const isUnreliableBrandYear = (matchedBrand: string | undefined): boolean =>
      !!matchedBrand && unreliableCopyrightBrands.test(matchedBrand.replace(/\s+/g, ' ').trim());

    if (brandYearMatch && brandYearMatch[1]) {
      const year = parseInt(brandYearMatch[1], 10);
      if (year >= 1900 && year <= new Date().getFullYear()) {
        cardDetails.year = year;
        if (isUnreliableBrandYear(brandYearMatch[2])) {
          (cardDetails as any)._yearFromCopyright = true;
          console.log(`Using brand year as card date: ${cardDetails.year} (from "${brandYearMatch[0]}") — flagged low-confidence (Leaf/Donruss publisher imprint can be off by 1 year).`);
        } else {
          console.log(`Using brand year as card date: ${cardDetails.year} (from "${brandYearMatch[0]}")`);
          return;
        }
      }
    }
    
    // Reverse order: brand name followed by year, e.g. "TOPPS CHEWING GUM, INC. 1979",
    // "TOPPS COMPANY 2024", or generally "<BRAND> ... <4-digit year>" within a short window.
    const brandThenYearPattern = /(TOPPS|LEAF|BOWMAN|FLEER|DONRUSS|SCORE|UPPER\s+DECK|PANINI)(?:[\s,.]+(?:CHEWING\s+GUM|COMPANY|INC\.?|LTD|CORP|LLC))?[\s,.;:]+(\d{4})/i;
    const brandThenYearMatch = text.match(brandThenYearPattern);
    if (brandThenYearMatch && brandThenYearMatch[2]) {
      const year = parseInt(brandThenYearMatch[2], 10);
      if (year >= 1900 && year <= new Date().getFullYear()) {
        cardDetails.year = year;
        if (isUnreliableBrandYear(brandThenYearMatch[1])) {
          (cardDetails as any)._yearFromCopyright = true;
          console.log(`Using brand-then-year pattern as card date: ${cardDetails.year} (from "${brandThenYearMatch[0]}") — flagged low-confidence (Leaf/Donruss publisher imprint can be off by 1 year).`);
        } else {
          console.log(`Using brand-then-year pattern as card date: ${cardDetails.year} (from "${brandThenYearMatch[0]}")`);
          return;
        }
      }
    }
    
    // Handle OCR-garbled copyright+brand: "©2021" often reads as "02021", "02121", "&02021", etc.
    // Try stripping a leading non-year digit/char to recover the real 4-digit year.
    const garbledBrandYear = /[&0O](\d{4})\d?[\s,.;:]+(?:THE\s+)?(TOPPS|LEAF|BOWMAN|FLEER|DONRUSS|SCORE|UPPER\s+DECK|PANINI)/i;
    const garbledMatch = text.match(garbledBrandYear);
    if (garbledMatch && garbledMatch[1]) {
      const year = parseInt(garbledMatch[1], 10);
      if (year >= 1900 && year <= new Date().getFullYear()) {
        cardDetails.year = year;
        console.log(`Using garbled-copyright brand year as card date: ${cardDetails.year} (from "${garbledMatch[0]}")`);
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
        // Year+team pattern is non-legal text — clear any low-confidence flag
        // set earlier by the Leaf/Donruss copyright path.
        (cardDetails as any)._yearFromCopyright = false;
        console.log(`Using team-year pattern as card date: ${cardDetails.year}`);
        return;
      }
    }
    
    // Fall back to looking for 4-digit years (but this is less reliable)
    // This is more risky as it can pick up birth years or signing years
    const yearPattern = /\b(19\d{2}|20\d{2})\b/g;
    const yearCandidates: number[] = [];
    let ym;
    while ((ym = yearPattern.exec(text)) !== null) {
      const y = parseInt(ym[1], 10);
      if (y < 1900 || y > new Date().getFullYear()) continue;
      const ctx = text.substring(Math.max(0, ym.index - 40), ym.index).toUpperCase();
      if (/\b(SIGNED|ACQ|DRAFTED|BORN|TRADED|ACQUIRED|AGENT)\b/.test(ctx)) {
        console.log(`Skipping year ${y} — appears in signing/bio context`);
        continue;
      }
      yearCandidates.push(y);
    }
    
    if (yearCandidates.length > 0) {
      const modernYears = yearCandidates.filter(y => y >= 1980 && y <= 2026);
      if (modernYears.length > 0) {
        cardDetails.year = Math.max(...modernYears);
        console.log(`Selected latest modern year as most likely card date: ${cardDetails.year}`);
      } else {
        // Vintage card fallback — pick the LATEST year in the text, not the first.
        // Stats tables on vintage card backs span multiple years; the most recent
        // year (= copyright / latest stat line) is the production year. Picking
        // yearCandidates[0] incorrectly selected early stat years (e.g. 1976 on
        // a 1978-copyright Topps card where the stats start in 1974).
        cardDetails.year = Math.max(...yearCandidates);
        console.log(`Using latest detected year as card date (vintage fallback): ${cardDetails.year}`);
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
 * Detect CMP reference codes printed in the fine print on the back of sports cards.
 * CMP codes follow the pattern: "CMP" followed by 4–10 digits (e.g. "CMP100358").
 * They appear in copyright/legal text such as:
 *   "© 2025 Topps, LLC. All rights reserved. CMP100358"
 *
 * OCR commonly garbles the tiny legal text, producing variants like:
 *   - "CMP 100358" (space inserted)
 *   - "CMP1OO358" (digits read as letters)
 *   - "CMPI00358" or "CMPIO0358" (leading digit misread)
 *   - "CHP100358", "CNP100358", "GMP100358" (letter misreads)
 *   - "CMPID0358" (digit-letter transpositions)
 *   - Newline between CMP and digits
 */
function extractCmpNumber(fullText: string, cardDetails: Partial<CardFormValues>): void {
  // 1. Exact match: "CMP" immediately followed by digits (most reliable)
  const exactPattern = /(?<![A-Za-z])CMP(\d{4,10})/i;
  const exactMatch = fullText.match(exactPattern);
  if (exactMatch) {
    const code = `CMP${exactMatch[1]}`;
    cardDetails.cmpNumber = code;
    console.log(`[OCR] Detected CMP code: ${code}`);
    return;
  }

  // 2. Space/newline between CMP and digits: "CMP 100358" or "CMP\n100358"
  const spacedPattern = /(?<![A-Za-z])CMP[\s\n]+(\d{4,10})/i;
  const spacedMatch = fullText.match(spacedPattern);
  if (spacedMatch) {
    const code = `CMP${spacedMatch[1]}`;
    cardDetails.cmpNumber = code;
    console.log(`[OCR] Detected CMP code (with space): ${code}`);
    return;
  }

  // 3. OCR-garbled CMP prefix: common misreads of "CMP" in tiny print
  //    CHP, CNP, GMP, CMF, CWP, etc. — followed by digits
  const garbledPrefixPattern = /(?<![A-Za-z])(?:C[HMWN]P|[GC]MP|CM[FPB])[\s\n]*(\d{4,10})/i;
  const garbledPrefixMatch = fullText.match(garbledPrefixPattern);
  if (garbledPrefixMatch) {
    const code = `CMP${garbledPrefixMatch[1]}`;
    cardDetails.cmpNumber = code;
    console.log(`[OCR] Detected CMP code (garbled prefix "${garbledPrefixMatch[0].trim()}"): ${code}`);
    return;
  }

  // 4. Mixed letter/digit OCR errors in the digit string: "CMP1OO358" where O→0
  //    Match CMP followed by a mix of digits and O/I/l that looks like a code
  const mixedPattern = /(?<![A-Za-z])CMP[\s\n]*([0-9OoIl]{4,10})/i;
  const mixedMatch = fullText.match(mixedPattern);
  if (mixedMatch) {
    const cleaned = mixedMatch[1]
      .replace(/[Oo]/g, '0')
      .replace(/[Iil]/g, '1');
    if (/^\d{4,10}$/.test(cleaned)) {
      const code = `CMP${cleaned}`;
      cardDetails.cmpNumber = code;
      console.log(`[OCR] Detected CMP code (OCR digit fix "${mixedMatch[1]}" → "${cleaned}"): ${code}`);
      return;
    }
  }

  // 5. Bowman and some Topps products use a bare CODE# format without the "CMP" prefix
  //    e.g. "WWW.TOPPS.COM. CODE#065939"
  const bowmanCodePattern = /\bCODE[\s]*#[\s]*(\d{4,7})\b/i;
  const bowmanMatch = fullText.match(bowmanCodePattern);
  if (bowmanMatch) {
    cardDetails.cmpNumber = bowmanMatch[1];
    console.log(`[OCR] Detected Bowman-style CODE# in fine print: ${bowmanMatch[1]}`);
    return;
  }

  // 6. Last resort: look for a standalone 5-8 digit number at the very end of the text
  //    (last 200 chars) near copyright/legal context — many cards end with the CMP code
  //    as the final token on the card back.
  const tail = fullText.slice(-200);
  if (/(?:©|\(C\)|topps|panini|upper\s*deck|donruss|bowman|llc|inc\.|reserved)/i.test(tail)) {
    const endDigits = tail.match(/\b(\d{5,8})\s*$/);
    if (endDigits) {
      const code = `CMP${endDigits[1]}`;
      cardDetails.cmpNumber = code;
      console.log(`[OCR] Detected likely CMP code at end of legal text: ${code}`);
      return;
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
            console.log(`Updated to Aqua Foil foilType based on serial number: ${cardDetails.serialNumber}`);
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
        console.log('✅ Detected Aqua Foil foilType based on limited OCR text and numbered status');
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