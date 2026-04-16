import { CardFormValues } from '../shared/schema';
import { ImageAnnotatorClient } from '@google-cloud/vision';

// ── Singleton Vision client ───────────────────────────────────────────────────
// Initialised once on first use and reused across all requests. This avoids
// the ~100-200ms credential-parsing + gRPC channel setup overhead per call.
let _visionClient: ImageAnnotatorClient | null = null;

// ── Per-request OCR result cache ─────────────────────────────────────────────
// batchExtractTextFromImages() populates this before the downstream analysers
// run. extractTextFromImage() checks it first so that a batch call eliminates
// all redundant Vision API round-trips within the same scan request.
// Key = first 100 chars of base64 + total length. Using only the first 100 chars is
// insufficient because all JPEG files from the same camera share identical header bytes;
// adding the length makes front vs. back images always distinct cache entries.
const _ocrCache = new Map<string, { fullText: string; textAnnotations: any[] }>();

function _cacheKey(base64: string): string {
  return base64.substring(0, 100) + '_' + base64.length;
}

export function clearOcrCache(): void {
  _ocrCache.clear();
}

function getVisionClient(): ImageAnnotatorClient {
  if (_visionClient) return _visionClient;

  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    throw new Error('Missing Google Cloud service account credentials');
  }

  console.log('Initializing Google Vision client (once)...');

  let cleanPrivateKey = privateKey
    .replace(/\\n/g, '\n')
    .replace(/^["']|["']$/g, '');

  if (!cleanPrivateKey.startsWith('-----BEGIN')) {
    cleanPrivateKey = `-----BEGIN PRIVATE KEY-----\n${cleanPrivateKey}\n-----END PRIVATE KEY-----`;
  }

  const formattedKey = cleanPrivateKey
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join('\n');

  try {
    _visionClient = new ImageAnnotatorClient({
      credentials: {
        client_email: clientEmail,
        private_key: formattedKey,
      },
    });
    return _visionClient;
  } catch (error: any) {
    console.error('Failed to initialize Vision client:', error.message);
    throw new Error(`Google Vision client initialization failed: ${error.message}`);
  }
}

/**
 * Improve detection of RC (Rookie Card) logo in images
 * This function is specifically designed to find the small RC logo that appears 
 * in the corner of rookie cards, which is easy to miss with standard OCR.
 */
function isRCLogoPresent(textAnnotations: any[]): boolean {
  // ENHANCED ROOKIE CARD DETECTION
  // This function has been significantly improved to detect RC logos on cards
  // with greater accuracy, handling different formats and positions
  
  // First check the full text of all annotations combined
  // This helps detect when OCR has fragmented the "RC" text across multiple text blocks
  const allCombinedText = textAnnotations
    .map(a => (a.description || '').trim().toUpperCase())
    .join(' ');
    
  // Look for rookie indicators in the combined text
  const hasRookieTextIndicator = 
    allCombinedText.includes('ROOKIE CARD') || 
    allCombinedText.includes('ROOKIES') ||
    allCombinedText.includes('DEBUT') ||
    allCombinedText.includes('FIRST YEAR') ||
    allCombinedText.includes('1ST MLB') ||
    /\bRC\b/.test(allCombinedText); // RC as a standalone word
    
  if (hasRookieTextIndicator) {
    console.log('Found rookie indicator in combined card text');
    return true;
  }
  
  // Check each text annotation individually for RC patterns
  const potentialRcLogos = textAnnotations.filter(annotation => {
    // Skip null/undefined descriptions
    if (!annotation.description) return false;
    
    const text = annotation.description.trim().toUpperCase();
    
    // Expanded check for "RC" text with more patterns and variations
    const isRCLogo = 
      text === 'RC' || 
      text === 'R.C.' || 
      text === 'R C' ||
      text === 'RC.' ||
      text === 'R.C' ||
      text === 'R/C' ||
      text === 'ROOKIE CARD' ||
      text.includes('TOPPS RC') ||
      /\bRC\b/.test(text); // RC as a word boundary
      
    if (isRCLogo) {
      console.log('Found RC logo text:', text);
      
      // Get bounding poly to check position if available
      const boundingPoly = annotation.boundingPoly;
      if (boundingPoly && boundingPoly.vertices) {
        // RC logos are sometimes very small, but clearly visible on cards
        // Check for smaller dimensions which is common for RC logos
        const width = Math.max(
          Math.abs((boundingPoly.vertices[1]?.x || 0) - (boundingPoly.vertices[0]?.x || 0)),
          Math.abs((boundingPoly.vertices[2]?.x || 0) - (boundingPoly.vertices[3]?.x || 0))
        );
        
        const height = Math.max(
          Math.abs((boundingPoly.vertices[3]?.y || 0) - (boundingPoly.vertices[0]?.y || 0)),
          Math.abs((boundingPoly.vertices[2]?.y || 0) - (boundingPoly.vertices[1]?.y || 0))
        );
        
        // Increased size threshold for RC detection
        // Many RC marks are larger than previously assumed
        const isReasonableSize = width < 150 && height < 150;
        
        console.log(`RC text dimensions: ${width}x${height}, size check: ${isReasonableSize}`);
        
        if (isReasonableSize) {
          console.log('Detected RC logo with appropriate dimensions');
          return true;
        }
      } else {
        // If no bounding poly, still consider it an RC indicator
        console.log('No bounding poly but found RC text');
        return true;
      }
    }
    
    // Expanded check for MLB logo with RC nearby or combined
    if ((text.includes('MLB') || text.includes('TOPPS')) && text.length < 15) {
      console.log('Found MLB or TOPPS logo, checking for nearby RC indicators');
      
      // Check for RC text near this MLB/TOPPS text
      const boundingPoly = annotation.boundingPoly;
      if (boundingPoly && boundingPoly.vertices) {
        // Get center point of this text
        const centerX = boundingPoly.vertices.reduce((sum, v) => sum + (v.x || 0), 0) / boundingPoly.vertices.length;
        const centerY = boundingPoly.vertices.reduce((sum, v) => sum + (v.y || 0), 0) / boundingPoly.vertices.length;
        
        // Look for nearby text annotations that might contain RC
        const nearbyRCText = textAnnotations.some(nearby => {
          if (!nearby.boundingPoly || !nearby.boundingPoly.vertices) return false;
          if (nearby === annotation) return false;
          
          // Calculate center of nearby annotation
          const nbCenterX = nearby.boundingPoly.vertices.reduce((sum, v) => sum + (v.x || 0), 0) / nearby.boundingPoly.vertices.length;
          const nbCenterY = nearby.boundingPoly.vertices.reduce((sum, v) => sum + (v.y || 0), 0) / nearby.boundingPoly.vertices.length;
          
          // Calculate distance between centers
          const distance = Math.sqrt(
            Math.pow(centerX - nbCenterX, 2) + 
            Math.pow(centerY - nbCenterY, 2)
          );
          
          // Check if nearby text is RC-related and within reasonable distance
          // Increased the distance threshold to be more generous in detection
          const isNearby = distance < 300;
          const nearbyText = (nearby.description || '').trim().toUpperCase();
          const isRCText = 
            nearbyText === 'RC' || 
            nearbyText === 'R.C.' || 
            nearbyText.includes('ROOKIE') || 
            /\bRC\b/.test(nearbyText);
          
          if (isNearby && isRCText) {
            console.log(`Found RC text "${nearbyText}" near MLB/TOPPS logo, distance: ${distance}`);
            return true;
          }
          
          return false;
        });
        
        if (nearbyRCText) {
          return true;
        }
      }
    }
    
    return false;
  });
  
  // Also look specifically for the MLB RC badge which is sometimes detected as a single unit
  // These are often detected in the bottom right corner of cards
  const hasMLBRCBadge = textAnnotations.some(annotation => {
    if (!annotation.description) return false;
    
    const text = annotation.description.trim().toUpperCase();
    const isMLBRCBadge = 
      (text.includes('RC') && text.includes('MLB') && text.length < 20) ||
      (text.includes('RC') && text.includes('TOPPS') && text.length < 20);
      
    if (isMLBRCBadge) {
      console.log('Detected MLB/TOPPS RC badge in text:', text);
      return true;
    }
    
    return false;
  });
  
  if (hasMLBRCBadge) {
    console.log('Detected MLB/TOPPS RC badge');
    return true;
  }
  
  // Check if we found any RC indicators
  if (potentialRcLogos.length > 0) {
    console.log('Detected RC logo based on individual text annotations');
    return true;
  }
  
  // No RC indicators found
  return false;
}

/**
 * Extract text from a single image using Google Cloud Vision API.
 *
 * Uses DOCUMENT_TEXT_DETECTION (designed for dense, structured text such as
 * printed cards, documents, and receipts — far superior to TEXT_DETECTION for
 * sports cards which have multiple fonts, sizes, and foil backgrounds).
 *
 * Checks the per-request OCR cache first; if batchExtractTextFromImages() was
 * called upfront the Vision round-trip is skipped entirely for this image.
 */
export async function extractTextFromImage(base64Image: string): Promise<{ fullText: string, textAnnotations: any[] }> {
  try {
    // ── Cache check ──────────────────────────────────────────────────────────
    const cacheKey = _cacheKey(base64Image);
    const cached = _ocrCache.get(cacheKey);
    if (cached) {
      console.log('OCR cache hit — skipping Vision API call');
      return cached;
    }

    console.log('Attempting Google Cloud Vision API...');

    const client = getVisionClient();

    // DOCUMENT_TEXT_DETECTION produces a richer structured result than
    // TEXT_DETECTION for printed/typeset text. It returns:
    //   • fullTextAnnotation  — full page hierarchy with per-word confidence
    //   • textAnnotations     — same flat list as TEXT_DETECTION (backwards
    //                           compatible with all existing bounding-box code)
    // languageHints: ['en'] reduces character-level misreads (e.g. "Lapps"
    // instead of "Topps") by biasing the recogniser toward English.
    const request = {
      image: { content: base64Image },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' as const }],
      imageContext: { languageHints: ['en'] },
    };

    console.log('Sending request to Vision API...');
    const [result] = await client.annotateImage(request);
    console.log('Vision API Response received');

    const fullText = result.fullTextAnnotation?.text || '';
    const rawAnnotations = result.textAnnotations || [];

    // Filter out noise: drop single-character fragments that Vision occasionally
    // returns as artefacts of foil/holographic backgrounds, while keeping all
    // multi-character annotations unchanged.
    const textAnnotations = rawAnnotations.filter((a: any) => {
      const t = (a.description || '').trim();
      // Always keep the first annotation (index 0) — it is the full-page text block
      if (rawAnnotations.indexOf(a) === 0) return true;
      // Drop pure noise: single chars, blank strings, pure punctuation runs
      if (t.length === 0) return false;
      if (t.length === 1 && /[^A-Za-z0-9]/.test(t)) return false;
      return true;
    });

    console.log(`Extracted ${textAnnotations.length} text annotations (${rawAnnotations.length} raw)`);

    const ocrResult = { fullText, textAnnotations };
    _ocrCache.set(cacheKey, ocrResult);
    return ocrResult;
  } catch (error: any) {
    console.error('Error in OCR processing:', error);
    throw new Error(`Failed to analyze image with Google Vision: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Batch-extract text from multiple images in a SINGLE Vision API call.
 *
 * Call this at the start of a scan request with all image buffers. Results are
 * stored in the per-request OCR cache so that every subsequent call to
 * extractTextFromImage() for the same image is a free cache hit.
 *
 * This reduces Vision API calls from 4 (2 per image × 2 images) down to 1
 * for a typical front+back dual-image scan, saving 200-400 ms.
 */
export async function batchExtractTextFromImages(
  images: { base64: string; label: string }[]
): Promise<void> {
  if (images.length === 0) return;

  const client = getVisionClient();

  const requests = images.map(({ base64 }) => ({
    image: { content: base64 },
    features: [{ type: 'DOCUMENT_TEXT_DETECTION' as const }],
    imageContext: { languageHints: ['en'] },
  }));

  console.log(`Batch Vision API call: ${images.length} image(s) in one request...`);
  const [batchResult] = await client.batchAnnotateImages({ requests });
  console.log('Batch Vision API response received');

  const responses = batchResult.responses || [];
  responses.forEach((result: any, i: number) => {
    const img = images[i];
    if (!img) return;

    const fullText = result.fullTextAnnotation?.text || '';
    const rawAnnotations = result.textAnnotations || [];
    const textAnnotations = rawAnnotations.filter((a: any, idx: number) => {
      const t = (a.description || '').trim();
      if (idx === 0) return true;
      if (t.length === 0) return false;
      if (t.length === 1 && /[^A-Za-z0-9]/.test(t)) return false;
      return true;
    });

    console.log(`  [${img.label}] ${textAnnotations.length} annotations extracted`);
    _ocrCache.set(_cacheKey(img.base64), { fullText, textAnnotations });
  });
}

/**
 * Analyze a sports card image to extract relevant information
 * @param base64Image Base64 encoded image data
 * @returns Object with extracted card information
 */
export async function analyzeSportsCardImage(base64Image: string): Promise<Partial<CardFormValues>> {
  try {
    console.time('ocr-analysis-timer');
    
    // Set a default result in case anything fails
    const defaultResult: Partial<CardFormValues> = {
      condition: 'PSA 8',
      sport: '',
      brand: '',
      year: new Date().getFullYear()
    };
    
    // Extract text from image
    let extractedData;
    
    // If base64Image is a Buffer, convert it to base64 string
    const base64String = Buffer.isBuffer(base64Image) 
      ? base64Image.toString('base64') 
      : base64Image;
    
    try {
      extractedData = await extractTextFromImage(base64String);
    } catch (ocrError) {
      console.error('Error during OCR text extraction:', ocrError);
      // Return default values instead of failing completely
      return defaultResult;
    }
    
    // If we couldn't get any text, return default values
    if (!extractedData || !extractedData.fullText) {
      console.log('No text could be extracted from the image');
      return defaultResult;
    }
    
    const { fullText, textAnnotations } = extractedData;
    
    // Process the text to extract card information
    const result: Partial<CardFormValues> = {
      condition: 'PSA 8' // Set default condition to PSA 8 for all cards
    };
    
    if (!fullText) {
      return result;
    }
    
    // Convert to lowercase for easier pattern matching
    const lowerText = fullText.toLowerCase();
    
    // Sport detection is handled by dynamicCardAnalyzer.ts detectSport() via keyword scoring
    
    // Extract player name - looking for known patterns first, then general patterns
    
    // Define common text patterns that are NOT valid player names
    const nonPlayerNamePatterns = [
      'MAJOR LEAGUE', 'MAJOR LEAGUE BASEBALL', 'MLB', 'BASEBALL', 'TOPPS',
      'ALL STAR', 'ALL-STAR', 'ROOKIE', 'CHROME', 'HERITAGE', 'ANNIVERSARY',
      'STARS OF MLB', 'STARS OF', 'SERIES', 'EDITION', 'CARD', 'GAME', 
      'LEAGUE', 'PRODUCT', 'LAPPS', 'LICENSED', 'COPYRIGHT', 'PLAYERS',
      'OFFICIAL', 'TRADEMARK', 'COMPANY', 'RESERVED', 'VISIT', 'MINNESOTA',
      'TWINS', 'CHICAGO', 'PADRES', 'DODGERS', 'YANKEES'
    ];
    
    // Clean up any incorrect player detection like "Major League"
    if (fullText) {
      if ((result.playerFirstName === 'Major' && result.playerLastName === 'League') ||
          (result.playerFirstName === 'League' && result.playerLastName === 'Baseball')) {
        // These are not player names but part of "Major League Baseball" text
        result.playerFirstName = '';
        result.playerLastName = '';
        console.log('Cleared incorrect player name detection (Major League/League Baseball)');
      }
      
      // Look for player name using dynamic detection - not hardcoded names
      // First, check for player name in prominent positions on the card
      const playerNameOnCard = textAnnotations.find(a => {
        const text = a.description;
        // Player names are often in large text and capital letters
        if (!/^[A-Z\s]+$/.test(text) || text.length < 4 || text.length > 30) return false;
        
        // Skip team names and marketing text
        if (nonPlayerNamePatterns.some(p => text.includes(p))) return false;
        
        // Check if this annotation is prominent on the card (larger text means larger bounding box)
        const box = a.boundingPoly;
        if (!box || !box.vertices) return false;
        
        // Calculate area of the text box (approximate size)
        const width = Math.max(...box.vertices.map((v: any) => v.x)) - Math.min(...box.vertices.map((v: any) => v.x));
        const height = Math.max(...box.vertices.map((v: any) => v.y)) - Math.min(...box.vertices.map((v: any) => v.y));
        const area = width * height;
        
        // Look for larger text that might be player names
        return area > 5000 && /\s/.test(text); // Must have at least one space (first and last name)
      });
      
      if (playerNameOnCard) {
        const name = playerNameOnCard.description.trim();
        const nameParts = name.split(/\s+/);
        
        if (nameParts.length >= 2) {
          // Format names in proper case
          result.playerFirstName = nameParts[0].charAt(0) + nameParts[0].slice(1).toLowerCase();
          
          if (nameParts.length > 2) {
            result.playerLastName = nameParts.slice(1).map(part => 
              part.charAt(0) + part.slice(1).toLowerCase()
            ).join(' ');
          } else {
            result.playerLastName = nameParts[1].charAt(0) + nameParts[1].slice(1).toLowerCase();
          }
          
          console.log(`DETECTED: Player name from prominent text: ${result.playerFirstName} ${result.playerLastName}`);
        }
      }
      
      // More specific player name detection using clues from the card
      // Look for common formats like "CARLOS CORREA" or "FIRST LAST | TEAM"
      const playerPatterns = [
        /([A-Z]{2,})\s+([A-Z]{2,})/,
        /([A-Z][a-z]+)\s+([A-Z][a-z]+)/
      ];
      
      for (const pattern of playerPatterns) {
        const matches = fullText.match(pattern);
        if (matches && matches.length >= 3) {
          const first = matches[1];
          const last = matches[2];
          
          // Skip invalid name patterns
          if (nonPlayerNamePatterns.some(p => first.includes(p) || last.includes(p))) {
            continue;
          }
          
          // Format in proper case
          const firstName = first.charAt(0) + first.slice(1).toLowerCase();
          const lastName = last.charAt(0) + last.slice(1).toLowerCase();
          
          // Only override if we don't already have a player name, or if this name is more likely to be correct
          if (!result.playerFirstName || !result.playerLastName) {
            result.playerFirstName = firstName;
            result.playerLastName = lastName;
            console.log(`DETECTED: Player name from text pattern: ${firstName} ${lastName}`);
          }
          
          break;
        }
      }
      
    }
    
    // Generic player name detection for all cards
    // Look for player name patterns: FIRST LAST or FIRST MIDDLE LAST formats
    const playerNameMatch = fullText.match(/([A-Z]{2,})\s+([A-Z]{2,}(?:\s+[A-Z]{2,})?)/);
    
    if (playerNameMatch) {
      const fullMatch = playerNameMatch[0];
      
      // Check if this is actually a player name and not a common phrase/marketing text
      const isNonPlayerText = nonPlayerNamePatterns.some(phrase => 
        fullMatch.includes(phrase) || fullMatch === phrase
      );
      
      if (!isNonPlayerText) {
        const nameParts = fullMatch.split(/\s+/);
        
        if (nameParts.length >= 2) {
          // Convert to proper case (first letter uppercase, rest lowercase)
          result.playerFirstName = nameParts[0].charAt(0) + nameParts[0].slice(1).toLowerCase();
          
          // If there are more than 2 parts, join the rest as last name
          if (nameParts.length > 2) {
            const lastNameParts = nameParts.slice(1);
            result.playerLastName = lastNameParts.map(part => 
              part.charAt(0) + part.slice(1).toLowerCase()
            ).join(' ');
          } else {
            result.playerLastName = nameParts[1].charAt(0) + nameParts[1].slice(1).toLowerCase();
          }
          
          console.log(`Detected player name: ${result.playerFirstName} ${result.playerLastName}`);
        }
      } else {
        console.log(`Skipping invalid player name detection: "${fullMatch}" - matched non-player pattern`);
      }
    }
    
    // Detect player names from specific parts of the card for better accuracy
    // This works well for cards where the player name is clearly displayed
    const playerNameLines = fullText.split('\n')
      .filter(line => /^[A-Z\s]+$/.test(line.trim()))  // Only all-caps lines
      .filter(line => line.length > 5 && line.length < 30)  // Reasonable length for names
      .filter(line => !line.includes('MLB') && !line.includes('TOPPS'));  // Exclude non-name text
      
    if (playerNameLines.length > 0) {
      // Sort by line length ascending (player names are usually shorter)
      playerNameLines.sort((a, b) => a.length - b.length);
      
      // Take the shortest valid name line
      const potentialName = playerNameLines[0].trim();
      const nameParts = potentialName.split(/\s+/);
      
      if (nameParts.length >= 2) {
        // Convert to proper case (first letter uppercase, rest lowercase)
        const firstName = nameParts[0].charAt(0) + nameParts[0].slice(1).toLowerCase();
        
        // If more than 2 parts, join rest as last name
        let lastName;
        if (nameParts.length > 2) {
          lastName = nameParts.slice(1).map(part => 
            part.charAt(0) + part.slice(1).toLowerCase()
          ).join(' ');
        } else {
          lastName = nameParts[1].charAt(0) + nameParts[1].slice(1).toLowerCase();
        }
        
        // Only override existing player name if this one seems valid
        if (firstName.length > 1 && lastName.length > 1) {
          result.playerFirstName = firstName;
          result.playerLastName = lastName;
          console.log(`Detected refined player name: ${firstName} ${lastName}`);
        }
      }
    }
    
    // Dynamic name extraction: the player name lines and generic regex patterns above
    // already handle all card types. No player-specific overrides needed here.
    {
      // Look for adjacent all-caps word pairs in text annotations that could be first+last name.
      // This handles cases where Vision returns first and last name as separate annotation blocks
      // (common with larger fonts that Vision splits at word boundaries).
      const firstNameAnnotation = textAnnotations.find((a: any) => {
        const t = (a.description || '').trim().toUpperCase();
        return /^[A-Z]{2,}$/.test(t) &&
               !nonPlayerNamePatterns.some(p => t === p || t.includes(p));
      });
      const lastNameAnnotation = firstNameAnnotation
        ? textAnnotations.find((a: any, idx: number) => {
            if (a === firstNameAnnotation) return false;
            const t = (a.description || '').trim().toUpperCase();
            return /^[A-Z]{2,}$/.test(t) &&
                   !nonPlayerNamePatterns.some(p => t === p || t.includes(p));
          })
        : null;

      if (firstNameAnnotation && lastNameAnnotation) {
        result.playerFirstName = firstNameAnnotation.description.charAt(0) +
                               firstNameAnnotation.description.slice(1).toLowerCase();
        result.playerLastName  = lastNameAnnotation.description.charAt(0) +
                               lastNameAnnotation.description.slice(1).toLowerCase();
        console.log('Detected player from separate annotation blocks:',
                    result.playerFirstName, result.playerLastName);
      } else {
        // Generic name extraction for other cards
        const nameRegex = /([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))/g;
        const nameMatches = [];
        let match;
        while ((match = nameRegex.exec(fullText)) !== null) {
          nameMatches.push(match);
        }
        if (nameMatches.length > 0) {
          const nameParts = nameMatches[0][0].split(' ');
          if (nameParts.length >= 2) {
            result.playerFirstName = nameParts[0];
            result.playerLastName = nameParts.slice(1).join(' ');
            console.log('Detected player using generic pattern:', result.playerFirstName, result.playerLastName);
          }
        }
      }

    }
    
    // Find brand specifically looking for 'Topps' text at the top right corner (where brand logos often appear)
    const topRightBrand = textAnnotations.find(annotation => {
      const text = annotation.description;
      // The 'Topps' logo is often in the top right, so we look for it there
      const boundingPoly = annotation.boundingPoly;
      if (!boundingPoly || !boundingPoly.vertices) return false;
      
      // Check if this is in top right corner
      const isTopRight = boundingPoly.vertices.every((v: any) => v.x > 900 && v.y < 300);
      
      // Check if this is the Topps text (case insensitive)
      if (!/topps/i.test(text)) return false;
      
      // Log for debugging
      console.log('Found potential brand:', text, 'at position:', JSON.stringify(boundingPoly), 'isTopRight:', isTopRight);
      
      return isTopRight;
    });
    
    // Look specifically for Lapps - a common OCR misread for Topps
    const toppsLappsAnnotation = textAnnotations.find(annotation => {
      const text = annotation.description;
      
      // The Topps logo is typically in the top right corner
      const boundingPoly = annotation.boundingPoly;
      if (!boundingPoly || !boundingPoly.vertices) return false;
      
      // Check if this is in top right corner where Topps logo usually appears
      const isTopRight = boundingPoly.vertices.every((v: any) => v.x > 900 && v.y < 300);
      
      // Check for common misreads
      if (!/lapps|lopps|tapps/i.test(text)) return false;
      
      // Log for debugging
      console.log('Found potential Topps (misread as:', text, ') at position:', JSON.stringify(boundingPoly), 'isTopRight:', isTopRight);
      
      return isTopRight;
    });
    
    if (topRightBrand) {
      result.brand = 'Topps';
      console.log('Identified brand from position in card:', result.brand);
    } else if (lowerText.includes('topps')) {
      result.brand = 'Topps';
      console.log('Identified brand from text: Topps');
    } else if (toppsLappsAnnotation || 
              fullText.includes('LOPPS') || 
              fullText.includes('TAPPS') || 
              fullText.includes('Lapps')) {
      // OCR often misreads the Topps logo as "LOPPS", "TAPPS", or "Lapps"
      result.brand = 'Topps';
      console.log('Identified Topps brand from misread text');
    } else if (lowerText.includes('upper deck')) {
      result.brand = 'Upper Deck';
    } else if (lowerText.includes('panini')) {
      result.brand = 'Panini';
    } else if (lowerText.includes('fleer')) {
      result.brand = 'Fleer';
    } else if (lowerText.includes('donruss')) {
      result.brand = 'Donruss';
    } else if (lowerText.includes('bowman')) {
      result.brand = 'Bowman';
    }
    
    // Special brand detection for the 35th Anniversary series
    // These are always Topps cards
    if (!result.brand && result.collection === '35th Anniversary') {
      result.brand = 'Topps';
      console.log('Identified Topps brand from 35th Anniversary collection');
    }
    
    // If we detect a card number like "89B-9" or similar format, it's very likely a Topps card
    if (!result.brand && result.cardNumber && /\d{1,2}[A-Za-z]\d?[-]\d{1,2}/.test(result.cardNumber)) {
      result.brand = 'Topps';
      console.log('Identified Topps brand from card number format:', result.cardNumber);
    }
    
    
    // Print all text annotations for debugging
    console.log('All detected text fragments:');
    textAnnotations.forEach(annotation => {
      console.log(`Text: "${annotation.description}" at position:`, JSON.stringify(annotation.boundingPoly));
    });
    
    // Handle 35th Anniversary cards collection recognition
    if ((fullText.includes('35') || fullText.includes('ANNIV') || fullText.includes('ERSARY'))) {
      result.collection = '35th Anniversary';
      result.year = 2024;
      result.brand = 'Topps';
      console.log('Detected a 35th Anniversary card, setting collection and year');
    }
    
    // Generic card number detection from text annotations in the top portion of the card
    const cardNumberPatterns = [
      /^\d{1,2}[A-Za-z]\d?[-]?\d{1,2}$/,       // 89B-9, 89B2-32 (letter-number hybrids)
      /^[A-Za-z]{2,5}[-]?\d{1,3}$/,             // HOU-11, SMLB-27 (prefix + digits)
      /^#?\d{1,3}[A-Za-z]?$/,                   // #123, 123A, 99
      /^[A-Za-z][-]?\d{1,3}$/,                  // T-206, B-12
      /^(?:card|no)[.\s#]?\d{1,3}[A-Za-z]?$/i,  // "Card 123", "No.99"
    ];

    const topCardNumberCandidates = textAnnotations.filter(annotation => {
      const text = annotation.description;
      const boundingPoly = annotation.boundingPoly;
      if (!boundingPoly || !boundingPoly.vertices) return false;

      const isTopPortion = boundingPoly.vertices.every((v: any) => v.y < 800);

      const isCardNumber = cardNumberPatterns.some(p => p.test(text)) ||
                           /^(?:\d{1,3})$/.test(text) ||
                           /^(?:[A-Z][0-9]{1,3})$/.test(text) ||
                           /^(?:\d{1,3}[A-Z])$/.test(text) ||
                           text.includes('-');

      if (isTopPortion && isCardNumber) {
        const xCoords = boundingPoly.vertices.map((v: any) => v.x);
        const avgX = xCoords.reduce((a: number, b: number) => a + b, 0) / xCoords.length;
        const position = avgX < 400 ? "top-left" : avgX < 800 ? "top-middle" : "top-right";
        console.log(`Found potential card number: "${text}" at ${position}`);
        return true;
      }
      return false;
    });

    topCardNumberCandidates.sort((a, b) => {
      const aY = a.boundingPoly.vertices[0].y;
      const bY = b.boundingPoly.vertices[0].y;
      if (aY !== bY) return aY - bY;
      return a.boundingPoly.vertices[0].x - b.boundingPoly.vertices[0].x;
    });

    const topLeftCandidates = topCardNumberCandidates.filter(c => {
      const avgX = c.boundingPoly.vertices.map((v: any) => v.x).reduce((a: number, b: number) => a + b, 0) / c.boundingPoly.vertices.length;
      return avgX < 400;
    });
    const topMiddleCandidates = topCardNumberCandidates.filter(c => {
      const avgX = c.boundingPoly.vertices.map((v: any) => v.x).reduce((a: number, b: number) => a + b, 0) / c.boundingPoly.vertices.length;
      return avgX >= 400 && avgX < 800;
    });

    const anySpecialFormat = topCardNumberCandidates.find(c => {
      const text = c.description;
      return /^(?:\d{1,2}[A-Za-z]\d?[-]?\d{1,2})$/i.test(text) ||
             /^(?:[A-Z]{2,}[-][0-9]{1,3})$/i.test(text);
    });

    const bestCandidates = [
      anySpecialFormat,
      ...topLeftCandidates.filter(c => /^(?:\d{1,2}[A-Za-z]\d?[-]?\d{1,2})$/i.test(c.description)),
      ...topMiddleCandidates.filter(c => /^(?:[A-Z]{2,}[-][0-9]{1,3})$/i.test(c.description)),
      ...topLeftCandidates.filter(c => /^(?:[A-Z]{3}[-]?[0-9]{1,2})$/i.test(c.description)),
      topLeftCandidates[0],
      topMiddleCandidates[0],
      topCardNumberCandidates[0]
    ].filter(Boolean);

    const bestCardNumber = bestCandidates.length > 0 ? bestCandidates[0] : null;

    const is35thAnniversaryCard = fullText.includes('35') && fullText.includes('ANNIVERSARY');
    
    // If we detect a card with the 89B pattern, it's very likely from the 35th Anniversary collection
    if (is35thAnniversaryCard || (bestCardNumber && bestCardNumber.description.includes('89B'))) {
      console.log('*** DETECTED 35th ANNIVERSARY CARD PATTERN ***');
      // Set collection-specific values but keep the dynamic card number
      if (!result.brand) result.brand = 'Topps';
      if (!result.collection) result.collection = '35th Anniversary';
      if (!result.year) result.year = 2024;
      
      // Only set a default condition if none detected
      if (!result.condition) result.condition = 'PSA 8';
      
      // For 35th Anniversary cards, if we have a card number, use it
      if (bestCardNumber) {
        result.cardNumber = bestCardNumber.description;
        console.log('Selected card number for 35th Anniversary card:', result.cardNumber);
      }
      
      console.log('Applied 35th Anniversary card context:', {
        cardNumber: result.cardNumber,
        brand: result.brand,
        collection: result.collection,
        year: result.year
      });
    } 
    // For other cards, use our improved selection logic
    else if (bestCardNumber) {
      result.cardNumber = bestCardNumber.description;
      
      // Calculate position description for logging
      const xCoords = bestCardNumber.boundingPoly.vertices.map((v: any) => v.x);
      const avgX = xCoords.reduce((a, b) => a + b, 0) / xCoords.length;
      let position = "unknown";
      if (avgX < 400) position = "top-left";
      else if (avgX < 800) position = "top-middle";
      else position = "top-right";
      
      console.log(`Selected card number "${result.cardNumber}" from ${position} position`);
    } else {
      // Fallback: Check for specific patterns in the full text
      // This catches cases where the OCR didn't identify the text as a separate element
      
      // Look for patterns like 89B-9, 89B2-32, or HOU-11 in the full text
      const specificPatterns = [
        /\b[A-Z]{2,5}[-]?\d{1,3}\b/i,             // Alphanumeric prefixed (SMLB-27, HOU-11, etc.)
        /\b\d{1,2}[A-Za-z]\d?[-]\d{1,2}\b/,       // Digit-letter-digit hybrids (89B-9, 89B2-32)
        /\b[A-Z]{3}[-]\d{1,2}\b/,                  // Team codes (HOU-11, NYY-8)
        /\b\d{1,2}[A-Za-z][-]?\d{1,2}\b/,          // Digit-letter combos (89B9, 89B-9)
      ];
      
      let cardNumberMatch = null;
      for (const pattern of specificPatterns) {
        const match = fullText.match(pattern);
        if (match) {
          cardNumberMatch = match;
          break;
        }
      }
      
      if (cardNumberMatch) {
        result.cardNumber = cardNumberMatch[0];
        console.log('Identified card number from specific text pattern:', result.cardNumber);
      } else {
        // Very general card number regex as final fallback
        const cardNumberRegex = /#\s*(\d+)|no\.\s*(\d+)|card\s*(\d+)|\b\d{1,3}[A-Za-z]?[-]?\d{1,2}\b/i;
        const generalMatch = fullText.match(cardNumberRegex);
        if (generalMatch) {
          result.cardNumber = generalMatch[0];
          console.log('Identified card number from general regex pattern:', result.cardNumber);
        }
      }
    }
    
    // Extract collections
    const collections = [
      'Chrome', 'Prizm', 'Heritage', 'Optic', 'Finest', 
      'Select', 'Dynasty', 'Contenders', 'Clearly Authentic', 
      'Allen & Ginter', 'Tribute', 'Inception', 'Archives',
      '35th Anniversary', 'Series One', 'Series Two', 'Series 1', 'Series 2'
    ];
    
    // "Wild Card" can be OCR misreading, but we'll let the dynamic OCR handle it
    // We'll rely on the generic pattern detection for all players
    // Note: No more special handling for specific players
    
    // No player-specific hardcoded detection - fully dynamic OCR
    
    // Generic pattern-based detection for all players
    // Note: All cards will be detected using the same pattern-recognition algorithms without player-specific logic
    
    for (const collection of collections) {
      if (fullText.includes(collection)) {
        result.collection = collection;
        break;
      }
    }
    
    // For 35th Anniversary
    if (fullText.includes('35') && (fullText.includes('ANNIVERSARY') || fullText.includes('RSARY'))) {
      result.collection = '35th Anniversary';
    }
    
    // Improved approach to year detection by looking for the year near the ® symbol at the bottom of the card
    
    // First identify all text annotations that are likely at the bottom portion of the card
    // Most copyright/trademark information is in the bottom 25% of the card
    const bottomAnnotations = textAnnotations.filter(annotation => {
      const boundingPoly = annotation.boundingPoly;
      if (!boundingPoly || !boundingPoly.vertices) return false;
      
      // Get the vertical position (y-coordinate) to identify bottom section
      const yCoords = boundingPoly.vertices.map((v: any) => v.y);
      const avgY = yCoords.reduce((a: number, b: number) => a + b, 0) / yCoords.length;
      
      // Most cards have height around 1500-2000 pixels, so the bottom 25% would start at around 1200-1500
      // We'll use a generous threshold to catch more potential text
      const isBottomSection = avgY > 1200;
      
      return isBottomSection;
    });
    
    console.log(`Found ${bottomAnnotations.length} text annotations in the bottom section of the card`);
    
    // Look for the trademark/copyright symbols (®, ©, ™) and extract nearby years
    const trademarkYearCandidates: {year: number, confidence: number, source: string}[] = [];
    
    // Check each annotation in the bottom section for trademark/copyright symbols and nearby years
    bottomAnnotations.forEach(annotation => {
      const text = annotation.description;
      
      // Log for debugging
      console.log(`Bottom text: "${text}" at position:`, JSON.stringify(annotation.boundingPoly));
      
      // Look for years with nearby trademark symbols
      const hasTrademarkSymbol = text.includes('®') || 
                                text.includes('©') || 
                                text.includes('™') ||
                                text.includes('(R)') ||
                                text.includes('(TM)') ||
                                text.includes('(C)');
                                
      // Different patterns for years
      const yearPatterns = [
        { regex: /\b(20\d{2})\b/, confidence: 0.9, type: '20XX' },     // 2023, 2024
        { regex: /\b(19\d{2})\b/, confidence: 0.9, type: '19XX' },     // 1993, 1994
        { regex: /[''](\d{2})/, confidence: 0.7, type: "'YY" },        // '23, '24
        { regex: /\b\d{4}\b/, confidence: 0.6, type: 'XXXX' }          // Any 4 digits as fallback
      ];
      
      // If we have a trademark symbol, look for years
      if (hasTrademarkSymbol) {
        for (const pattern of yearPatterns) {
          const yearMatch = text.match(pattern.regex);
          if (yearMatch) {
            let year = parseInt(yearMatch[1]);
            
            // Handle 2-digit years
            if (year < 100) {
              // Assume 00-25 is 2000-2025, and everything else is 1900s
              year = year <= 25 ? 2000 + year : 1900 + year;
            }
            
            // Only accept reasonable years (1900-2025)
            if (year >= 1900 && year <= 2025) {
              trademarkYearCandidates.push({
                year,
                confidence: pattern.confidence,
                source: `${text} (${pattern.type})`
              });
              
              console.log(`Found potential card year: ${year} from text "${text}" with pattern ${pattern.type}`);
              break;  // Once we find a match in this annotation, move to next
            }
          }
        }
      }
    });
    
    // Also check for specific copyright year pattern
    const copyrightYear = bottomAnnotations.find(annotation => {
      const text = annotation.description.toLowerCase();
      return (text.includes('©') || text.includes('copyright')) && /\b20\d{2}\b/.test(text);
    });
    
    if (copyrightYear) {
      const yearMatch = copyrightYear.description.match(/\b(20\d{2})\b/);
      if (yearMatch) {
        const year = parseInt(yearMatch[1]);
        trademarkYearCandidates.push({
          year,
          confidence: 0.95,  // High confidence for explicit copyright
          source: `Copyright text: ${copyrightYear.description}`
        });
        console.log(`Found year ${year} from copyright text: ${copyrightYear.description}`);
      }
    }
    
    // Sort candidates by confidence (highest first)
    trademarkYearCandidates.sort((a, b) => b.confidence - a.confidence);
    
    // Use the highest confidence year if available
    if (trademarkYearCandidates.length > 0) {
      const bestYearCandidate = trademarkYearCandidates[0];
      result.year = bestYearCandidate.year;
      console.log(`Selected card year: ${result.year} from "${bestYearCandidate.source}" with confidence ${bestYearCandidate.confidence}`);
    } 
    // Fallback to general detection if no trademark years found
    else {
      // Extract any year (looking for 4-digit years from 1900-2025)
      const yearRegex = /\b(19\d{2}|20[0-2]\d)\b/;
      const yearMatch = fullText.match(yearRegex);
      if (yearMatch) {
        result.year = parseInt(yearMatch[1]);
        console.log('Identified year from general text:', result.year);
      } else if (fullText.includes('© 2024') || fullText.includes('©2024')) {
        result.year = 2024;
        console.log('Defaulting to 2024 based on copyright text');
      }
    }
    
    // Context-based year correction
    // For 35th Anniversary and recent collections
    if (is35thAnniversaryCard || 
        result.collection === '35th Anniversary' || 
        (result.cardNumber && result.cardNumber.includes('89B'))) {
      // Override any detected year for 35th Anniversary cards
      result.year = 2024;
      console.log('Overriding year to 2024 for 35th Anniversary collection');
    }
    else if ((result.collection === 'Series One' || result.collection === 'Series Two') && 
             (!result.year || result.year < 2020)) {
      // Recent Series One/Two cards are from 2024
      result.year = 2024;
      console.log('Overriding year to 2024 for recent Series One/Two collection');
    }
    
    // Enhanced serial number detection using dedicated detector
    const { detectSerialNumber } = await import('./serialNumberDetector');
    const serialResult = detectSerialNumber(fullText, textAnnotations);
    
    result.serialNumber = serialResult.serialNumber;
    result.isNumbered = serialResult.isNumbered;
    
    if (serialResult.isNumbered) {
      console.log(`Serial number detected via ${serialResult.detectionMethod}: ${serialResult.serialNumber}`);
    } else {
      console.log('No serial number detected in this image');
    }
    
    // Check for Rookie Card indicators - Enhanced dynamic detection algorithm
    
    // 1. Check for RC logo using our dedicated function
    const hasRCLogo = isRCLogoPresent(textAnnotations);
    
    // 2. Check for RC or ROOKIE text patterns in the text
    const hasRCText = fullText.includes('RC') || 
                      fullText.includes('ROOKIE') || 
                      lowerText.includes('rookie card') || 
                      lowerText.includes('rookie') ||
                      lowerText.includes('1st') ||
                      lowerText.includes('first year') ||
                      /(?:^|\s)rc(?:\s|$)/i.test(lowerText);
    
    // 3. Check for "base set" rookie cards from recent years (2022-2024)
    // Many modern rookie cards from these years don't explicitly say "rookie"
    // but are recognized as rookie cards in the hobby
    const currentYear = new Date().getFullYear();
    const isRecentRookie = 
      (result.year >= currentYear - 3 && result.year <= currentYear) && 
      ((result.collection || '').toLowerCase().includes('35th anniversary') ||
       (result.collection || '').toLowerCase().includes('prospects') ||
       (result.collection || '').toLowerCase().includes('draft'));
       
    // 4. Text content analysis for rookie indicators
    // Look for text that suggests this is a player's first year or rookie season
    // Many card descriptions mention MLB debuts, rookie seasons, or prospect status
    const lowerFullText = fullText.toLowerCase();
    const hasRookieDescriptionText = 
      lowerFullText.includes('debut') ||
      lowerFullText.includes('first season') || 
      lowerFullText.includes('broke into') ||
      lowerFullText.includes('prospect') ||
      lowerFullText.includes('entrance into') ||
      lowerFullText.includes('made his first') ||
      lowerFullText.includes('entered the league') ||
      lowerFullText.includes('top prospects') ||
      lowerFullText.includes('first professional');
    
    if (hasRookieDescriptionText) {
      console.log('Text analysis suggests this is a rookie card based on career description');
    }
      
    // Look for rookie indicators in the card text that suggest a player is new
    // Many cards describe rookie achievements or mention MLB debuts
    const rookieTextIndicators = [
      'rookie season', 'rookie year', 'first season', 'prospect',
      'made quite an entrance', 'broke into', 'first appearance',
      'first professional', 'draft pick', 'first big league',
      'mlb debut', 'nba debut', 'nfl debut', 'nhl debut'
    ];
    
    // Check if text contains any rookie indicators
    const hasRookieIndicatorText = rookieTextIndicators.some(indicator => 
      lowerText.includes(indicator)
    );
    
    if (hasRookieIndicatorText) {
      console.log('Found text suggesting this is a rookie player:', 
        rookieTextIndicators.filter(i => lowerText.includes(i)).join(', '));
      result.isRookieCard = true;
    }
    
    // Check all detection methods (purely dynamic — no hardcoded player lists)
    if (hasRCLogo || hasRCText || isRecentRookie || hasRookieDescriptionText || hasRookieIndicatorText) {
      result.isRookieCard = true;
      
      if (hasRCLogo) {
        console.log('Detected rookie card indicator: RC logo found in image');
      } else if (hasRCText) {
        console.log('Detected rookie card indicator: RC/ROOKIE text found');
      } else if (isRecentRookie) {
        console.log('Detected potential rookie card based on year and collection');
      } else if (hasRookieDescriptionText) {
        console.log('Detected rookie card from card description text analysis');
      } else if (hasRookieIndicatorText) {
        console.log('Detected rookie card from specific rookie text indicators');
      }
      
      // Also set the variant if it's a special rookie variant
      if (!result.variant) {
        result.variant = 'Rookie';
      }
    }
    
    // Check for variant keywords in text dynamically
    const variantKeywords: Record<string, string> = {
      'aqua foil': 'Aqua Foil', 'blue foil': 'Blue Foil', 'green foil': 'Green Foil',
      'gold foil': 'Gold Foil', 'red foil': 'Red Foil', 'silver foil': 'Silver Foil',
      'purple foil': 'Purple Foil', 'orange foil': 'Orange Foil', 'pink foil': 'Pink Foil',
      'refractor': 'Refractor', 'xfractor': 'Xfractor', 'prizm': 'Prizm',
    };
    for (const [keyword, variantName] of Object.entries(variantKeywords)) {
      if (lowerText.includes(keyword)) {
        result.variant = variantName;
        console.log(`Detected variant "${variantName}" from keyword "${keyword}" in text`);
        break;
      }
    }
    
    // Detect special collections
    if (lowerText.includes('heritage') || fullText.includes('HERITAGE')) {
      result.collection = 'Heritage';
      console.log('Detected Topps Heritage collection');
      
      // Heritage cards usually have the copyright year on the back that indicates
      // the actual card year, like "© 2021 THE TOPPS COMPANY"
      const yearMatch = fullText.match(/©\s*(\d{4})\s*(?:THE\s*)?TOPPS/i) || 
                        fullText.match(/\bTM\s+&\s+©\s+(\d{4})\s+THE\s+TOPPS/i);
      if (yearMatch && yearMatch[1]) {
        result.year = parseInt(yearMatch[1], 10);
        console.log('Extracted year from copyright text for Heritage card:', result.year);
      }
      
      // Heritage cards normally have the brand as Topps
      if (!result.brand) {
        result.brand = 'Topps';
      }
    }
    
    // Check for special cards based on visual features that won't be in OCR text
    // For instance, aqua foil cards have a distinctive shimmer that OCR won't detect in text
    // Let's try to detect some Sean Manaea-specific cards (and others we recognize)
    // Enhanced player name detection for common patterns
    // This helps when OCR picks up partial names or in different formats
    for (const annotation of textAnnotations) {
      const text = annotation.description;
      
      // Player name pattern matching
      if (/^([A-Z]+)\s+([A-Z]+)$/.test(text) && text.length > 7) {
        const [_, firstName, lastName] = text.match(/^([A-Z]+)\s+([A-Z]+)$/) || [];
        if (firstName && lastName) {
          // Convert to proper case (first letter capital, rest lowercase)
          result.playerFirstName = firstName.charAt(0) + firstName.slice(1).toLowerCase();
          result.playerLastName = lastName.charAt(0) + lastName.slice(1).toLowerCase();
          console.log('Identified player name from pattern:', result.playerFirstName, result.playerLastName);
          break;
        }
      }
    }
    
    // Try to detect card type from visual cues and text
    // Check if it might be a Series card (with more flexible pattern matching)
    const seriesTwoPatterns = [
      /SERIES\s*TWO/i, 
      /SERIES\s*2/i, 
      /S.?RIES\s*T.?O/i, // For partial OCR readings
      /S.?RIES\s*2/i
    ];
    
    const seriesOnePatterns = [
      /SERIES\s*ONE/i, 
      /SERIES\s*1/i, 
      /S.?RIES\s*O.?E/i,
      /S.?RIES\s*1/i
    ];
    
    // Check for Series Two using flexible patterns
    const isSeriesTwo = seriesTwoPatterns.some(pattern => pattern.test(fullText));
    if (isSeriesTwo) {
      result.collection = 'Series Two';
      console.log('Identified Series Two collection');
      
      if (!result.year) {
        result.year = new Date().getFullYear();
        console.log(`Setting year to ${result.year} for Series Two card`);
      }
    } 
    // If not Series Two, check for Series One
    else {
      const isSeriesOne = seriesOnePatterns.some(pattern => pattern.test(fullText));
      if (isSeriesOne) {
        result.collection = 'Series One';
        console.log('Identified Series One collection');
        
        if (!result.year) {
          result.year = new Date().getFullYear();
          console.log(`Setting year to ${result.year} for Series One card`);
        }
      }
    }
    
    // Look for numbers in top left (common card number position on base cards like Topps Series)
    // Only applied when a specific card number has not already been found via pattern matching above.
    if (!result.cardNumber) {
      let topLeftNumbers = textAnnotations.filter(annotation => {
        const text = annotation.description;
        if (!/^\d{1,3}$/.test(text)) return false;
        const boundingPoly = annotation.boundingPoly;
        if (!boundingPoly || !boundingPoly.vertices) return false;
        return boundingPoly.vertices.every((v: any) => v.x < 200 && v.y < 200);
      });

      if (topLeftNumbers.length === 0) {
        topLeftNumbers = textAnnotations.filter(annotation => {
          const text = annotation.description;
          if (!/^\d{1,3}$/.test(text)) return false;
          const boundingPoly = annotation.boundingPoly;
          if (!boundingPoly || !boundingPoly.vertices) return false;
          return boundingPoly.vertices.every((v: any) => v.y < 300);
        });
      }

      if (topLeftNumbers.length === 0) {
        topLeftNumbers = textAnnotations.filter(annotation =>
          /^\d{1,3}$/.test(annotation.description)
        );
      }

      if (topLeftNumbers.length === 0) {
        const cardNumberPattern = /CARD\s*#?\s*(\d{1,3})|#\s*(\d{1,3})/i;
        const cardNumberText = textAnnotations.find(a => cardNumberPattern.test(a.description));
        if (cardNumberText) {
          const matches = cardNumberText.description.match(cardNumberPattern);
          const cardNumber = matches?.[1] || matches?.[2];
          if (cardNumber) {
            result.cardNumber = cardNumber;
            console.log('Identified card number from text pattern:', result.cardNumber);
          }
        }
      }

      if (topLeftNumbers.length > 0) {
        result.cardNumber = topLeftNumbers[0].description;
        console.log('Identified card number from top left position:', result.cardNumber);
      }
    }
    
    // This secondary serial number check is now redundant with our improved detection above
    // Perform an additional check only if we haven't already identified a serial number
    if (!result.serialNumber) {
      // Serial numbers typically appear in formats like 123/499 or 010/399
      const serialAnnotations = textAnnotations.filter(annotation => {
        const text = annotation.description;
        if (!/^\d{1,3}\/\d{1,4}$/.test(text)) return false;
        
        const boundingPoly = annotation.boundingPoly;
        if (!boundingPoly || !boundingPoly.vertices) return false;
        
        // Check if it's in the bottom right quadrant
        const bottomRightQuadrant = boundingPoly.vertices.every((v: any) => 
          v.y > 1400 && v.x > 800);
          
        // Check if it's isolated from other text (imprinted in foil, different color than main text)
        // by measuring distances to other text annotations
        return bottomRightQuadrant;
      });
      
      // Only set a serial number if found in the correct position
      if (serialAnnotations.length > 0) {
        // Verify this is actually at the bottom right and isolated
        const annotation = serialAnnotations[0];
        const boundingPoly = annotation.boundingPoly;
        
        // Check if this is isolated from other text blocks
        const isIsolated = textAnnotations.filter(other => {
          if (other === annotation) return false;
          
          const otherPoly = other.boundingPoly;
          if (!otherPoly || !otherPoly.vertices) return false;
          
          // Calculate distance between centers
          const thisCenter = {
            x: boundingPoly.vertices.reduce((sum: number, v: any) => sum + v.x, 0) / 4,
            y: boundingPoly.vertices.reduce((sum: number, v: any) => sum + v.y, 0) / 4
          };
          
          const otherCenter = {
            x: otherPoly.vertices.reduce((sum: number, v: any) => sum + v.x, 0) / 4,
            y: otherPoly.vertices.reduce((sum: number, v: any) => sum + v.y, 0) / 4
          };
          
          const distance = Math.sqrt(
            Math.pow(thisCenter.x - otherCenter.x, 2) + 
            Math.pow(thisCenter.y - otherCenter.y, 2)
          );
          
          return distance < 70;
        }).length < 3; // Less than 3 nearby annotations
        
        if (isIsolated) {
          result.serialNumber = annotation.description;
          result.isNumbered = true;
          result.variant = 'Numbered';
          console.log('Identified isolated special variant card with serial number:', result.serialNumber);
        }
      }
    }
    
    // Set isNumbered flag when serial number is detected
    if (!result.isNumbered && result.serialNumber && result.serialNumber.includes('/')) {
      result.isNumbered = true;
      console.log('Set isNumbered=true based on serial number:', result.serialNumber);
    }
    
    // Set a default condition
    result.condition = 'PSA 8';
    
    // No player-specific checks - fully dynamic OCR
    
    // Clear incorrect player name detections
    if (result.playerFirstName === 'Major' && result.playerLastName === 'League') {
      result.playerFirstName = '';
      result.playerLastName = '';
      console.log('CRITICAL FIX: Cleared incorrect player name (Major League)');
    }
    
    // Ensure we have a year
    if (!result.year) {
      result.year = new Date().getFullYear();
    }
    
    // For 35th Anniversary Topps cards, the year is always 2024
    // If we detect "35" and "Anniversary" OR "35th" markings, we can be confident
    if ((fullText.includes('35') && 
        (fullText.includes('ANNIVERSARY') || fullText.includes('RSARY') || 
         fullText.includes('ANNIV'))) || fullText.includes('35th')) {
      
      // Set default brand for these cards
      if (!result.brand) result.brand = 'Topps';
      
      // Set collection name
      result.collection = '35th Anniversary';
      
      // Even if we detect "1989" in the card, these are 2024 cards 
      // (the 1989 is part of the 35th Anniversary "1989-2024" logo)
      result.year = 2024;
      
      // The "1989" in the 35th Anniversary logo is commonly misread as the card number.
      // Clear it so the card number pattern matchers (which look for "89B-9" format) can
      // find the real card number, and the DB lookup can match correctly.
      if (result.cardNumber === '1989' || result.cardNumber === '192') {
        console.log(`Clearing misread card number "${result.cardNumber}" — likely the "1989" from 35th Anniversary logo`);
        result.cardNumber = '';
      }
    }
    
    console.log('Extracted card info:', result);
    
    // Log how long the analysis took
    console.timeEnd('ocr-analysis-timer');
    
    return result;
  } catch (error: any) {
    console.error('Error analyzing sports card:', error);
    console.timeEnd('ocr-analysis-timer');
    
    // Return default values instead of failing completely
    return {
      condition: 'PSA 8',
      sport: '',
      brand: '',
      year: new Date().getFullYear(),
      // If we can extract anything from the failed analysis, include it
      ...error.partialResults
    };
  }
}