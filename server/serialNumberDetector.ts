/**
 * Enhanced serial number detection for sports cards
 * Serial numbers appear as stamped text in silver/gold foil
 * Common formats: "010/399", "16/99", "123/1000"
 */

export interface SerialNumberResult {
  serialNumber: string;
  isNumbered: boolean;
  detectionMethod: string;
}

/**
 * Detect serial numbers from Google Vision text annotations
 * This function looks for the foil-stamped serial numbers that appear on limited edition cards
 */
export function detectSerialNumber(fullText: string, textAnnotations: any[]): SerialNumberResult {
  console.log('Starting enhanced serial number detection...');
  
  // First try: Look for serial numbers in text annotations with position data
  const positionBasedResult = detectSerialNumberFromPositions(textAnnotations);
  if (positionBasedResult.isNumbered) {
    if (isSerialNumberInBioContext(positionBasedResult.serialNumber, fullText)) {
      console.log(`Rejecting serial number "${positionBasedResult.serialNumber}" - appears in bio/stats context (likely a date)`);
    } else {
      console.log(`Serial number found via position detection: ${positionBasedResult.serialNumber}`);
      return positionBasedResult;
    }
  }
  
  // Second try: Look for serial numbers in the full text using pattern matching
  const patternBasedResult = detectSerialNumberFromPatterns(fullText);
  if (patternBasedResult.isNumbered) {
    console.log(`Serial number found via pattern detection: ${patternBasedResult.serialNumber}`);
    return patternBasedResult;
  }

  // Third try: Fuzzy fallback for hand-stamped / handwritten serials where OCR
  // mangled the numerator (e.g. "041/150" read as "DA1/150", "010/199" as
  // "OIO/199"). Accept when the denominator is a clean 2–4 digit number that
  // looks like a print-run limit AND the numerator is a short token with at
  // least one digit (so we know we're looking at a serial, not arbitrary
  // text). The numerator can't be reconstructed reliably, so we report the
  // limit-only form (e.g. "/150") and let the user edit if they care about
  // the exact position. The card still gets correctly flagged as numbered
  // and the right /150 parallel can be picked.
  const fuzzyResult = detectSerialNumberFuzzy(fullText);
  if (fuzzyResult.isNumbered) {
    console.log(`Serial number found via fuzzy fallback: ${fuzzyResult.serialNumber} (raw OCR token preserved as numerator was unreadable)`);
    return fuzzyResult;
  }

  console.log('No serial number detected');
  return {
    serialNumber: '',
    isNumbered: false,
    detectionMethod: 'none'
  };
}

/**
 * Detect serial numbers using position data from Google Vision
 * Serial numbers are typically isolated in corners of the card
 */
function detectSerialNumberFromPositions(textAnnotations: any[]): SerialNumberResult {
  try {
    // Look for text that matches serial number pattern
    const serialCandidates = textAnnotations.filter(annotation => {
      const text = annotation.description;
      
      // Must match the exact serial number format
      return /^\d{1,3}\/\d{1,4}$/.test(text);
    });
    
    if (serialCandidates.length === 0) {
      return { serialNumber: '', isNumbered: false, detectionMethod: 'position' };
    }
    
    // Sort by position preference (bottom-right is most common for serial numbers)
    const sortedCandidates = serialCandidates.sort((a, b) => {
      const aPos = getAnnotationPosition(a);
      const bPos = getAnnotationPosition(b);
      
      // Prefer bottom-right positions
      const aScore = aPos.x + aPos.y; // Higher values = more bottom-right
      const bScore = bPos.x + bPos.y;
      
      return bScore - aScore;
    });
    
    const topCandidate = sortedCandidates[0];
    
    // Basic format validation (allows denominator >= 1)
    if (!isValidSerialNumber(topCandidate.description)) {
      return { serialNumber: '', isNumbered: false, detectionMethod: 'position-invalid' };
    }

    const isIsolated = checkIfIsolated(topCandidate, textAnnotations);
    const position = getAnnotationPosition(topCandidate);
    const isInCornerArea = (position.x > 700 || position.x < 200) && (position.y > 500 || position.y < 200);

    if (isIsolated) {
      return {
        serialNumber: topCandidate.description,
        isNumbered: true,
        detectionMethod: 'position-isolated'
      };
    }
    
    if (isInCornerArea) {
      return {
        serialNumber: topCandidate.description,
        isNumbered: true,
        detectionMethod: 'position-corner'
      };
    }

    // Not isolated and not in a corner — this is likely inside the central text block.
    // Require denominator >= 10 to avoid false positives from dates/stats.
    if (!isValidSerialNumber(topCandidate.description, true)) {
      console.log(`Rejecting position-format serial "${topCandidate.description}" — small denominator without corner/isolated position`);
      return { serialNumber: '', isNumbered: false, detectionMethod: 'position-invalid-center' };
    }

    return {
      serialNumber: topCandidate.description,
      isNumbered: true,
      detectionMethod: 'position-format'
    };
  } catch (error) {
    console.error('Error in position-based serial number detection:', error);
    return { serialNumber: '', isNumbered: false, detectionMethod: 'position-error' };
  }
}

/**
 * Detect serial numbers using text pattern matching
 * This is a fallback when position data isn't reliable
 */
function detectSerialNumberFromPatterns(fullText: string): SerialNumberResult {
  try {
    // Common serial number patterns — allow 1+ digit denominators (/1, /5, /99, /1000)
    // The third pattern uses the literal word "OF" — this notation is
    // overwhelmingly used for INSERT POSITIONS ("card 13 of 24 in the
    // All-Stars insert set"), not print-run serials. True serials almost
    // always use a slash. We tag matches from this pattern and reject
    // them when the denominator is small.
    const patterns: Array<{ re: RegExp; isWordOf: boolean }> = [
      { re: /\b(\d{1,3}\/\d{1,4})\b/g,          isWordOf: false },
      { re: /\b(\d{1,3})\s*\/\s*(\d{1,4})\b/g,  isWordOf: false },
      { re: /\b(\d{1,3})\s+OF\s+(\d{1,4})\b/gi, isWordOf: true  },
    ];
    
    // Split text into lines to avoid matching serial numbers in paragraphs
    const lines = fullText.split('\n');
    
    for (const line of lines) {
      // Skip lines with common non-serial number keywords
      if (/TRADED|ACQUIRED|CONTRACT|BORN|STATS|RECORD|CAREER|HIGHLIGHTS|PERFORMANCE|DRAFTED/i.test(line)) {
        continue;
      }
      
      // For long lines (copyright blocks, etc.), only try the serial patterns —
      // serial numbers like "010/399" often appear in long copyright text on card backs
      const isLongLine = line.length > 50;
      
      for (const { re: pattern, isWordOf } of patterns) {
        pattern.lastIndex = 0; // Reset regex
        const matches = Array.from(line.matchAll(pattern));
        
        for (const match of matches) {
          let serialNumber = '';
          
          if (match[1] && !match[2]) {
            serialNumber = match[1];
          } else if (match[1] && match[2]) {
            serialNumber = `${match[1]}/${match[2]}`;
          }
          
          if (serialNumber && isValidSerialNumber(serialNumber)) {
            // Always check for print-code masquerading as serial (e.g.
            // "19/93" on a 1993 card). Cheap to run, catches false
            // positives the bio-context check misses on short lines.
            if (isSerialNumberInBioContext(serialNumber, fullText)) {
              continue;
            }
            // "X OF Y" notation with the literal word "OF" is, by
            // definition, a card-position-in-set marker (e.g. "13 of
            // 24" on an insert, "174 of 660" on a base-set card),
            // NEVER a true print-run serial. Real print-run serials
            // are always written with a slash ("13/24", "174/660"),
            // never with the word "of". Reject unconditionally so the
            // downstream card-number detector can interpret X as the
            // card number instead.
            if (isWordOf) {
              const denomOf = parseInt(serialNumber.split('/')[1], 10);
              console.log(`Rejecting "X of Y" pattern "${match[0]}" → "${serialNumber}" (denominator ${denomOf}) — literal "OF" denotes card position in set, not a print-run serial`);
              continue;
            }
            if (isLongLine && isSerialNumberInBioContext(serialNumber, line)) {
              continue;
            }
            // Small denominators (< 10) via pattern matching (no position data)
            // are high risk for date/stat false positives (e.g. "3/5", "8/7").
            // Only accept if the line is very short (standalone serial) or
            // an explicit bio-context check passes.
            const denom = parseInt(serialNumber.split('/')[1], 10);
            if (denom < 10) {
              const trimmed = line.trim();
              if (trimmed !== serialNumber && trimmed.length > 15) {
                console.log(`Rejecting pattern serial "${serialNumber}" — small denominator on non-standalone line`);
                continue;
              }
              if (isSerialNumberInBioContext(serialNumber, fullText)) {
                console.log(`Rejecting pattern serial "${serialNumber}" — small denominator in bio context`);
                continue;
              }
            }
            return {
              serialNumber,
              isNumbered: true,
              detectionMethod: 'pattern-match'
            };
          }
        }
      }
    }
    
    return { serialNumber: '', isNumbered: false, detectionMethod: 'pattern' };
  } catch (error) {
    console.error('Error in pattern-based serial number detection:', error);
    return { serialNumber: '', isNumbered: false, detectionMethod: 'pattern-error' };
  }
}

/**
 * Get the center position of a text annotation
 */
function getAnnotationPosition(annotation: any): { x: number; y: number } {
  try {
    const boundingPoly = annotation.boundingPoly;
    if (!boundingPoly || !boundingPoly.vertices || boundingPoly.vertices.length === 0) {
      return { x: 0, y: 0 };
    }
    
    const vertices = boundingPoly.vertices;
    const centerX = vertices.reduce((sum: number, v: any) => sum + (v.x || 0), 0) / vertices.length;
    const centerY = vertices.reduce((sum: number, v: any) => sum + (v.y || 0), 0) / vertices.length;
    
    return { x: centerX, y: centerY };
  } catch (error) {
    return { x: 0, y: 0 };
  }
}

/**
 * Check if a text annotation is isolated from other text
 * Serial numbers are typically stamped separately from other text
 */
function checkIfIsolated(targetAnnotation: any, allAnnotations: any[]): boolean {
  try {
    const targetPos = getAnnotationPosition(targetAnnotation);
    const minDistance = 60; // Minimum distance in pixels
    
    const nearbyAnnotations = allAnnotations.filter(annotation => {
      if (annotation === targetAnnotation) return false;
      
      const pos = getAnnotationPosition(annotation);
      const distance = Math.sqrt(
        Math.pow(targetPos.x - pos.x, 2) + 
        Math.pow(targetPos.y - pos.y, 2)
      );
      
      return distance < minDistance;
    });
    
    // Serial numbers should have very few (ideally 0) nearby text elements
    return nearbyAnnotations.length <= 1;
  } catch (error) {
    return false;
  }
}

/**
 * Check if a serial number candidate appears within bio/stats context
 * This catches dates like "8/20" that appear in player bio text (e.g., "stolen base, 8/20.")
 */
function isSerialNumberInBioContext(serialNumber: string, fullText: string): boolean {
  const parts = serialNumber.split('/');
  if (parts.length === 2) {
    const numerator = parts[0];
    const denominator = parseInt(parts[1], 10);

    // Catch print-codes that look like serials, e.g. "19/93" on a 1993
    // card or "20/12" on a 2012 card. If the numerator is a valid year
    // century prefix (19 or 20) and the concatenation forms a 4-digit
    // year that ALSO appears elsewhere in the OCR text, this is the
    // copyright/print-year split across a slash by Vision — not a
    // serial. Sport-agnostic, no card-specific rules.
    if ((numerator === '19' || numerator === '20') && parts[1].length === 2) {
      const reconstructedYear = `${numerator}${parts[1]}`;
      const yearNum = parseInt(reconstructedYear, 10);
      if (yearNum >= 1900 && yearNum <= 2099) {
        const yearTokens = (fullText.match(/\b(19|20)\d{2}\b/g) || []);
        if (yearTokens.includes(reconstructedYear)) {
          console.log(`Rejecting "${serialNumber}" — looks like a ${reconstructedYear} print-code (year token also present in OCR text)`);
          return true;
        }
      }
    }

    if (denominator >= 50) {
      console.log(`Serial number "${serialNumber}" has denominator ${denominator} >= 50, not a date - accepting`);
      return false;
    }
  }
  
  const lines = fullText.split('\n');
  
  for (const line of lines) {
    if (!line.includes(serialNumber)) continue;
    
    const trimmed = line.trim();
    if (trimmed === serialNumber) {
      console.log(`Serial number "${serialNumber}" found on its own line - accepting`);
      return false;
    }
    
    const upper = line.toUpperCase();
    
    if (/RESUME|CAREER|HIGHLIGHTS|BRIEFING|SKILLS|CLOSE|SCOUTING|BIOGRAPHY|PROFILE/i.test(upper)) return true;
    if (/BORN|DRAFTED|SIGNED|ACQUIRED|ACQ:|HOME:|BATS:|THROWS:|HT:|WT:/i.test(upper)) return true;
    if (/HOMER|HIT|RBI|STOLEN|BASE|BATTING|PITCHING|LEAGUE|SEASON|RECORD/i.test(upper)) return true;
    if (/WEEK|CIRCUIT|LOGGED|BOOKED|POSTED|NOTCHED|SLASHED|BATTED|THREW/i.test(upper)) return true;
    
    const datePatterns = (line.match(/\d{1,2}\/\d{1,2}/g) || []).length;
    if (datePatterns >= 2) return true;
    
    if (line.length > 80) return true;
  }
  
  return false;
}

/**
 * Validate that a detected serial number looks legitimate.
 * `requirePosition` controls strictness:
 *   - false (default): general validation, denominator >= 1
 *   - true : used when the candidate lacks strong positional evidence
 *            (i.e., not isolated and not in a corner), so we require
 *            denominator >= 10 to avoid date/stat false positives.
 */
function isValidSerialNumber(serialNumber: string, requirePosition: boolean = false): boolean {
  const parts = serialNumber.split('/');
  if (parts.length !== 2) return false;
  
  const num = parseInt(parts[0], 10);
  const total = parseInt(parts[1], 10);
  
  const minDenominator = requirePosition ? 10 : 1;

  return (
    !isNaN(num) && 
    !isNaN(total) && 
    num > 0 && 
    num <= total && 
    total >= minDenominator &&
    total <= 10000
  );
}

/**
 * Fuzzy fallback: catch handwritten / hand-stamped serials whose numerator
 * was OCR'd as letters (e.g. "041/150" → "DA1/150", "010/199" → "OIO/199").
 * The numerator is unreliable so we report only the limit ("/150"), which is
 * enough for the parallel picker to find the right /150 variation.
 *
 * Heuristics (kept conservative to avoid false positives):
 *   - Token shape: 1–4 chars (letters and/or digits), then "/", then 2–4 digits
 *   - Denominator must look like a print run (10–9999) and not be a date
 *   - Numerator must contain at least one letter that's a known OCR
 *     confusion for a digit (O, D, Q, I, L, S, B, Z, G, A) — pure-letter
 *     "AB/12" is rejected; "DA1/150" is accepted because D and A are common
 *     misreads of 0
 *   - Skip lines that look like bio/stat text
 */
function detectSerialNumberFuzzy(fullText: string): SerialNumberResult {
  try {
    // Letters that the Vision API regularly returns instead of digits when
    // reading low-contrast hand-stamped serials. Anything in this set counts
    // as "could be a digit".
    const digitLikeLetters = /[ODQIULSBZGA]/i;

    const fuzzyPattern = /\b([A-Z0-9]{1,4})\s*\/\s*(\d{2,4})\b/g;

    const lines = fullText.split('\n');
    for (const line of lines) {
      // Skip obvious bio/stat lines (same filter the strict pattern uses).
      if (/TRADED|ACQUIRED|CONTRACT|BORN|STATS|RECORD|CAREER|HIGHLIGHTS|PERFORMANCE|DRAFTED/i.test(line)) {
        continue;
      }

      fuzzyPattern.lastIndex = 0;
      const matches = Array.from(line.matchAll(fuzzyPattern));

      for (const match of matches) {
        const numerator = match[1];
        const denominator = match[2];

        // If the numerator is already pure digits, the strict pattern would
        // have caught it — skip here to avoid duplicating that path.
        if (/^\d+$/.test(numerator)) continue;

        // Require at least one digit-like letter in the numerator, so we
        // don't accept random short tokens like "OF/100" or "AB/50".
        if (!digitLikeLetters.test(numerator)) continue;

        const denomNum = parseInt(denominator, 10);
        if (isNaN(denomNum) || denomNum < 10 || denomNum > 9999) continue;

        // Reject if the surrounding context is clearly bio/date-like for
        // small denominators.
        const limitOnly = `/${denomNum}`;
        if (denomNum < 50 && isSerialNumberInBioContext(`1/${denomNum}`, fullText)) continue;

        return {
          serialNumber: limitOnly,
          isNumbered: true,
          detectionMethod: 'fuzzy-handstamped',
        };
      }
    }

    return { serialNumber: '', isNumbered: false, detectionMethod: 'fuzzy' };
  } catch (error) {
    console.error('Error in fuzzy serial number detection:', error);
    return { serialNumber: '', isNumbered: false, detectionMethod: 'fuzzy-error' };
  }
}