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
    const patterns = [
      /\b(\d{1,3}\/\d{1,4})\b/g,           // 1/1, 010/399, 16/99, 123/1000
      /\b(\d{1,3})\s*\/\s*(\d{1,4})\b/g,   // 010 / 399 (with spaces)
      /\b(\d{1,3})\s+OF\s+(\d{1,4})\b/gi,  // 16 OF 99
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
      
      for (const pattern of patterns) {
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
    const denominator = parseInt(parts[1], 10);
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