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
    console.log(`Serial number found via position detection: ${positionBasedResult.serialNumber}`);
    return positionBasedResult;
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
    
    // Check if the top candidate is isolated (serial numbers are typically alone)
    const topCandidate = sortedCandidates[0];
    const isIsolated = checkIfIsolated(topCandidate, textAnnotations);
    
    if (isIsolated) {
      return {
        serialNumber: topCandidate.description,
        isNumbered: true,
        detectionMethod: 'position-isolated'
      };
    }
    
    // If not isolated, still consider it if it's in a corner position
    const position = getAnnotationPosition(topCandidate);
    if (position.x > 800 && position.y > 600) { // Bottom-right area
      return {
        serialNumber: topCandidate.description,
        isNumbered: true,
        detectionMethod: 'position-corner'
      };
    }
    
    return { serialNumber: '', isNumbered: false, detectionMethod: 'position' };
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
    // Common serial number patterns
    const patterns = [
      /\b(\d{1,3}\/\d{2,4})\b/g,           // 010/399, 16/99, 123/1000
      /\b(\d{1,3})\s*\/\s*(\d{2,4})\b/g,   // 010 / 399 (with spaces)
      /\b(\d{1,3})\s+OF\s+(\d{2,4})\b/gi,  // 16 OF 99
    ];
    
    // Split text into lines to avoid matching serial numbers in paragraphs
    const lines = fullText.split('\n');
    
    for (const line of lines) {
      // Skip long lines that are likely paragraph text
      if (line.length > 50) continue;
      
      // Skip lines with common non-serial number keywords
      if (/TRADED|ACQUIRED|CONTRACT|BORN|STATS|RECORD|CAREER|HIGHLIGHTS|PERFORMANCE|DRAFTED/i.test(line)) {
        continue;
      }
      
      for (const pattern of patterns) {
        pattern.lastIndex = 0; // Reset regex
        const matches = Array.from(line.matchAll(pattern));
        
        for (const match of matches) {
          let serialNumber = '';
          
          if (match[1] && !match[2]) {
            // Single capture group (e.g., "010/399")
            serialNumber = match[1];
          } else if (match[1] && match[2]) {
            // Two capture groups (e.g., "010" and "399")
            serialNumber = `${match[1]}/${match[2]}`;
          }
          
          if (serialNumber && isValidSerialNumber(serialNumber)) {
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
 * Validate that a detected serial number looks legitimate
 */
function isValidSerialNumber(serialNumber: string): boolean {
  const parts = serialNumber.split('/');
  if (parts.length !== 2) return false;
  
  const num = parseInt(parts[0], 10);
  const total = parseInt(parts[1], 10);
  
  // Basic validation rules
  return (
    !isNaN(num) && 
    !isNaN(total) && 
    num > 0 && 
    num <= total && 
    total >= 10 && // Most serial numbers are at least /10
    total <= 10000 && // Most don't exceed /10000
    num < total // Serial number should be less than total
  );
}