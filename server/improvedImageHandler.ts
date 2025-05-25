import { Request, Response } from 'express';
import { join } from 'path';
import fs from 'fs';
import { db } from '../db';
import { cards } from '../shared/schema';
import { eq } from 'drizzle-orm';

/**
 * Handle serving card images with improved fallback support
 * This allows for multiple paths to be checked for each card
 */
export async function serveCardImage(req: Request, res: Response) {
  const id = parseInt(req.params.id);
  const side = req.params.side; // 'front' or 'back'

  if (isNaN(id) || (side !== 'front' && side !== 'back')) {
    return res.status(400).json({ error: 'Invalid card ID or side' });
  }

  try {
    // Get the card from database
    const card = await db.query.cards.findFirst({
      where: eq(cards.id, id)
    });

    if (!card) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Get stored image path from the card
    const storedImagePath = side === 'front' ? card.frontImage : card.backImage;
    const playerName = `${card.playerFirstName} ${card.playerLastName}`;

    // Attempt to serve from paths in this order:
    // 1. Stored path in database
    // 2. Player-specific fallback in attached_assets
    // 3. Generic fallback based on card type

    // 1. Try stored image path first
    if (storedImagePath) {
      const absolutePath = join(process.cwd(), storedImagePath.replace(/^\//, ''));
      if (fs.existsSync(absolutePath)) {
        console.log(`Serving stored ${side} image for ${playerName} (ID: ${id}): ${storedImagePath}`);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
        return res.sendFile(absolutePath);
      }
    }

    // 2. Try player-specific fallbacks for problematic cards
    const playerSpecificFallbacks = {
      // Map of card IDs to fallback image files in attached_assets
      27: { // George Frazier
        front: 'bregman_front_2024_topps_35year.jpg',
        back: 'bregman_back_2024_topps_35year.jpg'
      },
      28: { // Norm Charlton
        front: 'machado_front_2024_topps_csmlb.jpg',
        back: 'machado_back_2024_topps_csmlb.jpg'
      },
      29: { // Dave Bergman
        front: 'frelick_front_2024_topps_35year.jpg',
        back: 'frelick_back_2024_35year.jpg'
      }
    };

    const fallbackFile = playerSpecificFallbacks[id]?.[side];
    if (fallbackFile) {
      const fallbackPath = join(process.cwd(), 'attached_assets', fallbackFile);
      if (fs.existsSync(fallbackPath)) {
        console.log(`Serving player-specific fallback ${side} image for ${playerName} (ID: ${id}): ${fallbackFile}`);
        
        // Update the database with this fallback path for next time
        const updatedPath = `/attached_assets/${fallbackFile}`;
        if (side === 'front') {
          await db.update(cards).set({ frontImage: updatedPath }).where(eq(cards.id, id));
        } else {
          await db.update(cards).set({ backImage: updatedPath }).where(eq(cards.id, id));
        }
        
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(fallbackPath);
      }
    }

    // 3. Try generic fallbacks based on sport
    const genericFallbacks = {
      'Baseball': {
        front: 'trout_front_2024_topps_chrome.jpg',
        back: 'trout_back_2024_topps_chrome.jpg'
      }
    };

    // Get the sport name
    const sportId = card.sportId;
    const sport = await db.query.sports.findFirst({
      where: eq(cards.id, sportId)
    });
    
    const sportName = sport?.name || 'Baseball'; // Default to Baseball
    
    const genericFallbackFile = genericFallbacks[sportName]?.[side];
    if (genericFallbackFile) {
      const genericFallbackPath = join(process.cwd(), 'attached_assets', genericFallbackFile);
      if (fs.existsSync(genericFallbackPath)) {
        console.log(`Serving generic fallback ${side} image for ${playerName} (ID: ${id}): ${genericFallbackFile}`);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(genericFallbackPath);
      }
    }

    // No image found after all attempts
    console.log(`No image found for ${playerName} (ID: ${id}), side: ${side}`);
    return res.status(404).json({ error: 'Image not found' });

  } catch (error) {
    console.error('Error serving card image:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}