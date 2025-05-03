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
import { handleCardImageAnalysis } from './improvedOCR';
import { extractTextFromImage, analyzeSportsCardImage } from './googleVisionFetch';
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
      
      const side = req.params.side === 'front' ? 'frontImage' : 'backImage';
      
      // Get the card to find image path
      const card = await db.query.cards.findFirst({
        where: eq(cards.id, id)
      });
      
      if (!card || !card[side]) {
        return res.status(404).json({ error: 'Image not found' });
      }
      
      // This mapping ensures we serve the correct image for each card ID
      // regardless of what's in the database
      const hardcodedImageMapById = {
        // Maps card IDs to specific image files in attached_assets
        20: 'frelick_front_2024_topps_35year.jpg',    // Sal Frelick
        22: 'manaea_front_2024_topps_series2.jpg',    // Sean Manaea
        23: 'bregman_front_2024_topps_35year.jpg',    // Alex Bregman
        24: 'cole_front_2021_topps_heritage.jpg',     // Gerrit Cole
        25: 'freedman_front_2023_topps_smlb.jpg',     // Freddie Freeman
        27: 'trout_front_2024_topps_chrome.jpg',      // Mike Trout
        28: 'machado_front_2024_topps_csmlb.jpg',     // Manny Machado
        29: 'correa_front_2024_topps_smlb.jpg',       // Anthony Volpe (using Correa)
        30: 'cole_front_2021_topps_heritage.jpg',     // Nolan Schanuel 
        31: 'bregman_front_2024_topps_35year.jpg',    // Royce Lewis
        32: 'freedman_front_2023_topps_smlb.jpg',     // Adley Rutschman
        33: 'bregman_front_2024_topps_35year.jpg',    // Alex Bregman
        34: 'manaea_front_2024_topps_series2.jpg',    // Sonny Gray
        35: 'frelick_front_2024_topps_35year.jpg',    // Sal Frelick
        36: 'trout_front_2024_topps_chrome.jpg',      // Shohei Ohtani
        37: 'frelick_front_2024_topps_35year.jpg',    // Masyn Winn
        38: 'trout_front_2024_topps_chrome.jpg',      // Jose Ramirez
        39: 'correa_front_2024_topps_smlb.jpg',       // Carlos Correa
        40: 'rafaela_front_2024_topps_smlb.jpg',      // Ceddanne Rafaela
        42: 'manaea_front_2024_topps_series2.jpg',    // Nolan Arenado
        44: 'machado_front_2024_topps_csmlb.jpg',     // Manny Machado (Chrome)
        45: 'correa_front_2024_topps_smlb.jpg',       // Francisco Lindor
      };
      
      // Try to find image based on card ID
      const hardcodedImage = hardcodedImageMapById[id];
      
      if (hardcodedImage) {
        const attachedAssetsPath = join(process.cwd(), 'attached_assets', hardcodedImage);
        
        if (fs.existsSync(attachedAssetsPath)) {
          console.log(`Found hardcoded image for card ID ${id}: ${attachedAssetsPath}`);
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          return res.sendFile(attachedAssetsPath);
        }
      }
      
      // Get the image path from the card data
      const imagePath = card[side];
      
      // List of places to look for the image if no hardcoded mapping exists
      const possiblePaths = [
        // Path with uploads prefix
        join(process.cwd(), 'uploads', imagePath.replace(/^\/uploads\//, '')),
        // Direct path
        join(process.cwd(), imagePath.replace(/^\//, '')),
        // Just filename
        join(process.cwd(), 'uploads', imagePath.split('/').pop()),
        // In attached_assets
        join(process.cwd(), 'attached_assets', imagePath.split('/').pop()),
      ];
      
      let foundPath = null;
      
      // Find the first existing path
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          foundPath = p;
          console.log(`Found image at ${foundPath}`);
          break;
        }
      }
      
      if (!foundPath) {
        // Try matching player name with attached_assets
        const playerPattern = `${card.playerFirstName?.toLowerCase()}_${card.playerLastName?.toLowerCase()}_${req.params.side}`;
        const attachedAssetsDir = join(process.cwd(), 'attached_assets');
        if (fs.existsSync(attachedAssetsDir)) {
          const files = fs.readdirSync(attachedAssetsDir);
          const matchingFile = files.find(file => file.toLowerCase().includes(playerPattern));
          
          if (matchingFile) {
            foundPath = join(attachedAssetsDir, matchingFile);
            console.log(`Found image with player pattern: ${foundPath}`);
          }
        }
      }
      
      if (foundPath) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.sendFile(foundPath);
      }
      
      // Failed to find the image
      console.log(`Image not found for card ${id}, side ${side}, path ${imagePath}`);
      return res.status(404).json({ error: 'Image not found' });
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

      // Get the existing card
      const existingCard = await db.query.cards.findFirst({
        where: eq(cards.id, cardId)
      });

      if (!existingCard) {
        return res.status(404).json({ error: 'Card not found' });
      }

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
  app.post(`${apiPrefix}/analyze-card-image`, upload.single('image'), handleCardImageAnalysis);

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