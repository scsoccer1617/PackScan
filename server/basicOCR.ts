import { Request, Response } from 'express';
import { extractTextFromImage } from './googleVisionFetch';
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
 * Basic OCR handler that simplifies the detection process
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
    console.log('Processing image with basic OCR analyzer...');

    // Extract text using Google Vision API
    const result = await extractTextFromImage(req.file.buffer.toString('base64'));
    const fullText = result.fullText;
    
    console.log('Full OCR text:', fullText);
    
    // Clean up the text for consistent processing
    const cleanText = fullText.toUpperCase().replace(/\s+/g, ' ').trim();
    
    // Create a cardDetails object with the extracted information
    const cardDetails: Partial<CardFormValues> = {
      condition: 'PSA 8',
      playerFirstName: '',
      playerLastName: '',
      brand: '',
      collection: '',
      cardNumber: '',
      year: new Date().getFullYear(),
      variant: '',
      serialNumber: '',
      estimatedValue: 0,
      sport: 'Baseball',
      isRookieCard: false,
      isAutographed: false,
      isNumbered: false
    };
    
    // PLAYER NAME DETECTION
    const nameMatch = cleanText.match(/^[\s\n]*([A-Z]+)[\s\n]+([A-Z]+)[\s\n]/);
    if (nameMatch && nameMatch[1] && nameMatch[2]) {
      cardDetails.playerFirstName = formatName(nameMatch[1]);
      cardDetails.playerLastName = formatName(nameMatch[2]);
      console.log(`Detected player name from name pattern: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
    }
    
    // CARD NUMBER DETECTION
    const dashNumberMatch = cleanText.match(/\b([A-Z0-9]+)-([0-9]+)\b/);
    if (dashNumberMatch && dashNumberMatch[0]) {
      cardDetails.cardNumber = dashNumberMatch[0];
      console.log(`Detected card number with dash: ${cardDetails.cardNumber}`);
      
      // Check for 35th Anniversary card format
      if (dashNumberMatch[0].match(/^\d+[A-Z]-\d+$/)) {
        cardDetails.collection = "35th Anniversary";
        console.log(`Setting collection from card number pattern: 35th Anniversary`);
      }
    }
    
    // BRAND DETECTION
    if (cleanText.includes('TOPPS')) {
      cardDetails.brand = 'Topps';
      console.log(`Detected brand: Topps`);
    }
    
    // COLLECTION & VARIANT DETECTION
    if (cleanText.includes('STARS OF MLB') || cleanText.includes('SMLB')) {
      cardDetails.collection = 'Stars of MLB';
      console.log(`Detected collection: Stars of MLB`);
    } 
    else if (cleanText.includes('CHROME STARS OF MLB') || cleanText.includes('CSMLB')) {
      cardDetails.collection = 'Stars of MLB';
      cardDetails.variant = 'Chrome';
      console.log(`Detected collection: Stars of MLB (Chrome variant)`);
    }
    else if (cleanText.includes('HERITAGE')) {
      cardDetails.collection = 'Heritage';
      console.log(`Detected collection: Heritage`);
    }
    
    // CHROME VARIANT DETECTION
    if (cleanText.includes('CHROME') && !cardDetails.variant) {
      cardDetails.variant = 'Chrome';
      console.log(`Detected variant: Chrome`);
    }
    
    // YEAR DETECTION
    const copyrightMatch = cleanText.match(/(?:©|\(C\)|\&copy;|\&\s*©|\&\s*\(C\))(?:\s*)(\d{4})/i);
    if (copyrightMatch && copyrightMatch[1]) {
      try {
        const year = parseInt(copyrightMatch[1], 10);
        if (year >= 1900 && year <= new Date().getFullYear()) {
          cardDetails.year = year;
          console.log(`Using copyright year as card date: ${cardDetails.year}`);
        }
      } catch (e) {
        console.error('Error parsing year:', e);
      }
    }
    
    // ROOKIE CARD DETECTION
    if (cleanText.includes('RC') || cleanText.includes('ROOKIE')) {
      cardDetails.isRookieCard = true;
      console.log(`Detected rookie card status`);
    }
    
    // SPORT DETECTION
    if (cleanText.includes('MLB') || cleanText.includes('BASEBALL')) {
      cardDetails.sport = 'Baseball';
      console.log(`Sport detected: Baseball`);
    } 
    else if (cleanText.includes('NFL') || cleanText.includes('FOOTBALL')) {
      cardDetails.sport = 'Football';
      console.log(`Sport detected: Football`);
    }
    else if (cleanText.includes('NBA') || cleanText.includes('BASKETBALL')) {
      cardDetails.sport = 'Basketball'; 
      console.log(`Sport detected: Basketball`);
    }
    
    console.log('Extracted card details:', cardDetails);
    console.timeEnd('card-analysis-total');
    
    // Return the card details
    return res.json({
      success: true,
      data: cardDetails
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

/**
 * Format a name with proper capitalization
 */
function formatName(name: string): string {
  return name.toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}