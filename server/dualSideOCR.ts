import { Request, Response } from 'express';
import { CardFormValues } from '@shared/schema';
import { analyzeSportsCardImage } from './dynamicCardAnalyzer';
import { analyzeScoreCard } from './scoreCardAnalyzer';
import { detectFoilVariant } from './foilVariantDetector';

// Define a standalone MulterFile interface that doesn't conflict with built-in types
interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  destination?: string;
  filename?: string;
  path?: string;
  buffer: Buffer;
}

// Create a type rather than an interface to avoid conflicts with Express's Request type
type MulterRequest = Request & {
  file?: MulterFile;
  files?: { [fieldname: string]: MulterFile[] };
}

/**
 * Handle OCR analysis for both front and back card images
 * This handler combines data from both sides for more accurate results
 */
export async function handleDualSideCardAnalysis(req: MulterRequest, res: Response) {
  console.log('=== DUAL SIDE OCR HANDLER CALLED ===');
  console.time('dual-card-analysis-total');
  try {
    // Check if we have at least one image
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ 
        success: false,
        message: 'No images provided',
        error: 'missing_files'
      });
    }

    // Get front and back images if available
    const frontImage = req.files['frontImage']?.[0];
    const backImage = req.files['backImage']?.[0];

    if (!frontImage && !backImage) {
      return res.status(400).json({
        success: false,
        message: 'No front or back image provided',
        error: 'missing_required_images'
      });
    }

    // Check image file sizes (max 20MB each)
    if ((frontImage && frontImage.size > 20 * 1024 * 1024) || 
        (backImage && backImage.size > 20 * 1024 * 1024)) {
      return res.status(400).json({
        success: false,
        message: 'Image file is too large. Maximum size is 20MB per image.',
        error: 'file_too_large'
      });
    }

    // Check file types
    if ((frontImage && !frontImage.mimetype.startsWith('image/')) || 
        (backImage && !backImage.mimetype.startsWith('image/'))) {
      return res.status(400).json({
        success: false,
        message: 'Uploaded file is not an image.',
        error: 'invalid_file_type'
      });
    }

    console.log(
      'Received image files:',
      frontImage ? `Front: ${frontImage.originalname} (${frontImage.size} bytes)` : 'No front image',
      backImage ? `Back: ${backImage.originalname} (${backImage.size} bytes)` : 'No back image'
    );

    // Create a timeout promise that rejects after 30 seconds
    const createTimeout = () => new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Image analysis timed out after 30 seconds')), 30000);
    });

    // Initialize result objects
    let frontResult: Partial<CardFormValues> = {};
    let backResult: Partial<CardFormValues> = {};

    // Store raw OCR text for foil detection
    let frontOCRText = '';
    let backOCRText = '';

    // Analyze front image if provided
    if (frontImage) {
      try {
        const frontBase64 = frontImage.buffer.toString('base64');
        
        // Get raw OCR text for foil detection
        frontOCRText = await extractTextForBrandDetection(frontBase64);
        
        // Use dynamic analyzer that can handle all card types
        console.log(`Front text detection: ${frontOCRText.substring(0, 200)}`);
        console.log('Using dynamic analyzer for front image');
        frontResult = await Promise.race([analyzeSportsCardImage(frontBase64), createTimeout()]);
        console.log('Front image analysis returned:', frontResult);
        console.log('Front image analysis complete');
      } catch (error) {
        console.error('Error analyzing front image:', error);
        console.error('Front image analysis error details:', error.message);
      }
    }

    // Analyze back image if provided
    if (backImage) {
      try {
        const backBase64 = backImage.buffer.toString('base64');
        
        // Get raw OCR text for foil detection
        backOCRText = await extractTextForBrandDetection(backBase64);
        
        // Use dynamic analyzer that can handle all card types
        console.log(`Back text detection: ${backOCRText.substring(0, 200)}`);
        console.log('Using dynamic analyzer for back image');
        backResult = await Promise.race([analyzeSportsCardImage(backBase64), createTimeout()]);
        console.log('Back image analysis returned:', backResult);
        console.log('Back image analysis complete');
      } catch (error) {
        console.error('Error analyzing back image:', error);
        console.error('Back image analysis error details:', error.message);
      }
    }

    // Combine the results with priority to front image for player name, number, and rookie status
    // and priority to back image for copyright year, stats, and detailed information
    let combinedResult;
    
    console.log('=== BEFORE COMBINE FUNCTION ===');
    console.log('frontResult exists:', !!frontResult);
    console.log('backResult exists:', !!backResult);
    console.log('frontOCRText length:', frontOCRText?.length || 0);
    console.log('backOCRText length:', backOCRText?.length || 0);
    
    try {
      console.log('About to call combineCardResults...');
      console.log('Front result before combine:', JSON.stringify(frontResult, null, 2));
      console.log('Back result before combine:', JSON.stringify(backResult, null, 2));
      combinedResult = await combineCardResults(frontResult, backResult, frontOCRText, backOCRText, frontImage?.buffer, backImage?.buffer);
      console.log('combineCardResults completed. Result:', JSON.stringify(combinedResult, null, 2));
    } catch (error) {
      console.error('Error in combineCardResults:', error);
      console.error('Error details:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Error combining card analysis results'
      });
    }
    
    // Make sure we have all required fields with defaults if needed
    const finalResult = ensureRequiredFields(combinedResult);
    
    console.log('Combined card analysis result:', JSON.stringify(finalResult, null, 2));
    console.timeEnd('dual-card-analysis-total');
    
    return res.json({
      success: true,
      data: finalResult
    });
    
  } catch (error: any) {
    console.error('Error in dual side card analysis:', error);
    console.timeEnd('dual-card-analysis-total');
    
    return res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred during image analysis',
      error: 'analysis_failed',
      data: {
        condition: 'PSA 8',
        sport: 'Not detected',
        brand: 'Unknown',
        year: new Date().getFullYear(),
        errorMessage: 'Failed to analyze the card images'
      }
    });
  }
}

/**
 * Quick extraction of text just to detect the card brand
 */
async function extractTextForBrandDetection(base64Image: string): Promise<string> {
  try {
    // Import dynamically to avoid circular dependencies
    const { extractTextFromImage } = await import('./googleVisionFetch');
    const result = await extractTextFromImage(base64Image);
    return result.fullText || '';
  } catch (error) {
    console.error('Error extracting text for brand detection:', error);
    return '';
  }
}

/**
 * Combine results from front and back card analysis
 */
async function combineCardResults(
  frontResult: Partial<CardFormValues>, 
  backResult: Partial<CardFormValues>,
  frontOCRText: string = '',
  backOCRText: string = '',
  frontImageBuffer?: Buffer,
  backImageBuffer?: Buffer
): Promise<Partial<CardFormValues>> {
  console.log('=== COMBINE CARD RESULTS STARTED ===');
  console.log('COMBINE FUNCTION IS DEFINITELY BEING CALLED!');
  console.log('Front result foilType:', frontResult.foilType);
  console.log('Back result foilType:', backResult.foilType);
  console.log('Front result keys:', Object.keys(frontResult));
  console.log('Back result keys:', Object.keys(backResult));
  console.log('Front OCR text length:', frontOCRText.length);
  console.log('Back OCR text length:', backOCRText.length);
  console.log('=== COMBINING CARD RESULTS ===');
  console.log('Front result sport:', frontResult.sport);
  console.log('Back result sport:', backResult.sport);
  
  // Start with an empty object
  const combined: Partial<CardFormValues> = {};
  
  // Fields where front image has priority
  const frontPriorityFields: (keyof CardFormValues)[] = [
    'playerFirstName', 'playerLastName',
    'isRookieCard', 'brand', 'collection', 'variant'
  ];
  
  // Fields where back image has priority (card numbers are most reliably found on the back)
  const backPriorityFields: (keyof CardFormValues)[] = [
    'cardNumber', 'year', 'sport', 'serialNumber'
  ];
  
  // Helper: check if a field value is meaningfully set (not empty, null, undefined, or 0 for numeric fields)
  const hasValue = (val: any): boolean => {
    if (val === undefined || val === null || val === '') return false;
    if (typeof val === 'number' && val === 0) return false;
    return true;
  };

  // Copy front priority fields first
  frontPriorityFields.forEach(field => {
    if (hasValue(frontResult[field])) {
      combined[field] = frontResult[field];
    } else if (hasValue(backResult[field])) {
      combined[field] = backResult[field];
    }
  });
  
  // Then copy back priority fields
  backPriorityFields.forEach(field => {
    if (hasValue(backResult[field])) {
      combined[field] = backResult[field];
    } else if (hasValue(frontResult[field])) {
      combined[field] = frontResult[field];
    }
  });
  
  // When collection came only from the back (front had no collection), verify it's not just a trademark mention.
  // If the front OCR text doesn't contain the collection name, it's likely from legal text on the back.
  if (!hasValue(frontResult.collection) && hasValue(backResult.collection) && hasValue(combined.collection)) {
    const collectionName = String(combined.collection);
    const frontTextUpper = frontOCRText.toUpperCase();
    const collectionWords = collectionName.toUpperCase().split(/\s+/);
    const frontHasCollection = collectionWords.every(w => frontTextUpper.includes(w));
    if (!frontHasCollection) {
      const backTextUpper = backOCRText.toUpperCase();
      const legalContextPattern = /REGISTERED\s+TRADEMARK|ALL\s+RIGHTS\s+RESERVED|©|\(C\)|OFFICIALLY\s+LICENSED/i;
      const backLines = backOCRText.split(/\r?\n/);
      const collectionInLegalLine = backLines.some(line => {
        const lineUpper = line.toUpperCase();
        return collectionWords.every(w => lineUpper.includes(w)) && legalContextPattern.test(line);
      });
      if (collectionInLegalLine) {
        console.log(`Clearing collection "${collectionName}" - only found in legal/trademark text on back, not visible on front card`);
        combined.collection = '';
      }
    }
  }
  
  // Special case for collection/variant: when front has a generic collection (e.g., "Chrome")
  // but back has a more specific collection + variant matching front's collection, prefer back's data
  if (hasValue(combined.collection) && hasValue(backResult.collection) && hasValue(backResult.variant)) {
    const frontCollection = String(combined.collection).toLowerCase();
    const backVariant = String(backResult.variant).toLowerCase();
    if (frontCollection === backVariant && combined.collection !== backResult.collection) {
      console.log(`Collection override: front="${combined.collection}" matches back variant="${backResult.variant}", using back collection="${backResult.collection}"`);
      combined.collection = backResult.collection;
      combined.variant = backResult.variant;
    }
  }
  
  // Special case for rookie card - if either side detected it, mark it as true
  if (frontResult.isRookieCard === true || backResult.isRookieCard === true) {
    combined.isRookieCard = true;
  }
  
  // Special case for serial numbers - if either side detected it, use it
  if (frontResult.serialNumber || backResult.serialNumber) {
    combined.serialNumber = frontResult.serialNumber || backResult.serialNumber;
    combined.isNumbered = true;
  }
  
  const bogusNameWords = new Set([
    'TOPPS', 'LOPPS', 'OPPS', 'CHROME', 'BOWMAN', 'FLEER', 'DONRUSS', 'PANINI', 'SCORE', 'LEAF',
    'SERIES', 'PHILLIE', 'PHILLIES', 'YANKEES', 'DODGERS', 'METS', 'CUBS', 'BRAVES',
    'ASTROS', 'RANGERS', 'PADRES', 'GIANTS', 'CARDINALS', 'NATIONALS', 'ORIOLES', 'GUARDIANS',
    'TWINS', 'RAYS', 'MARLINS', 'PIRATES', 'REDS', 'BREWERS', 'TIGERS', 'ROYALS', 'ATHLETICS',
    'MARINERS', 'ANGELS', 'ROCKIES', 'DIAMONDBACKS', 'WHITE', 'SOX',
    'OUTFIELDER', 'INFIELDER', 'PITCHER', 'CATCHER', 'LEFT', 'RIGHT', 'THROWS', 'BATS',
    'MAJOR', 'LEAGUE', 'BATTING', 'RECORD', 'STADIUM', 'CLUB', 'COLLECTION',
    'OPENING', 'DAY', 'HERITAGE', 'PRIZM', 'SELECT', 'MOSAIC',
    'BASEBALL', 'CARD', 'ROOKIE', 'STARS', 'MLB',
    'DRAFTED', 'BORN', 'FREE', 'AGENT',
    'ANNIV', 'ANNIVERSARY', 'ERSARY', 'COMPLETE',
    'AVG', 'SLG', 'OBP', 'ERA', 'RBI', 'HR', 'BB', 'SO', 'AB',
    'TOTALS', 'MAJ', 'LEA', 'THIRD', 'FIRST', 'SECOND', 'BASE',
    'OUTFIELD', 'HOUSTON', 'MILWAUKEE', 'PHILADELPHIA', 'CHICAGO',
    'EPPS', 'STROS', 'OXY',
    'LOP', 'PPS', 'TANKY', 'LOPPS',
  ]);
  
  const stripTrademarkSuffix = (w: string): string => w.replace(/(?:TM|™|®)$/i, '');
  
  const isBogusFn = (firstName?: string, lastName?: string): boolean => {
    if (!firstName || !lastName) return true;
    const fullName = `${firstName} ${lastName}`.toUpperCase();
    const words = fullName.split(/\s+/);
    if (words.some(w => bogusNameWords.has(stripTrademarkSuffix(w))) || words.length > 4) return true;
    if (words.some(w => w.length <= 1)) return true;
    if (words.some(w => /^\d/.test(w))) return true;
    if (words.length === 2 && words.every(w => w.length <= 3)) return true;
    return false;
  };
  
  const frontNameBogus = isBogusFn(combined.playerFirstName, combined.playerLastName);
  const backNameBogus = isBogusFn(backResult.playerFirstName, backResult.playerLastName);
  
  if (frontNameBogus && !backNameBogus && backResult.playerFirstName && backResult.playerLastName) {
    console.log(`Front player name "${combined.playerFirstName} ${combined.playerLastName}" looks unreliable, using back: "${backResult.playerFirstName} ${backResult.playerLastName}"`);
    combined.playerFirstName = backResult.playerFirstName;
    combined.playerLastName = backResult.playerLastName;
  }
  
  if (!frontNameBogus && !backNameBogus &&
      combined.playerLastName && backResult.playerLastName &&
      combined.playerLastName.toUpperCase() === backResult.playerLastName.toUpperCase() &&
      combined.playerFirstName && backResult.playerFirstName &&
      combined.playerFirstName.toUpperCase() !== backResult.playerFirstName.toUpperCase()) {
    const frontFirst = combined.playerFirstName!;
    const backFirst = backResult.playerFirstName!;
    console.log(`Player first name mismatch: front="${frontFirst}" vs back="${backFirst}" — keeping front name (preferred for eBay search, back often has birth/legal name on older cards)`);
  }
  
  if (frontNameBogus && backNameBogus) {
    const allText = (frontOCRText + '\n' + backOCRText).toUpperCase();
    let nameRecovered = false;
    
    const lines = allText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      let nameCandidate = trimmed;
      const firstWord = trimmed.split(/\s+/)[0];
      if (/^[A-Z0-9]+-\d+$/.test(firstWord) || /^\d+[A-Z]\d*-\d+$/.test(firstWord)) {
        nameCandidate = trimmed.substring(firstWord.length).trim();
      }
      
      const words = nameCandidate.split(/\s+/).filter(w => w.length > 0);
      if (words.length >= 2 && words.length <= 3) {
        const allAlpha = words.every(w => /^[A-Z]{2,}$/.test(w));
        const noBogus = words.every(w => !bogusNameWords.has(w));
        const noNumbers = words.every(w => !/\d/.test(w));
        
        if (allAlpha && noBogus && noNumbers) {
          combined.playerFirstName = words[0].charAt(0) + words[0].slice(1).toLowerCase();
          combined.playerLastName = words.slice(1).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
          console.log(`Recovered player name from OCR text: ${combined.playerFirstName} ${combined.playerLastName} (from line: "${trimmed}")`);
          nameRecovered = true;
          break;
        }
      }
    }
    
    if (!nameRecovered) {
      const nameLineMatch = allText.match(/^([A-Z][A-Z]+)\s+([A-Z][A-Z]+(?:\s+[A-Z][A-Z]+)?)\s*$/m);
      if (nameLineMatch) {
        const words = nameLineMatch[0].trim().split(/\s+/);
        const noBogusFn = words.every(w => !bogusNameWords.has(w));
        if (noBogusFn && words.length >= 2 && words.length <= 3) {
          combined.playerFirstName = words[0].charAt(0) + words[0].slice(1).toLowerCase();
          combined.playerLastName = words.slice(1).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
          console.log(`Recovered player name from OCR text (fallback): ${combined.playerFirstName} ${combined.playerLastName}`);
        }
      }
    }
  }
  
  if (!combined.collection) {
    const allText = (frontOCRText + ' ' + backOCRText).toUpperCase();
    
    if (/ANNIV.*ERSARY|35TH\s*ANNIVERSARY/i.test(allText) || 
        (allText.includes('ANNIV') && allText.includes('ERSARY')) ||
        (allText.includes('35') && (allText.includes('ANNIV') || allText.includes('ANNIVERSARY')))) {
      combined.collection = '35th Anniversary';
      console.log('Detected collection from fragmented OCR text: 35th Anniversary');
    }
  }
  
  
  // Handle other fields with no specific priority
  const otherFields: (keyof CardFormValues)[] = [
    'condition', 'estimatedValue', 'isAutographed', 'isNumbered', 'notes'
  ];
  
  otherFields.forEach(field => {
    if (frontResult[field] !== undefined && frontResult[field] !== null) {
      combined[field] = frontResult[field];
    } else if (backResult[field] !== undefined && backResult[field] !== null) {
      combined[field] = backResult[field];
    }
  });
  
  console.log('Combined result sport:', combined.sport);
  
  // Visual foil detection pass - analyze the actual card images for foil characteristics
  console.log('=== VISUAL FOIL DETECTION PASS ===');
  console.log('Current foil type before visual detection:', combined.foilType);
  console.log('Front image buffer available:', !!frontImageBuffer, frontImageBuffer ? `(${frontImageBuffer.length} bytes)` : '');
  console.log('Back image buffer available:', !!backImageBuffer, backImageBuffer ? `(${backImageBuffer.length} bytes)` : '');
  
  try {
    const { detectFoilFromImage } = await import('./visualFoilDetector');
    
    // Use front image primarily for visual foil detection (that's where foil effects are most visible)
    let visualFoilResult = null;
    
    if (frontImageBuffer) {
      console.log('Running visual foil detection on front image buffer...');
      const frontBase64 = frontImageBuffer.toString('base64');
      console.log('Base64 conversion successful, calling visual detector...');
      visualFoilResult = await detectFoilFromImage(frontBase64, { isNumbered: !!combined.isNumbered });
      console.log('Visual detection result from front image:', visualFoilResult);
    } else {
      console.log('No front image buffer available for visual detection');
    }
    
    // Foil detection only uses the front image - back images have colored backgrounds
    // (e.g., red Topps backs) that cause false positives
    if (!frontImageBuffer) {
      console.log('No front image available - skipping back image foil detection (back colors cause false positives)');
    }
    
    if (visualFoilResult?.isFoil && visualFoilResult.foilType) {
      combined.foilType = visualFoilResult.foilType;
      combined.isFoil = true;
      console.log(`Visual foil detection successful: ${visualFoilResult.foilType} (confidence: ${visualFoilResult.confidence})`);
      console.log(`Visual indicators: ${visualFoilResult.indicators.join('; ')}`);
    } else if (visualFoilResult && !visualFoilResult.indicators.some(indicator => indicator.includes('Error in visual analysis'))) {
      // Visual detection ran successfully but found no foil - trust this result over text analysis
      combined.foilType = null;
      combined.isFoil = false;
      console.log('Visual foil detection explicitly rejected foil characteristics');
      console.log(`Visual rejection reason: ${visualFoilResult.indicators.join('; ')}`);
    } else {
      // Visual detection couldn't run, fall back to text-based detection for explicit mentions
      console.log('Visual detection unavailable, falling back to text-based foil detection...');
      
      const { detectFoilVariant } = await import('./foilVariantDetector');
      const combinedOCRText = frontOCRText + ' ' + backOCRText;
      const textFoilResult = detectFoilVariant(combinedOCRText);
      
      if (textFoilResult.isFoil && textFoilResult.foilType) {
        combined.foilType = textFoilResult.foilType;
        combined.isFoil = true;
        console.log(`Text-based foil detection successful: ${textFoilResult.foilType}`);
      } else {
        combined.foilType = null;
        combined.isFoil = false;
        console.log('No foil variant detected by any method');
      }
    }
  } catch (error) {
    console.error('Error in foil detection:', error);
    combined.foilType = null;
    combined.isFoil = false;
  }
  
  // Set variant from foilType if foil was detected and no variant was set
  if (combined.isFoil && combined.foilType && !combined.variant) {
    combined.variant = combined.foilType;
    console.log(`Set variant to "${combined.foilType}" from foil detection`);
  }
  
  // Fix isNumbered when serialNumber is detected
  if (combined.serialNumber && /\d+\/\d+/.test(combined.serialNumber) && !combined.isNumbered) {
    combined.isNumbered = true;
    console.log(`Set isNumbered=true based on serial number: ${combined.serialNumber}`);
  }
  
  console.log('=== COMBINATION COMPLETE ===');
  
  return combined;
}

/**
 * Ensure all required fields have values
 */
function ensureRequiredFields(result: Partial<CardFormValues>): Partial<CardFormValues> {
  const defaultsIfMissing = {
    condition: 'PSA 8',
    sport: 'Not detected',
    brand: result.brand || 'Unknown',
    year: result.year || new Date().getFullYear(),
    playerFirstName: result.playerFirstName || 'Unknown',
    playerLastName: result.playerLastName || 'Player',
    collection: result.collection || '',
    cardNumber: result.cardNumber || '',
    variant: result.variant || '',
    serialNumber: result.serialNumber || '',
    estimatedValue: result.estimatedValue || 0,
    isRookieCard: !!result.isRookieCard,
    isAutographed: !!result.isAutographed,
    isNumbered: !!result.isNumbered,
    notes: result.notes || ''
  };
  
  // Make sure required fields exist
  Object.entries(defaultsIfMissing).forEach(([key, value]) => {
    if (result[key as keyof CardFormValues] === undefined || 
        result[key as keyof CardFormValues] === null) {
      result[key as keyof CardFormValues] = value as any;
    }
  });
  
  return result;
}