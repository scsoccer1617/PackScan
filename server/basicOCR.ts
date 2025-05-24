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
    
    // PLAYER NAME DETECTION - Using multiple approaches
    
    // Try to match the card number and player name pattern (common for many cards)
    // Example: "89B-2 MANNY MACHADO"
    const cardNumberNamePattern = /\b([A-Z0-9]+)-([0-9]+)\s+([A-Z]+)\s+([A-Z]+)\b/i;
    const cardNumberNameMatch = cleanText.match(cardNumberNamePattern);
    
    if (cardNumberNameMatch && cardNumberNameMatch[3] && cardNumberNameMatch[4]) {
      cardDetails.playerFirstName = formatName(cardNumberNameMatch[3]);
      cardDetails.playerLastName = formatName(cardNumberNameMatch[4]);
      console.log(`Detected player name near card number: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
    } 
    // Fallback to looking for a name at the beginning of the text
    else {
      const nameMatch = cleanText.match(/^[\s\n]*([A-Z]+)[\s\n]+([A-Z]+)[\s\n]/);
      if (nameMatch && nameMatch[1] && nameMatch[2]) {
        cardDetails.playerFirstName = formatName(nameMatch[1]);
        cardDetails.playerLastName = formatName(nameMatch[2]);
        console.log(`Detected player name from beginning of text: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
      }
      
      // Try a more general pattern for standalone names in the text
      if (!cardDetails.playerFirstName && !cardDetails.playerLastName) {
        const generalNamePattern = /\b([A-Z]{3,})\s+([A-Z]{3,})\b/;
        const generalNameMatch = cleanText.match(generalNamePattern);
        
        if (generalNameMatch && generalNameMatch[1] && generalNameMatch[2]) {
          cardDetails.playerFirstName = formatName(generalNameMatch[1]);
          cardDetails.playerLastName = formatName(generalNameMatch[2]);
          console.log(`Detected player name with general pattern: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
        }
      }
    }
    
    // CARD NUMBER DETECTION
    if (cardDetails.brand === 'Score') {
      // Score cards typically have a number at the top or beginning of the card
      // First try to find a plain number at the beginning
      const scoreNumberPattern = /^[\s\n]*(\d{1,3})\b/;
      const scoreNumberMatch = cleanText.match(scoreNumberPattern);
      
      if (scoreNumberMatch && scoreNumberMatch[1]) {
        cardDetails.cardNumber = scoreNumberMatch[1];
        console.log(`Detected Score card number from beginning: ${cardDetails.cardNumber}`);
      } 
      // If not found at beginning, look anywhere in the first few words
      else {
        const scoreNumberAnywhere = /\b(\d{1,3})\b/;
        const firstFewWords = cleanText.split(/\s+/).slice(0, 5).join(' ');
        const scoreNumberAnywhereMatch = firstFewWords.match(scoreNumberAnywhere);
        
        if (scoreNumberAnywhereMatch && scoreNumberAnywhereMatch[1]) {
          cardDetails.cardNumber = scoreNumberAnywhereMatch[1];
          console.log(`Detected Score card number from first few words: ${cardDetails.cardNumber}`);
        }
      }
    } else {
      // Standard format for modern cards with dash
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
    }
    
    // BRAND DETECTION
    if (cleanText.includes('TOPPS')) {
      cardDetails.brand = 'Topps';
      console.log(`Detected brand: Topps`);
    } else if (cleanText.includes('SCORE') && !cleanText.includes('SCORE CARD')) {
      cardDetails.brand = 'Score';
      console.log(`Detected brand: Score`);
      
      // For Score cards, we need to handle the player name differently
      // Score cards often have "SCORE" at the top followed by player name
      // Like: "603 SCORE JUAN BELL"
      if (cardDetails.playerFirstName === 'Score') {
        // If we incorrectly detected "Score" as first name, look for actual player name
        const scoreNamePattern = /SCORE[\s\n]+([A-Z]+)[\s\n]+([A-Z]+)/;
        const scoreNameMatch = cleanText.match(scoreNamePattern);
        
        if (scoreNameMatch && scoreNameMatch[1] && scoreNameMatch[2]) {
          cardDetails.playerFirstName = formatName(scoreNameMatch[1]);
          cardDetails.playerLastName = formatName(scoreNameMatch[2]);
          console.log(`Corrected player name for Score card: ${cardDetails.playerFirstName} ${cardDetails.playerLastName}`);
        }
      }
    }
    
    // COLLECTION & VARIANT DETECTION
    if (cardDetails.brand === 'Score') {
      // For old Score cards (pre-2000), the base set typically doesn't have a specific collection name
      // Only special insert sets have collection names like "Rookies" or "Traded"
      if (cardDetails.year && cardDetails.year < 2000) {
        // For vintage Score, just leave collection blank for base sets
        cardDetails.collection = '';
        console.log(`Score base set from ${cardDetails.year}, no specific collection name needed`);
      } else if (cardDetails.year) {
        // For modern Score, use year in collection name
        cardDetails.collection = `${cardDetails.year} Score`;
        console.log(`Set modern Score collection: ${cardDetails.collection}`);
      } else {
        // Fallback
        cardDetails.collection = '';
        console.log(`No specific collection for Score base set`);
      }
      
      // Check for special Score collections
      if (cleanText.includes('SCORE TRADED') || cleanText.includes('TRADED SET')) {
        cardDetails.collection = 'Score Traded';
        console.log(`Detected Score Traded collection`);
      } else if (cleanText.includes('SCORE ROOKIES')) {
        cardDetails.collection = 'Score Rookies';
        console.log(`Detected Score Rookies collection`);
      }
    }
    // Modern Topps collections
    else if (cleanText.includes('STARS OF MLB') || cleanText.includes('SMLB')) {
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
    
    // YEAR DETECTION - Try multiple patterns for copyright year
    
    // Check for exact match with ampersand format like "&2024"
    const ampersandYearMatch = cleanText.match(/\&(\d{4})/i);
    if (ampersandYearMatch && ampersandYearMatch[1]) {
      try {
        const year = parseInt(ampersandYearMatch[1], 10);
        if (year >= 1900 && year <= new Date().getFullYear()) {
          cardDetails.year = year;
          console.log(`Using ampersand year as card date: ${cardDetails.year}`);
        }
      } catch (e) {
        console.error('Error parsing ampersand year:', e);
      }
    } 
    // Fallback to standard copyright format
    else {
      const copyrightMatch = cleanText.match(/(?:©|\(C\)|\&copy;|\&\s*©|\&\s*\(C\))(?:\s*)(\d{4})/i);
      if (copyrightMatch && copyrightMatch[1]) {
        try {
          const year = parseInt(copyrightMatch[1], 10);
          if (year >= 1900 && year <= new Date().getFullYear()) {
            cardDetails.year = year;
            console.log(`Using copyright year as card date: ${cardDetails.year}`);
          }
        } catch (e) {
          console.error('Error parsing copyright year:', e);
        }
      }
      // Last resort - look for any 4-digit year that appears after text like "TOPPS COMPANY"
      else if (cleanText.includes('TOPPS COMPANY')) {
        const companyYearMatch = cleanText.match(/TOPPS COMPANY[^\d]*(\d{4})/i);
        if (companyYearMatch && companyYearMatch[1]) {
          try {
            const year = parseInt(companyYearMatch[1], 10);
            if (year >= 1900 && year <= new Date().getFullYear()) {
              cardDetails.year = year;
              console.log(`Using Topps company year as card date: ${cardDetails.year}`);
            }
          } catch (e) {
            console.error('Error parsing company year:', e);
          }
        }
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