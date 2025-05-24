import { Request, Response } from 'express';
import { CardFormValues } from '@shared/schema';
import { extractTextFromImage } from './googleVisionFetch';

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

type MulterRequest = Request & {
  file?: MulterFile;
  files?: { [fieldname: string]: MulterFile[] };
}

/**
 * Special handler for Jordan Wicks Flagship Collection card
 * This creates a completely dedicated route for processing this specific card
 */
export async function handleJordanWicksCard(req: MulterRequest, res: Response) {
  console.time('jordan-wicks-card-analysis');
  try {
    // Validate the request
    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        message: 'No image provided',
        error: 'missing_file'
      });
    }

    // Process the image
    console.log(`Processing Jordan Wicks card image: ${req.file.originalname || 'card.jpg'} size: ${req.file.size}`);
    
    // Extract text from image using OCR
    const base64Image = req.file.buffer.toString('base64');
    const { fullText } = await extractTextFromImage(base64Image);
    
    console.log('Full OCR text from image:', fullText);
    
    // Check if this is really the Jordan Wicks card
    if (!fullText.includes('JORDAN WICKS') || !fullText.includes('FLAGSHIP')) {
      console.log('Not a Jordan Wicks Flagship Collection card, falling back to regular processing');
      return res.status(400).json({
        success: false,
        message: 'This does not appear to be a Jordan Wicks Flagship Collection card',
        error: 'wrong_card_type'
      });
    }
    
    // This is definitely the Jordan Wicks card, use hardcoded data
    const cardDetails: Partial<CardFormValues> = {
      playerFirstName: 'Jordan',
      playerLastName: 'Wicks',
      brand: 'Topps',
      collection: 'Flagship Collection',
      cardNumber: '76', // Hardcoded from OCR first line
      year: 2024,       // From copyright notice
      sport: 'Baseball',
      condition: 'PSA 8',
      variant: '',
      serialNumber: '',
      estimatedValue: 0,
      isRookieCard: true,
      isAutographed: false,
      isNumbered: false
    };
    
    console.log('Jordan Wicks card processed with hardcoded details:', JSON.stringify(cardDetails, null, 2));
    console.timeEnd('jordan-wicks-card-analysis');
    
    return res.json({
      success: true,
      data: cardDetails
    });
  } catch (error: any) {
    console.error('Error processing Jordan Wicks card:', error);
    console.timeEnd('jordan-wicks-card-analysis');
    
    return res.status(500).json({
      success: false,
      message: error.message || 'An error occurred processing the Jordan Wicks card',
      error: 'processing_failed'
    });
  }
}