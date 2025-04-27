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
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No image provided' });
    }

    console.log('Received image file:', req.file.originalname, 'size:', req.file.size);
    console.log('Processing image with dynamic OCR analyzer...');
    
    // Run OCR on the image - convert buffer to base64 string
    const cardInfo = await analyzeSportsCardImage(req.file.buffer.toString('base64'));
    
    // Log the OCR results
    console.log('OCR results:', JSON.stringify(cardInfo, null, 2));
    
    // Send the response
    res.json({
      success: true,
      data: cardInfo
    });
    
  } catch (error: any) {
    console.error('Error analyzing card image:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred during image analysis'
    });
  }
}