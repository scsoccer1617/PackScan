import { db } from '@db';
import * as schema from '@shared/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { calculateEstimatedValue } from '../client/src/lib/utils';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';

// Google Sheets API setup
let googleAuth: OAuth2Client | null = null;
export let googleSheetsInstance: any = null;
export let spreadsheetId = process.env.GOOGLE_SHEET_ID || '';

// Global variable will be updated after initialization

// Initialize Google Sheets API
export async function initGoogleSheetsApi() {
  try {
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      console.warn('Google Sheets API credentials not found. Using database storage only.');
      return false;
    }

    googleAuth = new google.auth.JWT(
      process.env.GOOGLE_CLIENT_EMAIL,
      undefined,
      process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets']
    );

    googleSheetsInstance = google.sheets({ version: 'v4', auth: googleAuth });

    // Create or validate spreadsheet
    if (!spreadsheetId) {
      console.log('Creating new Google Sheet for card collection...');
      try {
        const response = await googleSheetsInstance.spreadsheets.create({
          resource: {
            properties: {
              title: 'Sports Card Collection',
            },
            sheets: [
              {
                properties: {
                  title: 'Cards',
                  gridProperties: {
                    frozenRowCount: 1,
                  },
                },
              },
            ],
          },
        });
        
        spreadsheetId = response.data.spreadsheetId;
        console.log(`Created new spreadsheet with ID: ${spreadsheetId}`);
        
        // Add headers
        await googleSheetsInstance.spreadsheets.values.update({
          spreadsheetId,
          range: 'Cards!A1:O1',
          valueInputOption: 'RAW',
          resource: {
            values: [[
              'ID', 'Sport', 'Player First Name', 'Player Last Name', 
              'Brand', 'Collection', 'Card Number', 'Year', 
              'Variant', 'Serial Number', 'Condition', 'Estimated Value',
              'Front Image URL', 'Back Image URL', 'Last Updated'
            ]],
          },
        });
      } catch (err) {
        console.error('Error creating Google Sheet:', err);
        return false;
      }
    }
    
    console.log('Google Sheets API initialized successfully');
    return true;
  } catch (error) {
    console.error('Error initializing Google Sheets API:', error);
    googleAuth = null;
    googleSheetsInstance = null;
    return false;
  }
}

// Database storage
export const storage = {
  // Sports CRUD
  async getSports() {
    return await db.query.sports.findMany({
      orderBy: schema.sports.name,
    });
  },

  async getSportByName(name: string) {
    return await db.query.sports.findFirst({
      where: eq(schema.sports.name, name),
    });
  },

  async createSport(name: string) {
    const [sport] = await db.insert(schema.sports)
      .values({ name })
      .returning();
    return sport;
  },

  // Brands CRUD
  async getBrands() {
    return await db.query.brands.findMany({
      orderBy: schema.brands.name,
    });
  },

  async getBrandByName(name: string) {
    return await db.query.brands.findFirst({
      where: eq(schema.brands.name, name),
    });
  },

  async createBrand(name: string) {
    const [brand] = await db.insert(schema.brands)
      .values({ name })
      .returning();
    return brand;
  },

  // Cards CRUD
  async getCards() {
    return await db.query.cards.findMany({
      orderBy: desc(schema.cards.createdAt),
      with: {
        sport: true,
        brand: true,
      },
    });
  },

  async getCardById(id: number) {
    return await db.query.cards.findFirst({
      where: eq(schema.cards.id, id),
      with: {
        sport: true,
        brand: true,
      },
    });
  },

  async createCard(cardData: Omit<schema.CardInsert, 'id'>) {
    const [card] = await db.insert(schema.cards)
      .values(cardData)
      .returning();
    return card;
  },

  async updateCard(id: number, cardData: Partial<schema.CardInsert>) {
    const [updatedCard] = await db.update(schema.cards)
      .set({
        ...cardData,
        updatedAt: new Date(),
      })
      .where(eq(schema.cards.id, id))
      .returning();
    return updatedCard;
  },

  async deleteCard(id: number) {
    const [deletedCard] = await db.delete(schema.cards)
      .where(eq(schema.cards.id, id))
      .returning();
    return deletedCard;
  },

  // Stats and analytics
  async getCollectionStats() {
    const allCards = await this.getCards();
    
    // Total value calculation
    const totalValue = allCards.reduce((sum, card) => sum + (card.estimatedValue || 0), 0);
    
    // Cards by sport
    const sportDistribution = await db.select({
      name: schema.sports.name,
      count: sql<number>`count(${schema.cards.id})`,
    })
    .from(schema.cards)
    .innerJoin(schema.sports, eq(schema.cards.sportId, schema.sports.id))
    .groupBy(schema.sports.name);
    
    // Value by year
    const valueByYear = await db.select({
      year: schema.cards.year,
      value: sql<number>`sum(${schema.cards.estimatedValue})`,
    })
    .from(schema.cards)
    .groupBy(schema.cards.year)
    .orderBy(schema.cards.year);
    
    // Most valuable cards
    const topCards = await db.query.cards.findMany({
      orderBy: desc(schema.cards.estimatedValue),
      limit: 5,
      with: {
        sport: true,
        brand: true,
      },
    });
    
    return {
      totalCardCount: allCards.length,
      totalValue,
      sportDistribution: sportDistribution.map(s => ({
        name: s.name,
        value: Number(s.count),
      })),
      valueByYear: valueByYear.map(y => ({
        year: String(y.year),
        value: Number(y.value) || 0,
      })),
      topCards,
    };
  },

  // Google Sheets integration
  async saveCardToGoogleSheets(card: schema.Card, sportName: string, brandName: string, frontImageUrl?: string, backImageUrl?: string) {
    if (!googleSheetsInstance || !spreadsheetId) {
      throw new Error('Google Sheets API not initialized');
    }

    try {
      // Get the next row number
      const response = await googleSheetsInstance.spreadsheets.values.get({
        spreadsheetId,
        range: 'Cards!A:A',
      });
      
      const rows = response.data.values || [];
      const nextRow = rows.length + 1;
      
      // Insert card data
      await googleSheetsInstance.spreadsheets.values.update({
        spreadsheetId,
        range: `Cards!A${nextRow}:O${nextRow}`,
        valueInputOption: 'RAW',
        resource: {
          values: [[
            card.id.toString(),
            sportName,
            card.playerFirstName,
            card.playerLastName,
            brandName,
            card.collection || '',
            card.cardNumber,
            card.year.toString(),
            card.variant || '',
            card.serialNumber || '',
            card.condition || '',
            card.estimatedValue ? card.estimatedValue.toString() : '',
            frontImageUrl || '',
            backImageUrl || '',
            new Date().toISOString(),
          ]],
        },
      });
      
      return { success: true, row: nextRow };
    } catch (error) {
      console.error('Error saving card to Google Sheets:', error);
      throw error;
    }
  },

  // Save images to file system
  async saveImage(base64Data: string, filename: string): Promise<string> {
    try {
      // Create uploads directory if it doesn't exist
      const uploadsDir = path.join(process.cwd(), 'dist', 'public', 'uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      
      // Extract the actual base64 data (remove the data:image/jpeg;base64, part)
      const base64Image = base64Data.split(';base64,').pop();
      if (!base64Image) {
        throw new Error('Invalid image data');
      }
      
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, base64Image, { encoding: 'base64' });
      
      // Return the relative URL for the image
      return `/uploads/${filename}`;
    } catch (error) {
      console.error('Error saving image:', error);
      throw error;
    }
  },
};

// Initialize Google Sheets API when this module is imported
initGoogleSheetsApi().catch(console.error);
