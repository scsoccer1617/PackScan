import { db } from '@db';
import * as schema from '@shared/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { calculateEstimatedValue } from '../client/src/lib/utils';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  objectStorageClient,
  setObjectAclPolicy,
} from './replit_integrations/object_storage';

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

  // Save images to persistent App Storage (Google Cloud Storage backed).
  //
  // Returns a stable `/objects/uploads/<id>` URL that survives redeploys
  // (the legacy implementation wrote to the local filesystem under
  // `/uploads`, which Replit deployments wipe on every redeploy and broke
  // every image link in the user's Google Sheet).
  //
  // The `filename` parameter is preserved in object metadata for debugging
  // / human readability but the URL identifier itself is a fresh UUID so
  // that nothing in the path is user-controlled.
  async saveImage(base64Data: string, filename: string): Promise<string> {
    try {
      const m = /^data:([^;]+);base64,/i.exec(base64Data);
      const contentType = (m?.[1] || 'image/jpeg').toLowerCase();
      const base64Image = base64Data.split(';base64,').pop();
      if (!base64Image) {
        throw new Error('Invalid image data');
      }
      const buffer = Buffer.from(base64Image, 'base64');

      const privateDir = process.env.PRIVATE_OBJECT_DIR || '';
      if (!privateDir) {
        throw new Error('PRIVATE_OBJECT_DIR not set — App Storage not configured.');
      }
      // PRIVATE_OBJECT_DIR is shaped like `/<bucket>/<prefix>`.
      const trimmed = privateDir.startsWith('/') ? privateDir.slice(1) : privateDir;
      const slash = trimmed.indexOf('/');
      if (slash === -1) {
        throw new Error(`PRIVATE_OBJECT_DIR malformed: ${privateDir}`);
      }
      const bucketName = trimmed.slice(0, slash);
      const prefix = trimmed.slice(slash + 1).replace(/\/$/, '');

      const objectId = randomUUID();
      const objectName = `${prefix}/uploads/${objectId}`;
      const file = objectStorageClient.bucket(bucketName).file(objectName);

      await file.save(buffer, {
        contentType,
        metadata: {
          contentType,
          metadata: { originalFilename: filename },
        },
        resumable: false,
      });

      // Mark as publicly readable so the `/objects/...` route streams it
      // without requiring auth (sheet links are opened from a browser).
      await setObjectAclPolicy(file, {
        owner: 'system',
        visibility: 'public',
      });

      return `/objects/uploads/${objectId}`;
    } catch (error: any) {
      console.error('Error saving image to App Storage:', error);
      throw error;
    }
  },
};