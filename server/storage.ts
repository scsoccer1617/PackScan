import { db } from '@db';
import * as schema from '@shared/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { calculateEstimatedValue } from '../client/src/lib/utils';
import fs from 'fs';
import path from 'path';

// Storage functions for card management - database only
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
    // Delete the card from the database
    const [deletedCard] = await db.delete(schema.cards)
      .where(eq(schema.cards.id, id))
      .returning();
    
    return deletedCard;
  },

  // Stats and analytics
  async getCollectionStats() {
    const allCards = await this.getCards();
    
    // Total value calculation
    const totalValue = allCards.reduce((sum, card) => sum + (card.estimatedValue ? Number(card.estimatedValue) : 0), 0);
    
    // Cards by sport
    const sportDistribution = await db.select({
      name: schema.sports.name,
      count: sql<number>`count(*)`,
    })
    .from(schema.cards)
    .leftJoin(schema.sports, eq(schema.cards.sportId, schema.sports.id))
    .groupBy(schema.sports.name);

    // Cards by brand
    const brandDistribution = await db.select({
      name: schema.brands.name,
      count: sql<number>`count(*)`,
    })
    .from(schema.cards)
    .leftJoin(schema.brands, eq(schema.cards.brandId, schema.brands.id))
    .groupBy(schema.brands.name);

    return {
      totalCards: allCards.length,
      totalValue,
      sportDistribution,
      brandDistribution,
    };
  },

  // Save images to file system
  async saveImage(base64Data: string, filename: string): Promise<string> {
    try {
      // Create uploads directory in both locations for compatibility 
      // Main uploads dir
      const uploadsDir = path.join(process.cwd(), 'uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      
      // Also create the old directory structure for backward compatibility
      const oldUploadsDir = path.join(process.cwd(), 'dist', 'public', 'uploads');
      if (!fs.existsSync(oldUploadsDir)) {
        fs.mkdirSync(oldUploadsDir, { recursive: true });
      }
      
      // Extract the actual base64 data (remove the data:image/jpeg;base64, part)
      const base64Image = base64Data.split(';base64,').pop();
      if (!base64Image) {
        throw new Error('Invalid image data');
      }
      
      // Save to both locations for compatibility
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, base64Image, { encoding: 'base64' });
      
      const oldFilePath = path.join(oldUploadsDir, filename);
      fs.writeFileSync(oldFilePath, base64Image, { encoding: 'base64' });
      
      // Return the relative URL for the image
      return `/uploads/${filename}`;
    } catch (error: any) {
      console.error('Error saving image:', error);
      throw error;
    }
  },
};