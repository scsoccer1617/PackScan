import { Request, Response } from 'express';
import { analyzeSportsCardImage } from './dynamicCardAnalyzer';
import { CardFormValues } from '@shared/schema';

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
 * Fixed OCR handler that properly returns detected card information
 */
export async function handleCardImageAnalysis(req: MulterRequest, res: Response) {
  console.time('card-analysis-total');
  try {
    // Validate the request
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

    // Process the image
    console.log(`Received image file: ${req.file.originalname || 'card.jpg'} size: ${req.file.size}`);
    console.log('Processing image with dynamic OCR analyzer...');

    // Analyze the image and get card details
    const cardDetailsResult = await analyzeSportsCardImage(req.file.buffer.toString('base64'));
    
    // Make sure we have a valid object to work with
    const cardDetails = cardDetailsResult || {};

    // Ensure we have default values for required fields
    const processedCardDetails: Partial<CardFormValues> = {
      condition: 'PSA 8',
      sport: 'Baseball',
      playerFirstName: 'Unknown',
      playerLastName: 'Player',
      brand: 'Topps',
      collection: '',
      cardNumber: '',
      year: new Date().getFullYear(),
      variant: '',
      serialNumber: '',
      estimatedValue: 0,
      isRookieCard: false,
      isAutographed: false,
      isNumbered: false
    };
    
    // Now safely copy over any detected values
    if (cardDetails && typeof cardDetails === 'object') {
      if (cardDetails.condition) processedCardDetails.condition = cardDetails.condition;
      if (cardDetails.sport) processedCardDetails.sport = cardDetails.sport;
      if (cardDetails.playerFirstName) processedCardDetails.playerFirstName = cardDetails.playerFirstName;
      if (cardDetails.playerLastName) processedCardDetails.playerLastName = cardDetails.playerLastName;
      if (cardDetails.brand) processedCardDetails.brand = cardDetails.brand;
      if (cardDetails.collection) processedCardDetails.collection = cardDetails.collection;
      if (cardDetails.cardNumber) processedCardDetails.cardNumber = cardDetails.cardNumber;
      if (cardDetails.year) processedCardDetails.year = cardDetails.year;
      if (cardDetails.variant) processedCardDetails.variant = cardDetails.variant;
      if (cardDetails.serialNumber) processedCardDetails.serialNumber = cardDetails.serialNumber;
      if (cardDetails.estimatedValue) processedCardDetails.estimatedValue = cardDetails.estimatedValue;
      if (cardDetails.isRookieCard) processedCardDetails.isRookieCard = !!cardDetails.isRookieCard;
      if (cardDetails.isAutographed) processedCardDetails.isAutographed = !!cardDetails.isAutographed;
      if (cardDetails.isNumbered) processedCardDetails.isNumbered = !!cardDetails.isNumbered;
    }

    // Log the results
    console.log('OCR results:', JSON.stringify(processedCardDetails, null, 2));
    console.timeEnd('card-analysis-total');

    // Return the card details
    return res.json({
      success: true,
      data: processedCardDetails
    });

  } catch (error: any) {
    console.error('Error analyzing card image:', error);
    console.timeEnd('card-analysis-total');
    
    // Send a more detailed error response
    return res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred during image analysis',
      error: 'analysis_failed',
      data: {
        condition: 'PSA 8',
        sport: 'Baseball',
        brand: 'Topps',
        year: new Date().getFullYear(),
        playerFirstName: 'Unknown',
        playerLastName: 'Player',
        errorMessage: 'Failed to analyze the card image'
      }
    });
  }
}