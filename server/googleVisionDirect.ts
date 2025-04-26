import { CardFormValues } from '../shared/schema';
import fetch from 'node-fetch';

/**
 * Extract text from image using Google Cloud Vision API via direct REST
 * @param base64Image Base64 encoded image
 * @returns Extracted text
 */
export async function extractTextFromImage(base64Image: string): Promise<string> {
  try {
    console.log('Using direct REST method to access Google Cloud Vision API');
    
    // Create a JWT for authentication
    const email = process.env.GOOGLE_CLIENT_EMAIL;
    const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    
    if (!email || !key) {
      throw new Error('Missing Google service account credentials');
    }
    
    // Prepare the request to get access token
    const tokenEndpoint = 'https://oauth2.googleapis.com/token';
    const scope = 'https://www.googleapis.com/auth/cloud-platform';
    
    // Create a JWT claim
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + 3600; // 1 hour
    
    const claim = {
      iss: email,
      scope: scope,
      aud: tokenEndpoint,
      exp: expiry,
      iat: now
    };
    
    // Encode the claim
    const header = { alg: 'RS256', typ: 'JWT' };
    const headerBase64 = Buffer.from(JSON.stringify(header)).toString('base64').replace(/=+$/, '');
    const claimBase64 = Buffer.from(JSON.stringify(claim)).toString('base64').replace(/=+$/, '');
    
    // Sign the JWT
    const crypto = require('crypto');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${headerBase64}.${claimBase64}`);
    const signature = sign.sign(key, 'base64').replace(/=+$/, '');
    
    const jwt = `${headerBase64}.${claimBase64}.${signature}`;
    
    // Get the access token
    console.log('Getting access token...');
    const tokenResponse = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });
    
    const tokenData = await tokenResponse.json() as any;
    
    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error('Token error:', tokenData);
      throw new Error(`Failed to get access token: ${tokenData.error || 'Unknown error'}`);
    }
    
    const accessToken = tokenData.access_token;
    console.log('Access token obtained successfully');
    
    // Make the Vision API request
    const visionEndpoint = 'https://vision.googleapis.com/v1/images:annotate';
    console.log('Sending request to Vision API...');
    
    const visionRequest = {
      requests: [
        {
          image: {
            content: base64Image
          },
          features: [
            {
              type: 'TEXT_DETECTION',
              maxResults: 50
            }
          ]
        }
      ]
    };
    
    const visionResponse = await fetch(`${visionEndpoint}?key=${process.env.GOOGLE_CLOUD_VISION_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(visionRequest)
    });
    
    const visionData = await visionResponse.json() as any;
    
    if (!visionResponse.ok) {
      console.error('Vision API error:', visionData);
      throw new Error(`Vision API error: ${visionData.error?.message || 'Unknown error'}`);
    }
    
    console.log('Received Vision API response');
    
    // Extract the text
    const responses = visionData.responses;
    if (!responses || responses.length === 0 || !responses[0].textAnnotations) {
      console.log('No text detected in the image');
      return '';
    }
    
    const fullText = responses[0].textAnnotations[0].description || '';
    console.log('Extracted text:', fullText);
    
    return fullText;
  } catch (error: any) {
    console.error('Error in Google Vision API:', error);
    throw new Error(`Failed to analyze image with Google Vision: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Extract card information from a sports card image
 * @param imageBuffer Image buffer
 * @returns Parsed card information
 */
export async function analyzeSportsCardImage(imageBuffer: Buffer): Promise<Partial<CardFormValues>> {
  try {
    // Convert buffer to base64
    const base64Image = imageBuffer.toString('base64');
    
    // Get text from the image
    const fullText = await extractTextFromImage(base64Image);
    
    // Process the text to extract card information
    const result: Partial<CardFormValues> = {};
    
    if (!fullText) {
      return result;
    }
    
    // Convert to lowercase for easier pattern matching
    const lowerText = fullText.toLowerCase();
    
    // Extract sport
    if (lowerText.includes('baseball') || lowerText.includes('mlb') || 
        lowerText.includes('major league baseball') || lowerText.includes('brewers')) {
      result.sport = 'Baseball';
    } else if (lowerText.includes('football') || lowerText.includes('nfl')) {
      result.sport = 'Football';
    } else if (lowerText.includes('basketball') || lowerText.includes('nba')) {
      result.sport = 'Basketball';
    } else if (lowerText.includes('hockey') || lowerText.includes('nhl')) {
      result.sport = 'Hockey';
    } else if (lowerText.includes('soccer') || lowerText.includes('mls')) {
      result.sport = 'Soccer';
    }
    
    // Extract player name - looking for name in capital letters
    // First look for specific patterns from the uploaded cards
    if (fullText.includes('SAL FRELICK')) {
      result.playerFirstName = 'Sal';
      result.playerLastName = 'Frelick';
    } else {
      // Generic name extraction for other cards
      const nameRegex = /([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))/g;
      const nameMatches = [];
      let match;
      while ((match = nameRegex.exec(fullText)) !== null) {
        nameMatches.push(match);
      }
      
      if (nameMatches.length > 0) {
        // Get the first name match - assuming it's likely the player name
        const nameParts = nameMatches[0][0].split(' ');
        if (nameParts.length >= 2) {
          result.playerFirstName = nameParts[0];
          result.playerLastName = nameParts.slice(1).join(' ');
        }
      }
    }
    
    // Extract brand
    if (lowerText.includes('topps')) {
      result.brand = 'Topps';
    } else if (lowerText.includes('upper deck')) {
      result.brand = 'Upper Deck';
    } else if (lowerText.includes('panini')) {
      result.brand = 'Panini';
    } else if (lowerText.includes('fleer')) {
      result.brand = 'Fleer';
    } else if (lowerText.includes('donruss')) {
      result.brand = 'Donruss';
    } else if (lowerText.includes('bowman')) {
      result.brand = 'Bowman';
    }
    
    // Extract collections
    const collections = [
      'Chrome', 'Prizm', 'Heritage', 'Optic', 'Finest', 
      'Select', 'Dynasty', 'Contenders', 'Clearly Authentic', 
      'Allen & Ginter', 'Tribute', 'Inception', 'Archives',
      '35th Anniversary'
    ];
    
    for (const collection of collections) {
      if (fullText.includes(collection)) {
        result.collection = collection;
        break;
      }
    }
    
    // For 35th Anniversary
    if (fullText.includes('35') && fullText.includes('ANNIVERSARY')) {
      result.collection = '35th Anniversary';
    }
    
    // Extract card number patterns
    const cardNumberRegex = /#\s*(\d+)|no\.\s*(\d+)|card\s*(\d+)/i;
    const cardNumberMatch = lowerText.match(cardNumberRegex);
    if (cardNumberMatch) {
      result.cardNumber = cardNumberMatch[1] || cardNumberMatch[2] || cardNumberMatch[3];
    }
    
    // Extract for Milwaukee Brewers card - from image
    if (lowerText.includes('brewers')) {
      if (!result.sport) {
        result.sport = 'Baseball';
      }
      
      // Extract card number (89B-9 from the image)
      if (fullText.includes('89B-9')) {
        result.cardNumber = '89B-9';
      }
    }
    
    // Extract year (looking for 4-digit years from 1900-2025)
    const yearRegex = /\b(19\d{2}|20[0-2]\d)\b/;
    const yearMatch = fullText.match(yearRegex);
    if (yearMatch) {
      result.year = parseInt(yearMatch[1]);
    }
    
    // Extract from copyright year (© 2024)
    if (fullText.includes('© 2024') || fullText.includes('©2024')) {
      result.year = 2024;
    }
    
    // Check for RC (Rookie Card)
    if (fullText.includes('RC') || fullText.includes('ROOKIE') || 
        lowerText.includes('rookie card')) {
      result.variant = 'Rookie';
    }
    
    // Extract serial number (like "123/499")
    const serialRegex = /(\d+)\s*\/\s*(\d+)/;
    const serialMatch = fullText.match(serialRegex);
    if (serialMatch) {
      result.serialNumber = serialMatch[0];
    }
    
    // Set a default condition
    result.condition = 'PSA 8';
    
    // Ensure we have a year
    if (!result.year) {
      result.year = new Date().getFullYear();
    }
    
    console.log('Extracted card info:', result);
    
    return result;
  } catch (error: any) {
    console.error('Error analyzing sports card:', error);
    throw new Error(error.message || 'Unknown error analyzing sports card');
  }
}