import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import { storage, googleSheetsInstance } from "./storage";
import * as schema from "@shared/schema";
import { z } from "zod";
import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { analyzeSportsCardImage } from "./googleVisionFetch";

// Google Sheets variables
const spreadsheetId = process.env.GOOGLE_SHEET_ID;

// TypeScript interfaces for Express with multer
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

// Extend Express.Request
interface MulterRequest extends Request {
  file?: MulterFile;
  files?: { [fieldname: string]: MulterFile[] };
}

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});

export async function registerRoutes(app: Express): Promise<Server> {
  // Set up API routes
  const apiPrefix = '/api';

  // Ensure uploads directory exists
  const uploadsDir = path.join(process.cwd(), 'dist', 'public', 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  // Get all sports
  app.get(`${apiPrefix}/sports`, async (req, res) => {
    try {
      const sports = await storage.getSports();
      res.json(sports);
    } catch (error) {
      console.error('Error fetching sports:', error);
      res.status(500).json({ message: 'Failed to fetch sports' });
    }
  });

  // Get all brands
  app.get(`${apiPrefix}/brands`, async (req, res) => {
    try {
      const brands = await storage.getBrands();
      res.json(brands);
    } catch (error) {
      console.error('Error fetching brands:', error);
      res.status(500).json({ message: 'Failed to fetch brands' });
    }
  });

  // Get all cards
  app.get(`${apiPrefix}/cards`, async (req, res) => {
    try {
      const cards = await storage.getCards();
      res.json(cards);
    } catch (error) {
      console.error('Error fetching cards:', error);
      res.status(500).json({ message: 'Failed to fetch cards' });
    }
  });

  // Get card by ID
  app.get(`${apiPrefix}/cards/:id`, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const card = await storage.getCardById(id);
      
      if (!card) {
        return res.status(404).json({ message: 'Card not found' });
      }
      
      res.json(card);
    } catch (error) {
      console.error(`Error fetching card ${req.params.id}:`, error);
      res.status(500).json({ message: 'Failed to fetch card' });
    }
  });

  // Create new card
  app.post(`${apiPrefix}/cards`, upload.fields([
    { name: 'frontImage', maxCount: 1 },
    { name: 'backImage', maxCount: 1 }
  ]), async (req, res) => {
    try {
      // Parse card data from form
      const cardDataJson = req.body.data;
      if (!cardDataJson) {
        return res.status(400).json({ message: 'Card data is required' });
      }
      
      const cardData = schema.cardSchema.parse(JSON.parse(cardDataJson));
      
      // Process sport
      let sport = await storage.getSportByName(cardData.sport);
      if (!sport) {
        sport = await storage.createSport(cardData.sport);
      }
      
      // Process brand
      let brand = await storage.getBrandByName(cardData.brand);
      if (!brand) {
        brand = await storage.createBrand(cardData.brand);
      }
      
      // Process images
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      let frontImageUrl: string | undefined;
      let backImageUrl: string | undefined;
      
      if (files && files.frontImage && files.frontImage[0]) {
        const frontImage = files.frontImage[0];
        const frontImageFilename = `front_${uuidv4()}${path.extname(frontImage.originalname) || '.jpg'}`;
        fs.writeFileSync(path.join(uploadsDir, frontImageFilename), frontImage.buffer);
        frontImageUrl = `/uploads/${frontImageFilename}`;
      }
      
      if (files && files.backImage && files.backImage[0]) {
        const backImage = files.backImage[0];
        const backImageFilename = `back_${uuidv4()}${path.extname(backImage.originalname) || '.jpg'}`;
        fs.writeFileSync(path.join(uploadsDir, backImageFilename), backImage.buffer);
        backImageUrl = `/uploads/${backImageFilename}`;
      }
      
      // Calculate estimated value if not provided
      const estimatedValue = cardData.estimatedValue || 
        (cardData.condition ? parseInt(cardData.condition.split(' ')[1]) * 20 : 0);
      
      // Create card in database
      const newCard = await storage.createCard({
        sportId: sport.id,
        playerFirstName: cardData.playerFirstName,
        playerLastName: cardData.playerLastName,
        brandId: brand.id,
        collection: cardData.collection || null,
        cardNumber: cardData.cardNumber,
        year: cardData.year,
        variant: cardData.variant || null,
        serialNumber: cardData.serialNumber || null,
        condition: cardData.condition || null,
        estimatedValue,
        frontImage: frontImageUrl || null,
        backImage: backImageUrl || null,
        googleSheetId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: null,
      });
      
      // Save to Google Sheets if configured
      if (googleSheetsInstance && spreadsheetId) {
        try {
          const sheetResult = await storage.saveCardToGoogleSheets(
            newCard, 
            sport.name, 
            brand.name, 
            frontImageUrl, 
            backImageUrl
          );
          
          if (sheetResult && sheetResult.success) {
            // Update card with Google Sheet reference
            await storage.updateCard(newCard.id, {
              googleSheetId: `${sheetResult.row}`,
            });
          }
        } catch (sheetError) {
          console.warn('Failed to save to Google Sheets, but card was saved to database:', sheetError);
          // Don't fail the request if Google Sheets integration fails
        }
      } else {
        console.log('Google Sheets integration not configured, skipping sheet update');
      }
      
      res.status(201).json(newCard);
    } catch (error) {
      console.error('Error creating card:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: 'Invalid card data', errors: error.errors });
      }
      res.status(500).json({ message: 'Failed to create card' });
    }
  });

  // Update card
  app.put(`${apiPrefix}/cards/:id`, upload.fields([
    { name: 'frontImage', maxCount: 1 },
    { name: 'backImage', maxCount: 1 }
  ]), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      
      // Get existing card
      const existingCard = await storage.getCardById(id);
      if (!existingCard) {
        return res.status(404).json({ message: 'Card not found' });
      }
      
      // Parse card data from form
      const cardDataJson = req.body.data;
      if (!cardDataJson) {
        return res.status(400).json({ message: 'Card data is required' });
      }
      
      const cardData = schema.cardSchema.parse(JSON.parse(cardDataJson));
      
      // Process sport
      let sportId = existingCard.sportId;
      if (cardData.sport) {
        let sport = await storage.getSportByName(cardData.sport);
        if (!sport) {
          sport = await storage.createSport(cardData.sport);
        }
        sportId = sport.id;
      }
      
      // Process brand
      let brandId = existingCard.brandId;
      if (cardData.brand) {
        let brand = await storage.getBrandByName(cardData.brand);
        if (!brand) {
          brand = await storage.createBrand(cardData.brand);
        }
        brandId = brand.id;
      }
      
      // Process images
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      let frontImageUrl = existingCard.frontImage;
      let backImageUrl = existingCard.backImage;
      
      if (files && files.frontImage && files.frontImage[0]) {
        const frontImage = files.frontImage[0];
        const frontImageFilename = `front_${uuidv4()}${path.extname(frontImage.originalname) || '.jpg'}`;
        fs.writeFileSync(path.join(uploadsDir, frontImageFilename), frontImage.buffer);
        frontImageUrl = `/uploads/${frontImageFilename}`;
      }
      
      if (files && files.backImage && files.backImage[0]) {
        const backImage = files.backImage[0];
        const backImageFilename = `back_${uuidv4()}${path.extname(backImage.originalname) || '.jpg'}`;
        fs.writeFileSync(path.join(uploadsDir, backImageFilename), backImage.buffer);
        backImageUrl = `/uploads/${backImageFilename}`;
      }
      
      // Update card
      const updatedCard = await storage.updateCard(id, {
        sportId,
        playerFirstName: cardData.playerFirstName,
        playerLastName: cardData.playerLastName,
        brandId,
        collection: cardData.collection || null,
        cardNumber: cardData.cardNumber,
        year: cardData.year,
        variant: cardData.variant || null,
        serialNumber: cardData.serialNumber || null,
        condition: cardData.condition || null,
        estimatedValue: cardData.estimatedValue,
        frontImage: frontImageUrl,
        backImage: backImageUrl,
      });
      
      res.json(updatedCard);
    } catch (error) {
      console.error(`Error updating card ${req.params.id}:`, error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: 'Invalid card data', errors: error.errors });
      }
      res.status(500).json({ message: 'Failed to update card' });
    }
  });

  // Delete card
  app.delete(`${apiPrefix}/cards/:id`, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deletedCard = await storage.deleteCard(id);
      
      if (!deletedCard) {
        return res.status(404).json({ message: 'Card not found' });
      }
      
      // Delete images if they exist
      if (deletedCard.frontImage) {
        const frontImagePath = path.join(process.cwd(), 'dist', 'public', deletedCard.frontImage);
        if (fs.existsSync(frontImagePath)) {
          fs.unlinkSync(frontImagePath);
        }
      }
      
      if (deletedCard.backImage) {
        const backImagePath = path.join(process.cwd(), 'dist', 'public', deletedCard.backImage);
        if (fs.existsSync(backImagePath)) {
          fs.unlinkSync(backImagePath);
        }
      }
      
      res.json({ message: 'Card deleted successfully' });
    } catch (error) {
      console.error(`Error deleting card ${req.params.id}:`, error);
      res.status(500).json({ message: 'Failed to delete card' });
    }
  });

  // Get collection summary
  app.get(`${apiPrefix}/collection/summary`, async (req, res) => {
    try {
      const stats = await storage.getCollectionStats();
      res.json({
        cardCount: stats.totalCardCount,
        totalValue: stats.totalValue,
      });
    } catch (error) {
      console.error('Error fetching collection summary:', error);
      res.status(500).json({ message: 'Failed to fetch collection summary' });
    }
  });

  // Get stats summary
  app.get(`${apiPrefix}/stats/summary`, async (req, res) => {
    try {
      const stats = await storage.getCollectionStats();
      
      // In a real app, we would calculate the change from historical data
      // For now, use static sample values
      res.json({
        totalValue: stats.totalValue,
        changeValue: 125,
        changePercent: 4.1,
      });
    } catch (error) {
      console.error('Error fetching stats summary:', error);
      res.status(500).json({ message: 'Failed to fetch stats summary' });
    }
  });

  // Get chart data
  app.get(`${apiPrefix}/stats/charts`, async (req, res) => {
    try {
      const stats = await storage.getCollectionStats();
      
      // Convert sportDistribution for chart display
      const sportDistribution = stats.sportDistribution.map((sport, index) => ({
        name: sport.name,
        value: sport.value,
        color: ['#3b82f6', '#f97316', '#22c55e', '#8b5cf6', '#ec4899'][index % 5],
      }));
      
      res.json({
        sportDistribution,
        valueByYear: stats.valueByYear,
      });
    } catch (error) {
      console.error('Error fetching chart data:', error);
      res.status(500).json({ message: 'Failed to fetch chart data' });
    }
  });

  // Get top cards
  app.get(`${apiPrefix}/stats/top-cards`, async (req, res) => {
    try {
      const stats = await storage.getCollectionStats();
      
      // Add sample change percentages to the top cards
      // In a real app, these would be calculated from historical price data
      const topCardsWithChange = stats.topCards.map((card, index) => ({
        ...card,
        changePercent: [5.2, 2.8, 3.5, -1.2, 0.7][index % 5],
      }));
      
      res.json(topCardsWithChange);
    } catch (error) {
      console.error('Error fetching top cards:', error);
      res.status(500).json({ message: 'Failed to fetch top cards' });
    }
  });

  // OCR endpoint to analyze card images
  app.post(`${apiPrefix}/analyze-card-image`, upload.single('image'), async (req: MulterRequest, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: 'No image provided' });
      }

      console.log('Received image file:', req.file.originalname, 'size:', req.file.size);
      console.log('Processing image with Google Cloud Vision API...');
      
      // Run OCR on the image - convert buffer to base64 string
      const cardInfo = await analyzeSportsCardImage(req.file.buffer.toString('base64'));
      console.log('OCR results:', JSON.stringify(cardInfo, null, 2));
      
      res.json({
        success: true,
        data: cardInfo
      });
    } catch (error: any) {
      console.error('Error analyzing card image:', error);
      
      let statusCode = 500;
      let userMessage = 'Failed to analyze card image';
      
      // Check for common API errors
      if (error.message) {
        if (error.message.includes('quota exceeded') || 
            error.message.includes('rate limit') || 
            error.message.includes('insufficient_quota')) {
          statusCode = 429;
          userMessage = 'API quota exceeded. Please try again later or contact support for assistance. You can still manually enter card details.';
        } else if (error.message.includes('PERMISSION_DENIED') || 
                  error.message.includes('403') || 
                  error.message.includes('not enabled') || 
                  error.message.includes('disabled')) {
          statusCode = 403;
          userMessage = 'The Vision API service is not properly configured or permission was denied. Please make sure the Vision API is enabled in your Google Cloud project.';
          
          // Check for specific Google Cloud Vision API error
          if (error.message.includes('Vision API has not been used in project') || 
              error.message.includes('it is disabled')) {
            userMessage = 'The Google Cloud Vision API is not enabled for your project. Please enable it in the Google Cloud Console by visiting the URL mentioned in the error details below.';
          }
        } else if (error.message.includes('credentials') || 
                  error.message.includes('authentication')) {
          statusCode = 401;
          userMessage = 'Authentication failed with the Vision API. Please check your service account credentials.';
        }
      }
      
      res.status(statusCode).json({ 
        success: false, 
        message: userMessage,
        error: error.message 
      });
    }
  });

  // Google Sheets API endpoints
  app.post(`${apiPrefix}/sheets/add-card`, async (req, res) => {
    try {
      const cardData = req.body;
      
      // Validate data
      if (!cardData || !cardData.id) {
        return res.status(400).json({ message: 'Invalid card data' });
      }
      
      // Get card from database
      const card = await storage.getCardById(parseInt(cardData.id));
      if (!card) {
        return res.status(404).json({ message: 'Card not found' });
      }
      
      // Get sport and brand names
      const sport = await storage.getSportByName(cardData.sport);
      const brand = await storage.getBrandByName(cardData.brand);
      
      if (!sport || !brand) {
        return res.status(400).json({ message: 'Invalid sport or brand' });
      }
      
      // Save to Google Sheets
      const result = await storage.saveCardToGoogleSheets(
        card,
        sport.name,
        brand.name,
        card.frontImage || undefined,
        card.backImage || undefined
      );
      
      // Update card with Google Sheet reference
      await storage.updateCard(card.id, {
        googleSheetId: `${result.row}`,
      });
      
      res.json({ success: true, message: 'Card saved to Google Sheets', rowId: result.row });
    } catch (error) {
      console.error('Error saving to Google Sheets:', error);
      res.status(500).json({ message: 'Failed to save to Google Sheets' });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
