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
        
        // Try to determine if this is a Score card first by checking brand name
        console.log(`Front text detection: ${frontOCRText.substring(0, 100)}`);
        if (frontOCRText.toUpperCase().includes('SCORE')) {
          console.log('Detected Score card brand from front image, using specialized analyzer');
          frontResult = await Promise.race([analyzeScoreCard(frontBase64), createTimeout()]);
        } else {
          // Use standard analyzer for other card brands
          console.log('Using standard analyzer for front image');
          console.log('Calling analyzeSportsCardImage...');
          frontResult = await Promise.race([analyzeSportsCardImage(frontBase64), createTimeout()]);
          console.log('analyzeSportsCardImage returned:', frontResult);
        }
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
        
        // Try to determine if this is a Score card first by checking brand name
        console.log(`Back text detection: ${backOCRText.substring(0, 100)}`);
        if (backOCRText.toUpperCase().includes('SCORE')) {
          console.log('Detected Score card brand from back image, using specialized analyzer');
          backResult = await Promise.race([analyzeScoreCard(backBase64), createTimeout()]);
        } else {
          // Use standard analyzer for other card brands
          console.log('Using standard analyzer for back image');
          console.log('Calling analyzeSportsCardImage for back...');
          backResult = await Promise.race([analyzeSportsCardImage(backBase64), createTimeout()]);
          console.log('analyzeSportsCardImage returned for back:', backResult);
        }
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
      combinedResult = await combineCardResults(frontResult, backResult, frontOCRText, backOCRText);
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
  backOCRText: string = ''
): Promise<Partial<CardFormValues>> {
  console.log('=== COMBINE CARD RESULTS STARTED ===');
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
    'playerFirstName', 'playerLastName', 'cardNumber', 
    'isRookieCard', 'brand', 'collection', 'variant'
  ];
  
  // Fields where back image has priority
  const backPriorityFields: (keyof CardFormValues)[] = [
    'year', 'sport', 'serialNumber'
  ];
  
  // Copy front priority fields first
  frontPriorityFields.forEach(field => {
    if (frontResult[field] !== undefined && frontResult[field] !== null && frontResult[field] !== '') {
      combined[field] = frontResult[field];
    } else if (backResult[field] !== undefined && backResult[field] !== null && backResult[field] !== '') {
      combined[field] = backResult[field];
    }
  });
  
  // Then copy back priority fields
  backPriorityFields.forEach(field => {
    if (backResult[field] !== undefined && backResult[field] !== null && backResult[field] !== '') {
      combined[field] = backResult[field];
    } else if (frontResult[field] !== undefined && frontResult[field] !== null && frontResult[field] !== '') {
      combined[field] = frontResult[field];
    }
  });
  
  // Special case for rookie card - if either side detected it, mark it as true
  if (frontResult.isRookieCard === true || backResult.isRookieCard === true) {
    combined.isRookieCard = true;
  }
  
  // Special case for serial numbers - if either side detected it, use it
  if (frontResult.serialNumber || backResult.serialNumber) {
    combined.serialNumber = frontResult.serialNumber || backResult.serialNumber;
    combined.isNumbered = true;
  }
  
  // Special case for Score cards: if brand is detected as Score, double-check the player name
  // to ensure we didn't mistake "SCORE" for a player's first name
  if (combined.brand === 'Score' && combined.playerFirstName === 'Score') {
    // If the first name is 'Score', try to get a proper name from other source
    if (backResult.playerFirstName && backResult.playerFirstName !== 'Score') {
      combined.playerFirstName = backResult.playerFirstName;
      combined.playerLastName = backResult.playerLastName || '';
    } else if (frontResult.playerLastName) {
      // Shift the last name to first name and see if we can find another name from back result
      combined.playerFirstName = frontResult.playerLastName;
      combined.playerLastName = backResult.playerFirstName || '';
    }
  }
  
  // Special case for Score cards: ensure collection includes the year
  if (combined.brand === 'Score' && combined.year && !combined.collection) {
    combined.collection = `${combined.year} Score`;
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
  
  // Final foil detection pass - use all available text
  // Always run this to potentially find more specific foil variants
  console.log('=== FINAL FOIL DETECTION PASS ===');
  console.log('Current foil type before final detection:', combined.foilType);
  // Use the imported detectFoilVariant function
    
    // Use only the raw OCR text for foil detection (not the result objects)
    const combinedOCRText = frontOCRText + ' ' + backOCRText;
    
    console.log('=== RAW OCR TEXT FOR FOIL DETECTION ===');
    console.log('Front OCR text length:', frontOCRText.length);
    console.log('Back OCR text length:', backOCRText.length);
    console.log('Combined OCR text (first 500 chars):', combinedOCRText.substring(0, 500));
    console.log('Combined OCR text contains "green":', combinedOCRText.toLowerCase().includes('green'));
    console.log('Combined OCR text contains "foil":', combinedOCRText.toLowerCase().includes('foil'));
    console.log('Combined OCR text contains "holo":', combinedOCRText.toLowerCase().includes('holo'));
    console.log('Combined OCR text contains "laser":', combinedOCRText.toLowerCase().includes('laser'));
    
    // Only use the actual OCR text for foil detection (not processed results)
    console.log(`Testing foil detection with raw OCR text: ${combinedOCRText.substring(0, 100)}`);
    console.log('CALLING detectFoilVariant function now...');
    const foilResult = detectFoilVariant(combinedOCRText);
    console.log(`Foil result: isFoil=${foilResult.isFoil}, type=${foilResult.foilType}`);
    
    if (foilResult.isFoil && foilResult.foilType) {
      combined.foilType = foilResult.foilType;
      combined.isFoil = true;
      console.log(`Final foil detection successful: ${foilResult.foilType}`);
    } else {
      // Ensure no foil is detected when there's no evidence
      combined.foilType = null;
      combined.isFoil = false;
      console.log('No foil variant detected - setting to null');
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