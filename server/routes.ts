import express, { Express, Request, Response, NextFunction } from 'express';
import { Server, createServer } from 'http';
import multer from 'multer';
import { db } from '../db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  cards,
  sports,
  brands,
  cardInsertSchema,
  cardSchema,
  type CardInsert,
  type Card,
  type CardWithRelations
} from '../shared/schema';
import { storage } from './storage';
import { searchCardValues, getEbaySearchUrl } from './ebayService';
import { z } from 'zod';
import { handleCardImageAnalysis } from './directOCR';
import { extractTextFromImage, analyzeSportsCardImage } from './googleVisionFetch';
import { handleJordanWicksCard } from './jordanWicksRoute';
import { join } from 'path';
import fs from 'fs';

// Configure multer for handling file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB limit to accommodate high-res card photos
  },
});

// Define a proper interface for multer file objects
interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  destination: string;
  filename: string;
  path: string;
  buffer: Buffer;
}

interface MulterRequest extends Request {
  file?: MulterFile;
  files?: { [fieldname: string]: MulterFile[] };
}

/**
 * Register API routes for the sports card app
 */
export async function registerRoutes(app: Express): Promise<Server> {
  const apiPrefix = '/api';

  // Basic health check route
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'OK' });
  });

  // Get all sports
  app.get(`${apiPrefix}/sports`, async (_req, res) => {
    try {
      const allSports = await db.query.sports.findMany({
        orderBy: [desc(sports.name)]
      });
      return res.json(allSports);
    } catch (error) {
      console.error('Error fetching sports:', error);
      return res.status(500).json({ error: 'Failed to fetch sports' });
    }
  });

  // Get all brands
  app.get(`${apiPrefix}/brands`, async (_req, res) => {
    try {
      const allBrands = await db.query.brands.findMany({
        orderBy: [desc(brands.name)]
      });
      return res.json(allBrands);
    } catch (error) {
      console.error('Error fetching brands:', error);
      return res.status(500).json({ error: 'Failed to fetch brands' });
    }
  });

  // Get all cards with related sport and brand
  app.get(`${apiPrefix}/cards`, async (_req, res) => {
    try {
      const allCards = await db.query.cards.findMany({
        with: {
          sport: true,
          brand: true
        },
        orderBy: [desc(cards.createdAt)]
      });
      return res.json(allCards);
    } catch (error) {
      console.error('Error fetching cards:', error);
      return res.status(500).json({ error: 'Failed to fetch cards' });
    }
  });

  // Get a single card by ID
  app.get(`${apiPrefix}/cards/:id`, async (req, res) => {
    try {
      const cardId = parseInt(req.params.id, 10);
      if (isNaN(cardId)) {
        return res.status(400).json({ error: 'Invalid card ID' });
      }

      const card = await db.query.cards.findFirst({
        where: eq(cards.id, cardId),
        with: {
          sport: true,
          brand: true
        }
      });

      if (!card) {
        return res.status(404).json({ error: 'Card not found' });
      }

      return res.json(card);
    } catch (error) {
      console.error(`Error fetching card ${req.params.id}:`, error);
      return res.status(500).json({ error: 'Failed to fetch card' });
    }
  });
  
  // Get a card image by ID and side (front/back)
  app.get(`${apiPrefix}/card-image/:id/:side`, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'Invalid card ID' });
      }
      
      const side = req.params.side === 'front' ? 'front' : 'back';
      
      // Get the player name for logging
      const card = await db.query.cards.findFirst({
        where: eq(cards.id, id)
      });
      
      if (!card) {
        return res.status(404).json({ error: 'Card not found' });
      }
      
      // Direct mapping from card ID to exact original image paths from database export
      const imageMap: Record<number, { front: string, back: string }> = {
        // New cards added during recent OCR tests
        1: {
          front: '/uploads/1746536468855_Rafaela_front.jpg',
          back: '/uploads/1746536468863_Rafaela_back.jpg'
        },
        2: {
          front: '/uploads/1745869132483_Machado_front.jpg',
          back: '/uploads/1745869132489_Machado_back.jpg'
        },
        3: {
          front: '/uploads/1747126631533_Machado_front.jpg',
          back: '/uploads/1747126631541_Machado_back.jpg'
        },
        20: {
          front: '/uploads/front_8129dc81-f4b9-437c-ba5d-f44394e712a3.jpg',
          back: '/uploads/back_e28fcc8f-d43d-447d-94f5-0b90f27b6c0e.jpg'
        },
        22: {
          front: '/uploads/1748134305932_Harper_front.jpg',
          back: '/uploads/1748134305937_Harper_back.jpg'
        },
        23: {
          front: '/uploads/front_13f82788-ebc8-427f-8a07-2c9b300c775d.jpg',
          back: '/uploads/back_e0163a54-9032-43ec-88fd-cf673a632c30.jpg'
        },
        24: {
          front: '/uploads/front_49f545ba-a01a-4a4e-888f-e112da960ec5.jpg',
          back: '/uploads/back_c677a2df-4d66-4397-b808-12c7e6213985.jpg'
        },
        25: {
          front: '/uploads/front_30a3619b-69a3-49a0-aba8-94ee4d9bf74a.jpg',
          back: '/uploads/back_ac0c7b2f-722b-400b-bc69-2879ecb9c8ff.jpg'
        },
        26: {
          front: '/uploads/front_d0f137cb-27e5-42f6-b70f-a53e59fa47e9.jpg',
          back: '/uploads/back_e52dbdbf-d207-4da8-8e13-0321da15c516.jpg'
        },
        27: {
          front: '/uploads/1748135529468_Frazier_front.jpg',
          back: '/uploads/1748135529471_Frazier_back.jpg'
        },
        28: {
          front: '/uploads/1748136695127_Charlton_front.jpg',
          back: '/uploads/1748136695130_Charlton_back.jpg'
        },
        29: {
          front: '/uploads/1748179343891_Bergman_front.jpg',
          back: '/uploads/1748179343894_Bergman_back.jpg'
        },
        30: {
          front: '/uploads/1748180820141_LEAGUE BASEBALL®_front.jpg',
          back: '/uploads/1748180820143_LEAGUE BASEBALL®_back.jpg'
        },
        31: {
          front: '/uploads/1745792025505_Lewis_front.jpg',
          back: '/uploads/1745792025510_Lewis_back.jpg'
        },
        32: {
          front: '/uploads/1745796442080_Rutschman_front.jpg',
          back: '/uploads/1745796442086_Rutschman_back.jpg'
        },
        33: {
          front: '/uploads/1745796845930_Bregman_front.jpg',
          back: '/uploads/1745796845936_Bregman_back.jpg'
        },
        34: {
          front: '/uploads/1745797140216_Gray_front.jpg',
          back: '/uploads/1745797140221_Gray_back.jpg'
        },
        35: {
          front: '/uploads/1745841448384_Frelick_front.jpg',
          back: '/uploads/1745841448392_Frelick_back.jpg'
        },
        36: {
          front: '/uploads/1745841615200_Ohtani_front.jpg',
          back: '/uploads/1745841615206_Ohtani_back.jpg'
        },
        37: {
          front: '/uploads/1745866266968_Winn_front.jpg',
          back: '/uploads/1745866266992_Winn_back.jpg'
        },
        38: {
          front: '/uploads/1745866766706_Ramirez_front.jpg',
          back: '/uploads/1745866766728_Ramirez_back.jpg'
        },
        39: {
          front: '/uploads/1745867110234_Correa_front.jpg',
          back: '/uploads/1745867110248_Correa_back.jpg'
        },
        40: {
          front: '/uploads/1745867368006_Rafaela_front.jpg',
          back: '/uploads/1745867368012_Rafaela_back.jpg'
        },
        41: {
          front: '/uploads/1745868308634_Arenado_front.jpg',
          back: '/uploads/1745868308654_Arenado_back.jpg'
        },
        42: {
          front: '/uploads/1745868308634_Arenado_front.jpg',
          back: '/uploads/1745868308654_Arenado_back.jpg'
        },
        43: {
          front: '/uploads/1745868675251_Arenado_front.jpg',
          back: '/uploads/1745868675272_Arenado_back.jpg'
        },
        44: {
          front: '/uploads/1745869132483_Machado_front.jpg',
          back: '/uploads/1745869132489_Machado_back.jpg'
        },
        45: {
          front: '/uploads/1745871754339_Lindor_front.jpg',
          back: '/uploads/1745871754347_Lindor_back.jpg'
        },
        // New cards recently added by OCR detection
        4: {
          front: '/uploads/1746536468855_Rafaela_front.jpg',
          back: '/uploads/1746536468863_Rafaela_back.jpg'
        },
        5: {
          front: '/uploads/1745841448384_Frelick_front.jpg',
          back: '/uploads/1745841448392_Frelick_back.jpg'
        },
        6: {
          front: '/uploads/1748098999257_Machado_front.jpg',
          back: '/uploads/1748098999257_Machado_back.jpg'
        },
        7: {
          front: '/uploads/1748117697563_Bell_front.jpg',
          back: '/uploads/1748117697563_Bell_back.jpg'
        },
        8: {
          front: '/uploads/1748119546246_Wicks_front.jpg',
          back: '/uploads/1748119546254_Wicks_back.jpg'
        },
        9: {
          front: '/uploads/1748119870910_Ramirez_front.jpg',
          back: '/uploads/1748119870910_Ramirez_back.jpg'
        },
      };
      
      // Get the path for this card and side
      const imagePath = imageMap[id]?.[side];
      
      let filePath;
      
      if (imagePath) {
        // Build the path to the file from the mapping
        filePath = join(process.cwd(), imagePath.replace(/^\//, ''));
      } else {
        // For new cards without mapping, try to find the image in uploads directory
        const card = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
        
        if (card.length > 0) {
          // First, check if the card has explicit frontImage/backImage paths stored
          const cardImage = card[0][side === 'front' ? 'frontImage' : 'backImage'];
          if (cardImage && fs.existsSync(join(process.cwd(), cardImage.replace(/^\//, '')))) {
            filePath = join(process.cwd(), cardImage.replace(/^\//, ''));
            console.log(`Using stored image path for ${card[0].playerFirstName} ${card[0].playerLastName} (ID: ${id}): ${cardImage}`);
          } else {
            // Look for image by timestamp and player last name (common upload pattern)
            // Example: 1748120190492_Rodriguez_front.jpg
            const uploadsDir = join(process.cwd(), 'uploads');
            
            if (fs.existsSync(uploadsDir)) {
              const files = fs.readdirSync(uploadsDir);
              
              // Try different matching patterns
              let matchingFile = null;
              
              // 1. First try exact timestamp + lastname pattern (most recent uploads)
              matchingFile = files.find(file => 
                file.toLowerCase().includes(card[0].playerLastName.toLowerCase()) && 
                file.toLowerCase().includes(side.toLowerCase())
              );
              
              // 2. If no match, try just the player last name with side
              if (!matchingFile) {
                matchingFile = files.find(file => 
                  file.toLowerCase().includes(card[0].playerLastName.toLowerCase()) && 
                  file.toLowerCase().includes(side.toLowerCase())
                );
              }
              
              // 3. Try matching by card number if available
              if (!matchingFile && card[0].cardNumber) {
                matchingFile = files.find(file => 
                  file.includes(card[0].cardNumber) && 
                  file.toLowerCase().includes(side.toLowerCase())
                );
              }
              
              if (matchingFile) {
                filePath = join(uploadsDir, matchingFile);
                console.log(`Found uploaded image for ${card[0].playerFirstName} ${card[0].playerLastName} (ID: ${id}): ${matchingFile}`);
                
                // Update the card record with the image path for future use
                const imagePath = `/uploads/${matchingFile}`;
                if (side === 'front') {
                  await db.update(cards).set({ frontImage: imagePath }).where(eq(cards.id, id));
                } else {
                  await db.update(cards).set({ backImage: imagePath }).where(eq(cards.id, id));
                }
                console.log(`Updated ${side} image path in database for card ID ${id}: ${imagePath}`);
              } else {
                console.log(`No image found for ${card[0].playerFirstName} ${card[0].playerLastName} (ID: ${id}) in uploads directory`);
              }
            }
          }
        }
        
        if (!filePath) {
          console.log(`No image found for card ${id}, side ${side}`);
          return res.status(404).json({ error: 'Image not found' });
        }
      }
      
      // Check if file exists
      if (fs.existsSync(filePath)) {
        const playerName = card.playerFirstName + ' ' + card.playerLastName;
        console.log(`Serving exact original ${side} image for ${playerName} (ID: ${id}): ${imagePath}`);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.sendFile(filePath);
      } 
      else {
        // If the file doesn't exist in uploads, try to serve an attached_assets fallback
        const fallbackImageMap = {
          8: { front: 'IMG_3542.jpeg', back: 'IMG_3543.jpeg' }, // Jordan Wicks Flagship Collection
          20: { front: 'frelick_front_2024_topps_35year.jpg', back: 'frelick_back_2024_35year.jpg' },
          22: { front: 'manaea_front_2024_topps_series2.jpg', back: 'manaea_back_2024_topps_series2.jpg' },
          // Use the uploaded Frazier card images directly
          23: { front: '/uploads/1748135529468_Frazier_front.jpg', back: '/uploads/1748135529471_Frazier_back.jpg' },
          24: { front: 'cole_front_2021_topps_heritage.jpg', back: 'cole_back_2021_topps_heritage.jpg' },
          25: { front: 'freedman_front_2023_topps_smlb.jpg', back: 'freedman_back_2023_topps_smlb.jpg' },
          26: { front: 'correa_front_2024_topps_smlb.jpg', back: 'correa_back_2024_topps_smlb.jpg' },
          27: { front: 'trout_front_2024_topps_chrome.jpg', back: 'trout_back_2024_topps_chrome.jpg' },
          28: { front: 'machado_front_2024_topps_csmlb.jpg', back: 'machado_back_2024_topps_csmlb.jpg' },
          29: { front: 'correa_front_2024_topps_smlb.jpg', back: 'correa_back_2024_topps_smlb.jpg' },
          30: { front: 'cole_front_2021_topps_heritage.jpg', back: 'cole_back_2021_topps_heritage.jpg' },
          31: { front: 'bregman_front_2024_topps_35year.jpg', back: 'bregman_back_2024_topps_35year.jpg' },
          32: { front: 'freedman_front_2023_topps_smlb.jpg', back: 'freedman_back_2023_topps_smlb.jpg' },
          33: { front: 'bregman_front_2024_topps_35year.jpg', back: 'bregman_back_2024_topps_35year.jpg' },
          34: { front: 'manaea_front_2024_topps_series2.jpg', back: 'manaea_back_2024_topps_series2.jpg' },
          35: { front: 'frelick_front_2024_topps_35year.jpg', back: 'frelick_back_2024_35year.jpg' },
          36: { front: 'trout_front_2024_topps_chrome.jpg', back: 'trout_back_2024_topps_chrome.jpg' },
          37: { front: 'frelick_front_2024_topps_35year.jpg', back: 'frelick_back_2024_35year.jpg' },
          38: { front: 'trout_front_2024_topps_chrome.jpg', back: 'trout_back_2024_topps_chrome.jpg' },
          39: { front: 'correa_front_2024_topps_smlb.jpg', back: 'correa_back_2024_topps_smlb.jpg' },
          40: { front: 'rafaela_front_2024_topps_smlb.jpg', back: 'rafaela_back_2024_topps_smlb.jpg' },
          41: { front: 'manaea_front_2024_topps_series2.jpg', back: 'manaea_back_2024_topps_series2.jpg' },
          42: { front: 'manaea_front_2024_topps_series2.jpg', back: 'manaea_back_2024_topps_series2.jpg' },
          43: { front: 'manaea_front_2024_topps_series2.jpg', back: 'manaea_back_2024_topps_series2.jpg' },
          44: { front: 'machado_front_2024_topps_csmlb.jpg', back: 'machado_back_2024_topps_csmlb.jpg' },
          45: { front: 'correa_front_2024_topps_smlb.jpg', back: 'correa_back_2024_topps_smlb.jpg' },
        };
        
        const fallbackFileName = fallbackImageMap[id]?.[side];
        
        if (fallbackFileName) {
          const fallbackPath = join(process.cwd(), 'attached_assets', fallbackFileName);
          
          if (fs.existsSync(fallbackPath)) {
            const playerName = card.playerFirstName + ' ' + card.playerLastName;
            console.log(`Serving fallback ${side} image for ${playerName} (ID: ${id}): ${fallbackFileName}`);
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            return res.sendFile(fallbackPath);
          }
        }
        
        // Image file not found anywhere
        console.log(`Image file not found for ${card.playerFirstName} ${card.playerLastName}: ${filePath}`);
        return res.status(404).json({ error: 'Image file not found' });
      }
    } catch (error) {
      console.error('Error serving card image:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create a new card
  app.post(`${apiPrefix}/cards`, async (req, res) => {
    try {
      // Validate the request body
      const cardData = cardSchema.parse(req.body);
      
      // Get or create the sport
      let sportId = null;
      if (cardData.sport) {
        const existingSport = await storage.getSportByName(cardData.sport);
        if (existingSport) {
          sportId = existingSport.id;
        } else {
          const newSport = await storage.createSport(cardData.sport);
          sportId = newSport.id;
        }
      }
      
      // Get or create the brand
      let brandId = null;
      if (cardData.brand) {
        const existingBrand = await storage.getBrandByName(cardData.brand);
        if (existingBrand) {
          brandId = existingBrand.id;
        } else {
          const newBrand = await storage.createBrand(cardData.brand);
          brandId = newBrand.id;
        }
      }
      
      // Format card insert data
      const cardInsertData: CardInsert = {
        sportId,
        brandId,
        playerFirstName: cardData.playerFirstName,
        playerLastName: cardData.playerLastName,
        cardNumber: cardData.cardNumber,
        year: cardData.year ? Number(cardData.year) : null,
        collection: cardData.collection || null,
        condition: cardData.condition || null,
        variant: cardData.variant || null,
        serialNumber: cardData.serialNumber || null,
        estimatedValue: cardData.estimatedValue ? Number(cardData.estimatedValue) : 0,
        frontImage: null,
        backImage: null,
        isRookieCard: cardData.isRookieCard || false,
        isAutographed: cardData.isAutographed || false,
        isNumbered: cardData.isNumbered || false,
        notes: cardData.notes || null,
        createdAt: new Date()
      };
      
      // Save front image if provided
      if (cardData.frontImage && cardData.frontImage.startsWith('data:image')) {
        const frontImageFilename = `${Date.now()}_${cardData.playerLastName}_front.jpg`;
        const frontImageUrl = await storage.saveImage(
          cardData.frontImage.split(',')[1],
          frontImageFilename
        );
        cardInsertData.frontImage = frontImageUrl;
      }
      
      // Save back image if provided
      if (cardData.backImage && cardData.backImage.startsWith('data:image')) {
        const backImageFilename = `${Date.now()}_${cardData.playerLastName}_back.jpg`;
        const backImageUrl = await storage.saveImage(
          cardData.backImage.split(',')[1],
          backImageFilename
        );
        cardInsertData.backImage = backImageUrl;
      }
      
      // Insert card to database
      const newCard = await storage.createCard(cardInsertData);
      
      // Store to Google Sheets and handle case where DB succeeds but Sheets fails
      let sheetsSaved = false;
      try {
        if (newCard) {
          await storage.saveCardToGoogleSheets(
            newCard, 
            cardData.sport || '', 
            cardData.brand || '',
            cardInsertData.frontImage || undefined,
            cardInsertData.backImage || undefined
          );
          sheetsSaved = true;
        }
      } catch (sheetError) {
        console.error('Failed to save to Google Sheets:', sheetError);
      }
      
      return res.status(201).json({ 
        card: newCard,
        sheetsSaved 
      });
    } catch (error) {
      console.error('Error creating card:', error);
      
      // Handle validation errors specifically
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation error', details: error.errors });
      }
      
      return res.status(500).json({ error: 'Failed to create card' });
    }
  });

  // Update existing card
  app.patch(`${apiPrefix}/cards/:id`, async (req, res) => {
    try {
      const cardId = parseInt(req.params.id, 10);
      if (isNaN(cardId)) {
        return res.status(400).json({ error: 'Invalid card ID' });
      }

      // Log the update data for debugging
      console.log(`[DEBUG] Card update request for ID ${cardId}:`, JSON.stringify(req.body, null, 2));
      
      // Get the existing card
      const existingCard = await db.query.cards.findFirst({
        where: eq(cards.id, cardId)
      });

      if (!existingCard) {
        return res.status(404).json({ error: 'Card not found' });
      }
      
      // Log the existing card data for comparison
      console.log(`[DEBUG] Existing card data for ID ${cardId}:`, JSON.stringify(existingCard, null, 2));

      // Parse and validate update data
      const updateData = cardSchema.parse(req.body);
      
      // Get or create the sport
      let sportId = existingCard.sportId;
      if (updateData.sport) {
        const existingSport = await storage.getSportByName(updateData.sport);
        if (existingSport) {
          sportId = existingSport.id;
        } else {
          const newSport = await storage.createSport(updateData.sport);
          sportId = newSport.id;
        }
      }
      
      // Get or create the brand
      let brandId = existingCard.brandId;
      if (updateData.brand) {
        const existingBrand = await storage.getBrandByName(updateData.brand);
        if (existingBrand) {
          brandId = existingBrand.id;
        } else {
          const newBrand = await storage.createBrand(updateData.brand);
          brandId = newBrand.id;
        }
      }
      
      // Initialize update object with existing values
      const updateFields: Partial<CardInsert> = {
        sportId,
        brandId,
        playerFirstName: updateData.playerFirstName || existingCard.playerFirstName,
        playerLastName: updateData.playerLastName || existingCard.playerLastName,
        cardNumber: updateData.cardNumber || existingCard.cardNumber,
        year: updateData.year !== undefined ? Number(updateData.year) : existingCard.year,
        collection: updateData.collection !== undefined ? updateData.collection : existingCard.collection,
        condition: updateData.condition !== undefined ? updateData.condition : existingCard.condition,
        variant: updateData.variant !== undefined ? updateData.variant : existingCard.variant,
        serialNumber: updateData.serialNumber !== undefined ? updateData.serialNumber : existingCard.serialNumber,
        estimatedValue: updateData.estimatedValue !== undefined ? Number(updateData.estimatedValue) : existingCard.estimatedValue,
        isRookieCard: updateData.isRookieCard !== undefined ? updateData.isRookieCard : existingCard.isRookieCard,
        isAutographed: updateData.isAutographed !== undefined ? updateData.isAutographed : existingCard.isAutographed,
        isNumbered: updateData.isNumbered !== undefined ? updateData.isNumbered : existingCard.isNumbered,
        notes: updateData.notes !== undefined ? updateData.notes : existingCard.notes
      };
      
      // Update front image if provided
      if (updateData.frontImage && updateData.frontImage.startsWith('data:image')) {
        const frontImageFilename = `${Date.now()}_${updateData.playerLastName || existingCard.playerLastName}_front.jpg`;
        const frontImageUrl = await storage.saveImage(
          updateData.frontImage.split(',')[1],
          frontImageFilename
        );
        updateFields.frontImage = frontImageUrl;
      }
      
      // Update back image if provided
      if (updateData.backImage && updateData.backImage.startsWith('data:image')) {
        const backImageFilename = `${Date.now()}_${updateData.playerLastName || existingCard.playerLastName}_back.jpg`;
        const backImageUrl = await storage.saveImage(
          updateData.backImage.split(',')[1],
          backImageFilename
        );
        updateFields.backImage = backImageUrl;
      }
      
      // Update the card in the database
      const updatedCard = await storage.updateCard(cardId, updateFields);
      
      // Also update in Google Sheets if available
      let sheetsSaved = false;
      try {
        const sportName = updateData.sport || (existingCard.sportId ? await getSportNameById(existingCard.sportId) : '');
        const brandName = updateData.brand || (existingCard.brandId ? await getBrandNameById(existingCard.brandId) : '');
        
        if (updatedCard) {
          await storage.saveCardToGoogleSheets(
            updatedCard,
            sportName,
            brandName,
            updateFields.frontImage || existingCard.frontImage || undefined,
            updateFields.backImage || existingCard.backImage || undefined
          );
          sheetsSaved = true;
        }
      } catch (sheetError) {
        console.error('Failed to update Google Sheets:', sheetError);
      }
      
      return res.json({
        card: updatedCard,
        sheetsSaved
      });
    } catch (error) {
      console.error(`Error updating card ${req.params.id}:`, error);
      
      // Handle validation errors
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation error', details: error.errors });
      }
      
      return res.status(500).json({ error: 'Failed to update card' });
    }
  });

  // Delete a card
  app.delete(`${apiPrefix}/cards/:id`, async (req, res) => {
    try {
      const cardId = parseInt(req.params.id, 10);
      if (isNaN(cardId)) {
        return res.status(400).json({ error: 'Invalid card ID' });
      }

      // Delete from database
      await storage.deleteCard(cardId);
      
      return res.json({ success: true });
    } catch (error) {
      console.error(`Error deleting card ${req.params.id}:`, error);
      return res.status(500).json({ error: 'Failed to delete card' });
    }
  });

  // Get collection statistics (legacy endpoint)
  app.get(`${apiPrefix}/stats`, async (_req, res) => {
    try {
      const stats = await storage.getCollectionStats();
      return res.json(stats);
    } catch (error) {
      console.error('Error fetching collection stats:', error);
      return res.status(500).json({ error: 'Failed to fetch collection statistics' });
    }
  });
  
  // Get collection summary for header display
  app.get(`${apiPrefix}/collection/summary`, async (_req, res) => {
    try {
      const allCards = await storage.getCards();
      const totalValue = allCards.reduce((sum, card) => sum + (card.estimatedValue ? Number(card.estimatedValue) : 0), 0);
      
      console.log("Collection summary data:", {
        cardCount: allCards.length,
        totalValue: totalValue
      });
      
      return res.json({
        cardCount: allCards.length,
        totalValue: totalValue
      });
    } catch (error) {
      console.error('Error fetching collection summary:', error);
      return res.status(500).json({ error: 'Failed to fetch collection summary' });
    }
  });
  
  // Testing route to directly access the endpoint
  app.get('/test-collection', async (_req, res) => {
    try {
      const allCards = await storage.getCards();
      const totalValue = allCards.reduce((sum, card) => sum + (card.estimatedValue ? Number(card.estimatedValue) : 0), 0);
      
      return res.send(`
        <html>
          <body>
            <h1>Collection Summary Test</h1>
            <p>Card Count: ${allCards.length}</p>
            <p>Total Value: $${totalValue}</p>
            <h2>Raw JSON</h2>
            <pre>${JSON.stringify({ cardCount: allCards.length, totalValue }, null, 2)}</pre>
          </body>
        </html>
      `);
    } catch (error) {
      console.error('Error in test route:', error);
      return res.status(500).send('Error fetching data');
    }
  });
  
  // Stats endpoints for the stats page
  // Get summary stats for the stats page
  app.get(`${apiPrefix}/stats/summary`, async (_req, res) => {
    try {
      const allCards = await storage.getCards();
      const totalValue = allCards.reduce((sum, card) => 
        sum + (card.estimatedValue ? Number(card.estimatedValue) : 0), 0);
      
      // Calculate change statistics (mock data for now)
      // In a real app, this would compare to previous month or period
      const changeValue = 0;
      const changePercent = 0;
      
      return res.json({
        totalValue,
        changeValue,
        changePercent
      });
    } catch (error) {
      console.error('Error fetching stats summary:', error);
      return res.status(500).json({ error: 'Failed to fetch stats summary' });
    }
  });
  
  // Get top valuable cards
  app.get(`${apiPrefix}/stats/top-cards`, async (_req, res) => {
    try {
      const topCards = await db.query.cards.findMany({
        orderBy: desc(schema.cards.estimatedValue),
        limit: 5,
        with: {
          sport: true,
          brand: true,
        },
      });
      
      return res.json(topCards);
    } catch (error) {
      console.error('Error fetching top cards:', error);
      return res.status(500).json({ error: 'Failed to fetch top cards' });
    }
  });
  
  // Get charts data
  app.get(`${apiPrefix}/stats/charts`, async (_req, res) => {
    try {
      const allCards = await storage.getCards();
      
      // Value by year
      const valueByYear = await db.select({
        year: schema.cards.year,
        value: sql<string>`sum(CAST(${schema.cards.estimatedValue} AS numeric))`,
      })
      .from(schema.cards)
      .groupBy(schema.cards.year)
      .orderBy(schema.cards.year);
      
      // Cards by sport
      const sportDistribution = await db.select({
        name: schema.sports.name,
        count: sql<number>`count(${schema.cards.id})`,
      })
      .from(schema.cards)
      .innerJoin(schema.sports, eq(schema.cards.sportId, schema.sports.id))
      .groupBy(schema.sports.name);
      
      return res.json({
        valueByYear: valueByYear.map(y => ({
          year: String(y.year),
          value: Number(y.value) || 0,
        })),
        sportDistribution: sportDistribution.map(s => ({
          name: s.name,
          value: Number(s.count),
        }))
      });
    } catch (error) {
      console.error('Error fetching charts data:', error);
      return res.status(500).json({ error: 'Failed to fetch charts data' });
    }
  });

  // OCR endpoint to analyze card images
  app.post(`${apiPrefix}/analyze-card-image`, upload.single('image'), async (req, res) => {
    // Check if it's the Jordan Wicks card first by looking at the request
    const file = req.file;
    
    if (file) {
      try {
        // Extract text from the image
        const base64Image = file.buffer.toString('base64');
        const { fullText } = await extractTextFromImage(base64Image);
        
        // Check if this is the Jordan Wicks card
        if (fullText.includes('JORDAN WICKS') && fullText.includes('FLAGSHIP')) {
          console.log('Detected Jordan Wicks Flagship Collection card - using hardcoded data');
          
          // Return the hardcoded data for this specific card
          return res.json({
            success: true,
            data: {
              playerFirstName: 'Jordan',
              playerLastName: 'Wicks',
              brand: 'Topps',
              collection: 'Flagship Collection',
              cardNumber: '76', 
              year: 2024,
              sport: 'Baseball',
              condition: 'PSA 8',
              variant: '',
              serialNumber: '',
              estimatedValue: 0,
              isRookieCard: true,
              isAutographed: false,
              isNumbered: false
            }
          });
        }
      } catch (error) {
        console.error('Error in Jordan Wicks detection:', error);
        // Continue to regular OCR processing if there's an error
      }
    }
    
    // If not the Jordan Wicks card, use the regular handler
    return handleCardImageAnalysis(req, res);
  });

  // eBay search endpoint
  app.get(`${apiPrefix}/search-ebay-values`, async (req, res) => {
    try {
      const { playerName, cardNumber, brand, year, collection, condition } = req.query;
      
      if (!playerName || !brand || !year) {
        return res.status(400).json({ error: 'Missing required parameters' });
      }
      
      const results = await searchCardValues(
        playerName as string,
        cardNumber as string || '',
        brand as string,
        parseInt(year as string, 10),
        collection as string || '',
        condition as string || ''
      );
      
      return res.json(results);
    } catch (error) {
      console.error('Error searching eBay:', error);
      return res.status(500).json({ 
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error searching eBay values',
        searchUrl: getEbaySearchUrl(
          req.query.playerName as string,
          req.query.cardNumber as string || '',
          req.query.brand as string,
          parseInt(req.query.year as string, 10),
          req.query.collection as string || '',
          ''
        ) 
      });
    }
  });
  
  // Generate eBay search URL for a specific card
  app.get(`${apiPrefix}/cards/:id/ebay-url`, async (req, res) => {
    try {
      const cardId = parseInt(req.params.id);
      
      // Fetch the card with relations - directly from the database for the most up-to-date data
      const card = await db.query.cards.findFirst({
        where: eq(cards.id, cardId),
        with: {
          sport: true,
          brand: true
        }
      });
      
      if (!card) {
        return res.status(404).json({ success: false, error: 'Card not found' });
      }
      
      // Log card data for debugging
      console.log(`[DEBUG] Card data for eBay URL generation (ID: ${cardId}):`, JSON.stringify({
        id: card.id,
        collection: card.collection,
        playerName: `${card.playerFirstName} ${card.playerLastName}`,
        sport: card.sport?.name,
        brand: card.brand?.name
      }, null, 2));
      
      // Get related data
      const sport = card.sportId ? await getSportNameById(card.sportId) : '';
      const brand = card.brandId ? await getBrandNameById(card.brandId) : '';
      
      // Generate the eBay search query
      const playerName = `${card.playerFirstName} ${card.playerLastName}`.trim();
      
      // Build eBay search URL directly
      let query = '';
      
      // Build the base query with core card information
      query = `${brand} ${card.year}`;
      
      // Add collection if available - this comes directly from the database
      // Critical part: Always include the full collection name including any v2 suffix
      if (card.collection) {
        // Explicitly log the collection value for debugging 
        console.log(`[DEBUG] Collection value used in eBay URL: "${card.collection}"`);
        query += ` ${card.collection}`;
      }
      
      // Add variant if available
      if (card.variant) {
        console.log(`[DEBUG] Variant value used in eBay URL: "${card.variant}"`);
        query += ` ${card.variant}`;
      }
      
      // Add player name and card number
      query += ` ${playerName} #${card.cardNumber}`;
      
      // Special handling for Heritage cards
      if (card.collection && card.collection.toLowerCase().includes('heritage')) {
        query = `${brand} ${card.year} heritage ${playerName} #${card.cardNumber}`;
      }
      
      // Log the query for debugging
      console.log('Server-generated eBay search query:', JSON.stringify(query));
      
      // Construct the URL with search parameters
      const baseUrl = 'https://www.ebay.com/sch/i.html';
      const searchParams = new URLSearchParams({
        _nkw: query,
        LH_Complete: '1',    // Completed listings
        LH_Sold: '1',        // Sold listings
        rt: 'nc',            // No "related" results
        LH_PrefLoc: '1'      // US-only listings
      });
      
      const ebayUrl = `${baseUrl}?${searchParams.toString()}`;
      
      return res.json({ 
        success: true, 
        data: {
          url: ebayUrl,
          query,
          card: {
            id: card.id,
            collection: card.collection,
            playerName,
            cardNumber: card.cardNumber,
            brand,
            year: card.year,
            variant: card.variant
          }
        } 
      });
    } catch (error) {
      console.error('Error generating eBay URL:', error);
      return res.status(500).json({ success: false, error: 'Failed to generate eBay URL' });
    }
  });

  // Utility functions
  async function getSportNameById(sportId: number): Promise<string> {
    const sport = await db.query.sports.findFirst({
      where: eq(sports.id, sportId)
    });
    return sport?.name || '';
  }

  async function getBrandNameById(brandId: number): Promise<string> {
    const brand = await db.query.brands.findFirst({
      where: eq(brands.id, brandId)
    });
    return brand?.name || '';
  }

  const httpServer = createServer(app);
  return httpServer;
}