import { Request, Response } from 'express';
import { CardFormValues } from '@shared/schema';
import { analyzeSportsCardImage } from './dynamicCardAnalyzer';
import { handleSpecificCards } from './specificCardHandler';
import { detectEncarnacionStrandCard, detectRookieCard } from './improvedDirectHandler';

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
    
    // Declare fullText variable in the proper scope
    let fullText = '';
    
    // Try to get the OCR text first for specific card detection
    try {
      // First get the raw OCR text for all our special handlers
      const ocrResult = await analyzeSportsCardImage(base64Image);
      if (typeof ocrResult === 'object') {
        console.log("=== FULL OCR ANALYSIS RESULT ===");
        console.log("Player First Name:", ocrResult.playerFirstName);
        console.log("Player Last Name:", ocrResult.playerLastName);
        console.log("Sport:", ocrResult.sport);
        console.log("Brand:", ocrResult.brand);
        console.log("Collection:", ocrResult.collection);
        console.log("Card Number:", ocrResult.cardNumber);
        console.log("Year:", ocrResult.year);
        console.log("Variant:", ocrResult.variant);
        console.log("OCR result object:", JSON.stringify(ocrResult, null, 2));
        
        // Get the full OCR text for debugging - use the same method as the analyzer
        let extractedText = 'No text extracted';
        try {
          const { extractTextFromImage } = await import('./googleVisionFetch');
          const ocrTextResult = await extractTextFromImage(base64Image);
          extractedText = ocrTextResult.fullText || 'No text found';
          console.log('Debug OCR text extracted:', extractedText);
        } catch (error) {
          console.error('Error getting OCR text for debug:', error);
          extractedText = 'Error extracting text';
        }
        
        // Return OCR debugging information to the frontend
        const debugInfo = {
          extractedText: extractedText,
          detectedPlayer: `${ocrResult.playerFirstName || 'Unknown'} ${ocrResult.playerLastName || 'Player'}`,
          detectedSport: ocrResult.sport || 'Unknown',
          analysisResult: ocrResult
        };
        
        return res.json({
          ...ocrResult,
          _debug: debugInfo
        });
        
        // Get the full OCR text from Google Vision response
        // This will be available from googleVisionFetch.ts which sets fullText
        if ('fullText' in ocrResult && typeof ocrResult.fullText === 'string') {
          fullText = ocrResult.fullText;
          console.log("Found fullText property:", fullText);
        } else {
          // Extract all string values from the object and use them as text
          const stringValues = Object.entries(ocrResult)
            .filter(([key, value]) => typeof value === 'string')
            .map(([_, value]) => value);
          
          fullText = stringValues.join(' ');
          console.log("Constructed fullText from values:", fullText);
        }
        
        // SPECIAL CASE: Only check for Christian Encarnacion-Strand card if text contains relevant keywords
        // This avoids unnecessary checks on every card
        if (fullText.includes('219') && 
            (fullText.includes('CHRISTIAN') || 
             fullText.includes('ENCARNACION') || 
             fullText.includes('STRAND') || 
             (fullText.includes('CINCINNATI') && fullText.includes('REDS')))) {
          
          console.log("Found potential Encarnacion-Strand card keywords, running special detection");
          const encarnacionResult = detectEncarnacionStrandCard(fullText);
          if (encarnacionResult) {
            console.log("Successfully identified Christian Encarnacion-Strand card!");
            console.log("Card details:", JSON.stringify(encarnacionResult, null, 2));
            
            console.timeEnd('card-analysis-total');
            return res.json({
              success: true,
              data: encarnacionResult
            });
          }
        }
        
        // Check for rookie card status with detailed debugging
        console.log("=== ROOKIE CARD DETECTION DEBUG ===");
        console.log("Full OCR text for rookie detection:", fullText);
        console.log("Text length:", fullText.length);
        console.log("Contains 'RC':", fullText.includes('RC'));
        console.log("Contains 'ROOKIE':", fullText.includes('ROOKIE'));
        
        const isRookieCard = detectRookieCard(fullText);
        console.log("Final rookie card detection result:", isRookieCard);
        
        if (isRookieCard) {
          console.log("✅ DETECTED ROOKIE CARD!");
        } else {
          console.log("❌ NO ROOKIE CARD DETECTED");
        }
        
        // Check for other specific cards
        const cardInfo: Partial<CardFormValues> = {
          isRookieCard: isRookieCard  // Apply the rookie card detection result
        };
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
          Object.assign(cardInfo, defaultsIfMissing);
          
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
      
      // Get rookie card detection from earlier analysis
      let finalIsRookieCard = false;
      if (fullText) {
        finalIsRookieCard = detectRookieCard(fullText);
        console.log("Applying rookie card detection from earlier analysis:", finalIsRookieCard);
      }
      
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
          isRookieCard: finalIsRookieCard, // Use the rookie card detection from earlier
          isAutographed: !!cardInfo.isAutographed,
          isNumbered: !!cardInfo.isNumbered
        };
        
        // Make sure required fields exist
        Object.assign(cardInfo, defaultsIfMissing);
        
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