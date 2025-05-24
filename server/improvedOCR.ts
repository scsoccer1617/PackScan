import { Request, Response } from 'express';
import { analyzeSportsCardImage } from './dynamicCardAnalyzer';

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
 * Handle OCR analysis of card images
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
    console.log('Processing image with dynamic OCR analyzer...');
    
    // Create a timeout promise that rejects after 25 seconds
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Image analysis timed out after 25 seconds')), 25000);
    });
    
    // Race the analysis against the timeout
    const cardInfoPromise = analyzeSportsCardImage(req.file.buffer.toString('base64'));
    let cardInfo = await Promise.race([cardInfoPromise, timeout])
      .catch(error => {
        console.error('Analysis timeout or error:', error);
        // Return default values if timeout occurs
        return {
          condition: 'PSA 8',
          sport: 'Baseball',
          brand: 'Topps',
          year: new Date().getFullYear(),
          errorMessage: 'Analysis timed out, please try again with a clearer image'
        };
      });
    
    // Ensure we always have valid data to return to the client
    if (!cardInfo || typeof cardInfo !== 'object') {
      console.error('Invalid card info returned from analysis:', cardInfo);
      // Provide a default fallback if the result is invalid
      cardInfo = {
        condition: 'PSA 8',
        sport: 'Baseball',
        brand: 'Topps',
        year: new Date().getFullYear(),
        playerFirstName: 'Unknown',
        playerLastName: 'Player',
        errorMessage: 'Analysis result was invalid, please try again with a clearer image'
      };
    }
    
    // Add estimated value field if missing
    if (cardInfo.estimatedValue === undefined) {
      cardInfo.estimatedValue = 0;
    }
    
    // Log the OCR results
    console.log('OCR results:', JSON.stringify(cardInfo, null, 2));
    console.timeEnd('card-analysis-total');
    
    // Send the response
    res.json({
      success: true,
      data: cardInfo
    });
    
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