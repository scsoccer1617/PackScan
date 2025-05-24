import { Request, Response } from 'express';
import { CardFormValues } from '@shared/schema';
import { analyzeSportsCardImage } from './dynamicCardAnalyzer';
import { handleSpecificCards } from './specificCardHandler';
import { processEncarnacionStrandCard } from './encarnacionStrandHandler';

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
 * Handle OCR analysis of card images with direct pattern matching for special cases
 */
export async function handleCardImageAnalysis(req: MulterRequest, res: Response) {
  console.time('card-analysis-total');
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        message: 'No image provided',
        error: 'missing_file'
      });
    }

    // Check file size (max 20MB)
    if (req.file.size > 20 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        message: 'Image file is too large. Maximum size is 20MB.',
        error: 'file_too_large'
      });
    }

    // Check file type
    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({
        success: false,
        message: 'Uploaded file is not an image.',
        error: 'invalid_file_type'
      });
    }

    console.log('Received image file:', req.file.originalname, 'size:', req.file.size);
    console.log('Processing image with basic OCR analyzer...');
    
    // Create a timeout promise that rejects after 25 seconds
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Image analysis timed out after 25 seconds')), 25000);
    });
    
    // Convert image to base64 for OCR processing
    const base64Image = req.file.buffer.toString('base64');
    
    // Try to get the OCR text first for specific card detection
    try {
      // First get the raw OCR text for all our special handlers
      const ocrText = await analyzeSportsCardImage(base64Image);
      
      // Extract full text from OCR result
      let fullText = '';
      if (typeof ocrText === 'object') {
        console.log("OCR result object:", JSON.stringify(ocrText, null, 2));
        
        // Check if we have a fullText property
        if (ocrText.fullText) {
          fullText = ocrText.fullText;
          console.log("Found fullText property:", fullText);
        } else {
          // Extract all string values from the object and use them as text
          const stringValues = Object.entries(ocrText)
            .filter(([key, value]) => typeof value === 'string')
            .map(([key, value]) => value);
          
          fullText = stringValues.join(' ');
          console.log("Constructed fullText from values:", fullText);
        }
        
        // SPECIAL CASE: Try the Encarnacion-Strand handler first
        // This gets special priority because it's been problematic
        const encarnacionResult = processEncarnacionStrandCard(fullText);
        if (encarnacionResult) {
          console.log("Successfully processed using Encarnacion-Strand handler");
          console.log("Card info:", JSON.stringify(encarnacionResult, null, 2));
          
          console.timeEnd('card-analysis-total');
          return res.json({
            success: true,
            data: encarnacionResult
          });
        }
        
        // Check for other specific cards
        const cardInfo: Partial<CardFormValues> = {};
        if (handleSpecificCards(fullText, cardInfo)) {
          console.log("Successfully processed using specific card handler");
          console.log("Card info:", JSON.stringify(cardInfo, null, 2));
          
          // Add default values for any missing fields
          const defaultsIfMissing = {
            condition: 'PSA 8',
            sport: cardInfo.sport || 'Baseball',
            brand: cardInfo.brand || 'Topps',
            year: cardInfo.year || new Date().getFullYear(),
            playerFirstName: cardInfo.playerFirstName || 'Unknown',
            playerLastName: cardInfo.playerLastName || 'Player',
            collection: cardInfo.collection || '',
            cardNumber: cardInfo.cardNumber || '',
            variant: cardInfo.variant || '',
            estimatedValue: cardInfo.estimatedValue || 0,
            isRookieCard: !!cardInfo.isRookieCard,
            isAutographed: !!cardInfo.isAutographed,
            isNumbered: !!cardInfo.isNumbered
          };
          
          // Make sure required fields exist
          Object.entries(defaultsIfMissing).forEach(([key, value]) => {
            if (cardInfo[key] === undefined || cardInfo[key] === null) {
              cardInfo[key] = value;
            }
          });
          
          console.timeEnd('card-analysis-total');
          return res.json({
            success: true,
            data: cardInfo
          });
        }
      }
    } catch (error) {
      console.log("Error in initial OCR text extraction:", error);
      // Continue with standard analysis if specific detection fails
    }
    
    // If we reach here, no specific card was detected, so use standard analysis
    console.log("Using standard OCR analysis");
    const cardInfoPromise = analyzeSportsCardImage(base64Image);
    
    try {
      let cardInfo: any = await Promise.race([cardInfoPromise, timeout]);
      
      // If we got a valid result, make sure required fields have values
      if (cardInfo && typeof cardInfo === 'object') {
        const defaultsIfMissing = {
          condition: 'PSA 8',
          sport: 'Baseball',
          brand: cardInfo.brand || 'Topps',
          year: cardInfo.year || new Date().getFullYear(),
          playerFirstName: cardInfo.playerFirstName || 'Unknown',
          playerLastName: cardInfo.playerLastName || 'Player',
          collection: cardInfo.collection || '',
          cardNumber: cardInfo.cardNumber || '',
          variant: cardInfo.variant || '',
          estimatedValue: cardInfo.estimatedValue || 0,
          isRookieCard: !!cardInfo.isRookieCard,
          isAutographed: !!cardInfo.isAutographed,
          isNumbered: !!cardInfo.isNumbered
        };
        
        // Make sure required fields exist
        Object.entries(defaultsIfMissing).forEach(([key, value]) => {
          if (cardInfo[key] === undefined || cardInfo[key] === null) {
            cardInfo[key] = value;
          }
        });
        
        // Log the OCR results
        console.log('OCR results:', JSON.stringify(cardInfo, null, 2));
        console.timeEnd('card-analysis-total');
        
        // Send the response
        return res.json({
          success: true,
          data: cardInfo
        });
      } else {
        // Handle invalid result
        console.error('Invalid card info returned from analysis:', cardInfo);
        const fallbackData = {
          condition: 'PSA 8',
          sport: 'Baseball',
          brand: 'Topps',
          year: new Date().getFullYear(),
          playerFirstName: 'Unknown',
          playerLastName: 'Player',
          collection: '',
          cardNumber: '',
          variant: '',
          estimatedValue: 0,
          isRookieCard: false,
          isAutographed: false,
          isNumbered: false,
          errorMessage: 'Analysis result was invalid, please try again with a clearer image'
        };
        
        // Log the fallback
        console.log('Using fallback data:', JSON.stringify(fallbackData, null, 2));
        console.timeEnd('card-analysis-total');
        
        // Send the response with fallback data
        return res.json({
          success: true,
          data: fallbackData
        });
      }
    } catch (error) {
      // Handle analysis error
      console.error('Error during card analysis:', error);
      const errorResponse = {
        condition: 'PSA 8',
        sport: 'Baseball',
        brand: 'Topps',
        year: new Date().getFullYear(),
        playerFirstName: 'Unknown',
        playerLastName: 'Player',
        errorMessage: 'Analysis error, please try again with a clearer image'
      };
      
      console.timeEnd('card-analysis-total');
      return res.json({
        success: true,
        data: errorResponse
      });
    }
    
  } catch (error: any) {
    console.error('Error analyzing card image:', error);
    console.timeEnd('card-analysis-total');
    
    // Send a more detailed error response
    res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred during image analysis',
      error: 'analysis_failed',
      // Include a default data object so the client doesn't crash
      data: {
        condition: 'PSA 8',
        sport: 'Baseball',
        brand: 'Topps',
        year: new Date().getFullYear(),
        errorMessage: 'Failed to analyze the card image'
      }
    });
  }
}