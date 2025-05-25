import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

interface CardImageOverride {
  id: number;
  playerName: string;
  frontImage: string;
  backImage: string;
}

/**
 * Handle special case cards that need direct image overrides
 */
export async function handleSpecialCardImages(req: Request, res: Response, id: number, side: string): Promise<boolean> {
  // Hard-coded image overrides for problematic cards
  const specialCards: CardImageOverride[] = [
    {
      id: 31, // Bobby Thigpen
      playerName: 'Bobby Thigpen',
      frontImage: '/uploads/1748182904641_Thigpen_front.jpg',
      backImage: '/uploads/1748182904644_Thigpen_back.jpg'
    },
    {
      id: 32, // Chris James
      playerName: 'Chris James',
      frontImage: '/uploads/1748183726973_James_front.jpg',
      backImage: '/uploads/1748183726976_James_back.jpg'
    }
  ];

  // Find if this card has special handling
  const specialCard = specialCards.find(card => card.id === id);
  if (!specialCard) {
    return false; // Not a special card, continue with normal processing
  }

  // Determine the image path based on side
  const imagePath = side === 'front' ? specialCard.frontImage : specialCard.backImage;
  
  // Convert the relative path to an absolute path
  const filePath = path.join(process.cwd(), imagePath);
  
  // Check if the file exists
  if (fs.existsSync(filePath)) {
    console.log(`Special handling: Serving ${side} image for ${specialCard.playerName} (ID: ${id}): ${imagePath}`);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(filePath);
    return true; // Handled by this function
  }
  
  // File doesn't exist
  console.log(`Special handling: Image file not found for ${specialCard.playerName}: ${filePath}`);
  return false; // Let the regular handler try
}