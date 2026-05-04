import express, { Express, Request, Response, NextFunction } from 'express';
import { Server, createServer } from 'http';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { db } from '../db';
import { and, desc, eq, gte, isNull, sql, max, inArray } from 'drizzle-orm';
import { syncConfirmedCard } from './syncDatabase';
import {
  cards,
  sports,
  brands,
  confirmedCards,
  cardInsertSchema,
  cardSchema,
  importHistory,
  type CardInsert,
  type Card,
  type CardWithRelations
} from '../shared/schema';
import * as schema from '../shared/schema';
import { storage } from './storage';
import { searchCardValues, getEbaySearchUrl, clearEbayCache } from './ebayService';
import { holoOverallToPsaInt, psaKeyword } from './holo/psaGrade';
import { z } from 'zod';
import { handleDualSideCardAnalysis } from './dualSideOCR';
import { extractTextFromImage, analyzeSportsCardImage } from './googleVisionFetch';
import { importCardsCSV, importVariationsCSV, lookupCard, enrichVoiceFields } from './cardDatabaseService';
import { cardDatabase, cardVariations, csvSyncLog } from '../shared/schema';
import {
  findLatestCsvInFolder,
  downloadFile,
  findExistingSyncLog,
  getCardsFolderId,
  getVariationsFolderId,
  isDriveSyncConfigured,
} from './driveSync';
import { join } from 'path';
import fs from 'fs';
import { gunzipSync } from 'zlib';
import { pool as sourcePool } from '../db';
import { runPushToProdJob, makeInitialJobState, type PushJobState } from './pushToProd';
import {
  analyzeCard,
  gradeCard,
  HoloNotConfiguredError,
  type HoloGrade,
  type HoloAnalysis,
} from './holo/cardGrader';
import { saveGrade, listGradesForUser, getGradeById, hydrateGrade, updateGradeIdentification, updateGradeEstimatedValue } from './holo/storage';
import { requireAuth, getUserPreferences } from './auth';
import { requireScanQuota, incrementScanCount, getScanQuota } from './scanQuota';
import { logUserScan, updateUserScan, type ScanFieldValues } from './userScans';
import { lookupCard as scpLookupCard, SOURCE_SLUG as SCP_SOURCE_SLUG } from './sportscardspro';
import type { ScanQueryInput as ScpScanQueryInput } from './sportscardspro';
import { discoverParallels } from './sportscardspro/parallels';

// Mirrors splitPlayerName in client/src/pages/Scan.tsx so the voice
// speculative-SCP sanity check compares identities the same way the
// client does when it navigates to /result. Hoisted to module scope to
// satisfy ES5 strict-mode's no-function-in-blocks rule.
function splitVoicePlayerName(
  name: string | null | undefined,
): { first: string; last: string } {
  if (!name) return { first: '', last: '' };
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { first: '', last: '' };
  if (tokens.length === 1) return { first: tokens[0], last: '' };
  const suffixRe = /^(jr|sr|ii|iii|iv|v)\.?$/i;
  const lastToken = tokens[tokens.length - 1];
  if (suffixRe.test(lastToken) && tokens.length >= 3) {
    return {
      first: tokens[0],
      last: `${tokens[tokens.length - 2]} ${lastToken}`,
    };
  }
  return { first: tokens[0], last: tokens.slice(1).join(' ') };
}

/**
 * Best-effort partial-JSON tolerant parse of an in-flight JSON prefix.
 * Used by the Gemini SSE endpoint to surface partial fields while the
 * model is still emitting tokens. Returns the parsed object on success,
 * or null when the prefix is too truncated to recover.
 *
 * Strategy: walk the prefix tracking open `{`, `[`, `"` levels. If we
 * land outside a string at a balanced point, append the closers that
 * would balance any still-open levels. Drops a trailing partial token
 * (comma, colon, or half-finished number/key) before closing so
 * JSON.parse doesn't reject. Best-effort only — callers tolerate null.
 */
function tryParsePartialJson(prefix: string): Record<string, unknown> | null {
  const stack: Array<'{' | '[' | '"'> = [];
  let lastSafe = 0;
  let i = 0;
  while (i < prefix.length) {
    const c = prefix[i];
    const top = stack[stack.length - 1];
    if (top === '"') {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') stack.pop();
      i += 1;
      continue;
    }
    if (c === '"') stack.push('"');
    else if (c === '{') stack.push('{');
    else if (c === '[') stack.push('[');
    else if (c === '}') {
      if (top !== '{') return null;
      stack.pop();
    } else if (c === ']') {
      if (top !== '[') return null;
      stack.pop();
    }
    i += 1;
    // Mark a safe truncation point after every value-completing token
    // outside a string: ',', ']', or '}' at the top of any structure.
    if (stack[stack.length - 1] !== '"' && (c === ',' || c === '}' || c === ']')) {
      lastSafe = i;
    }
  }
  // Truncate to last safe boundary if we're mid-token, then strip the
  // dangling comma the safe boundary may have left behind.
  let body = prefix.slice(0, lastSafe || prefix.length).replace(/\s+$/, '');
  // Recompute open levels for the truncated body — it can only be a
  // subset of the original stack since truncation only drops trailing
  // characters that were OUTSIDE any open string.
  const truncStack: Array<'{' | '['> = [];
  let inStr = false;
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (inStr) {
      if (c === '\\') { j += 1; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') truncStack.push('{');
    else if (c === '[') truncStack.push('[');
    else if (c === '}') truncStack.pop();
    else if (c === ']') truncStack.pop();
  }
  if (body.endsWith(',')) body = body.slice(0, -1);
  let closers = '';
  for (let k = truncStack.length - 1; k >= 0; k--) {
    closers += truncStack[k] === '{' ? '}' : ']';
  }
  try {
    return JSON.parse(body + closers) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Configure multer for handling file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 60 * 1024 * 1024, // 60MB limit to accommodate large CSVs and high-res card photos
  },
});

// ─── Background Import Job Tracking ─────────────────────────────────────────
interface ImportJobState {
  status: 'queued' | 'running' | 'done' | 'error';
  type: 'cards' | 'variations';
  progress: { processed: number; total: number };
  result?: { imported: number; replaced: number; errorCount: number; errors: string[] };
  error?: string;
  startedAt: number;
}
const importJobs = new Map<string, ImportJobState>();
// Push-to-prod jobs share a similar lifecycle but a different shape.
const pushJobs = new Map<string, PushJobState>();
// Evict completed jobs older than 2 hours every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 7_200_000;
  for (const [id, job] of importJobs.entries()) {
    if (job.startedAt < cutoff) importJobs.delete(id);
  }
  for (const [id, job] of pushJobs.entries()) {
    if (job.startedAt < cutoff) pushJobs.delete(id);
  }
}, 1_800_000).unref();

async function runCardsImportJob(jobId: string, buffer: Buffer, countBefore: number): Promise<void> {
  const job = importJobs.get(jobId);
  if (!job) return;
  job.status = 'running';
  try {
    const result = await importCardsCSV(buffer, (processed, total) => {
      const j = importJobs.get(jobId);
      if (j) j.progress = { processed, total };
    });
    if (result.errors.length > 0) {
      console.log(`[CardDB] Import skipped ${result.errors.length} row(s) (first 5):`);
      result.errors.slice(0, 5).forEach(e => console.log(`  • ${e}`));
    }
    const [afterRow] = await db.select({ count: sql<number>`count(*)::int` }).from(cardDatabase);
    const countAfter = afterRow?.count ?? 0;
    await db.insert(importHistory).values({ type: 'cards', countBefore, countAfter, delta: countAfter - countBefore });
    job.status = 'done';
    job.result = { imported: result.imported, replaced: result.replaced, errorCount: result.errors.length, errors: result.errors.slice(0, 200) };
    job.progress = { processed: result.imported, total: result.imported };
  } catch (err: any) {
    console.error('[CardDB] Background cards import error:', err);
    const j = importJobs.get(jobId);
    if (j) { j.status = 'error'; j.error = err.message || 'Unknown error'; }
  }
}

async function runVariationsImportJob(jobId: string, buffer: Buffer, countBefore: number): Promise<void> {
  const job = importJobs.get(jobId);
  if (!job) return;
  job.status = 'running';
  try {
    const result = await importVariationsCSV(buffer, (processed, total) => {
      const j = importJobs.get(jobId);
      if (j) j.progress = { processed, total };
    });
    if (result.errors.length > 0) {
      console.log(`[CardDB] Variations import skipped ${result.errors.length} row(s) (first 5):`);
      result.errors.slice(0, 5).forEach(e => console.log(`  • ${e}`));
    }
    const [afterRow] = await db.select({ count: sql<number>`count(*)::int` }).from(cardVariations);
    const countAfter = afterRow?.count ?? 0;
    await db.insert(importHistory).values({ type: 'variations', countBefore, countAfter, delta: countAfter - countBefore });
    job.status = 'done';
    job.result = { imported: result.imported, replaced: result.replaced, errorCount: result.errors.length, errors: result.errors.slice(0, 200) };
    job.progress = { processed: result.imported, total: result.imported };
  } catch (err: any) {
    console.error('[CardDB] Background variations import error:', err);
    const j = importJobs.get(jobId);
    if (j) { j.status = 'error'; j.error = err.message || 'Unknown error'; }
  }
}

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

  // Get all cards for the authenticated user. Source of truth is now the
  // user's active Google Sheet — every add writes there, and the legacy
  // local `cards` table is no longer maintained. For unauthenticated or
  // Google-unconnected users this returns [] so the Collection page
  // renders the empty state instead of 500'ing.
  //
  // Sheet-rows written before durable image persistence (or when a data-URI
  // exceeded the 50k-char-per-cell ceiling) have an empty Front link. We
  // backfill those from the user's scan_grades rows by matching on
  // (playerLastName + year + brand) — the same identification signature the
  // Holo grader already captured when the card was scanned. This is strictly
  // read-side; the sheet itself is not rewritten.
  app.get(`${apiPrefix}/cards`, async (req, res) => {
    try {
      const userId = (req.user as any)?.id as number | undefined;
      if (!userId) return res.json([]);
      const { getActiveSheetRows } = await import('./googleSheets');
      const rows = await getActiveSheetRows(userId);
      // Newest first so the Collection grid shows recent scans at the top.
      rows.sort((a, b) => {
        const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
        const at = a.createdAt ? Date.parse(a.createdAt) : 0;
        return bt - at;
      });

      // Backfill frontImage/backImage for rows that are missing one or both.
      const needsBackfill = rows.some((r) => !r.frontImage || !r.backImage);
      if (needsBackfill) {
        const grades = (await listGradesForUser(userId, 100)).map(hydrateGrade);
        // Index grade images by a normalized identification signature so we
        // can splice them into matching sheet rows. Newer grades win — we
        // seed the map newest-first and skip collisions after.
        const sigToImages = new Map<string, { front: string | null; back: string | null }>();
        for (const g of grades) {
          const ident = g.identification;
          if (!ident) continue;
          const last = (ident.player || '').trim().split(/\s+/).pop() || '';
          const year = ident.year != null ? String(ident.year) : '';
          const brand = (ident.brand || '').trim();
          if (!last && !year && !brand) continue;
          const sig = `${last.toLowerCase()}|${year}|${brand.toLowerCase()}`;
          if (sigToImages.has(sig)) continue;
          sigToImages.set(sig, {
            front: (g as any).frontImage ?? null,
            back: (g as any).backImage ?? null,
          });
        }
        if (sigToImages.size > 0) {
          for (const r of rows) {
            if (r.frontImage && r.backImage) continue;
            const last = (r.playerLastName || '').trim();
            const year = r.year != null ? String(r.year) : '';
            const brand = (r.brand?.name || '').trim();
            const sig = `${last.toLowerCase()}|${year}|${brand.toLowerCase()}`;
            const hit = sigToImages.get(sig);
            if (!hit) continue;
            if (!r.frontImage && hit.front) r.frontImage = hit.front;
            if (!r.backImage && hit.back) r.backImage = hit.back;
          }
        }
      }

      return res.json(rows);
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
          31: { front: '/uploads/fixed_Thigpen_front.jpg', back: '/uploads/1748182904644_Thigpen_back.jpg' },
          32: { front: '/uploads/fixed_James_front.jpg', back: '/uploads/1748183726976_James_back.jpg' },
          33: { front: '/uploads/1748186054812_Van Slyke_front.jpg', back: '/uploads/1748186054814_Van Slyke_back.jpg' },
          34: { front: '/uploads/1748186788500_Jones_front.jpg', back: '/uploads/1748186788502_Jones_back.jpg' },
          35: { front: 'manaea_front_2024_topps_series2.jpg', back: 'manaea_back_2024_topps_series2.jpg' },
          36: { front: 'frelick_front_2024_topps_35year.jpg', back: 'frelick_back_2024_35year.jpg' },
          37: { front: 'trout_front_2024_topps_chrome.jpg', back: 'trout_back_2024_topps_chrome.jpg' },
          38: { front: 'bregman_front_2024_topps_35year.jpg', back: 'bregman_back_2024_topps_35year.jpg' },
          39: { front: 'freedman_front_2023_topps_smlb.jpg', back: 'freedman_back_2023_topps_smlb.jpg' },
          40: { front: 'correa_front_2024_topps_smlb.jpg', back: 'correa_back_2024_topps_smlb.jpg' },
          41: { front: 'rafaela_front_2024_topps_smlb.jpg', back: 'rafaela_back_2024_topps_smlb.jpg' },
          42: { front: 'manaea_front_2024_topps_series2.jpg', back: 'manaea_back_2024_topps_series2.jpg' },
          43: { front: 'bregman_front_2024_topps_35year.jpg', back: 'bregman_back_2024_topps_35year.jpg' },
          44: { front: 'manaea_front_2024_topps_series2.jpg', back: 'manaea_back_2024_topps_series2.jpg' },
          45: { front: 'machado_front_2024_topps_csmlb.jpg', back: 'machado_back_2024_topps_csmlb.jpg' },
          46: { front: 'correa_front_2024_topps_smlb.jpg', back: 'correa_back_2024_topps_smlb.jpg' },
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

      // Log to user_scans (best-effort — never blocks the response). We use
      // the explicit `_scanTracking` payload from the client when present;
      // otherwise we fall back to 'saved_no_feedback' with the saved values
      // serving as both "detected" and "final" so we still capture the row
      // for admin review even when the client hasn't been updated yet.
      const tracking = (cardData as any)._scanTracking as
        | {
            userAction: 'confirmed' | 'declined_edited' | 'saved_no_feedback';
            detected?: ScanFieldValues;
            scpScore?: number | null;
            scpMatchedTitle?: string | null;
            cardDbCorroborated?: boolean | null;
            analyzerVersion?: string | null;
            // Audit-row id from the analyze response. When present we UPDATE
            // the analyzed_no_save row instead of inserting a duplicate.
            // Pre-QW-1 clients sent a numeric int row id; post-QW-1 clients
            // send the client-generated UUID string. updateUserScan accepts
            // either at runtime via a typeof check.
            _userScanId?: number | string | null;
          }
        | undefined;
      const finalValues: ScanFieldValues = {
        sport: cardData.sport,
        playerFirstName: cardData.playerFirstName,
        playerLastName: cardData.playerLastName,
        brand: cardData.brand,
        collection: cardData.collection ?? null,
        set: (cardData as any).set ?? null,
        cardNumber: cardData.cardNumber,
        year: cardData.year ?? null,
        variant: cardData.variant ?? null,
        team: (cardData as any).team ?? null,
        cmpNumber: (cardData as any).cmpNumber ?? null,
        serialNumber: cardData.serialNumber ?? null,
        foilType: cardData.foilType ?? null,
        isRookie: cardData.isRookieCard ?? null,
        isAuto: cardData.isAutographed ?? null,
        isNumbered: cardData.isNumbered ?? null,
        isFoil: cardData.isFoil ?? null,
      };
      const userId = (req.user as any)?.id as number | undefined;
      const logParams = {
        userId: userId ?? null,
        cardId: newCard?.id ?? null,
        userAction: tracking?.userAction ?? 'saved_no_feedback',
        detected: tracking?.detected ?? finalValues,
        final: finalValues,
        frontImage: cardInsertData.frontImage ?? null,
        backImage: cardInsertData.backImage ?? null,
        scpScore: tracking?.scpScore ?? null,
        scpMatchedTitle: tracking?.scpMatchedTitle ?? null,
        cardDbCorroborated: tracking?.cardDbCorroborated ?? null,
        analyzerVersion: tracking?.analyzerVersion ?? null,
        // Forward the detected blob the client tracked at scan-result
        // render time. updateUserScan never overwrites an existing
        // snapshot, so this only matters on the fresh-insert fallback
        // path; the analyze step writes the authoritative payload.
        geminiSnapshot: tracking?.detected ?? null,
        // 👍 means "no edits regardless of any string-coercion noise"
        fieldsChangedOverride: tracking?.userAction === 'confirmed' ? [] : undefined,
      };
      // Promote analyze-time row when client passes a scan id; insert
      // otherwise. The id is a numeric row id (pre-QW-1) or a client UUID
      // (post-QW-1) — both routes go through updateUserScan, which picks
      // the right WHERE clause from the runtime type.
      const userScanId = tracking?._userScanId;
      const hasNumericRef = typeof userScanId === 'number' && userScanId > 0;
      const hasStringRef = typeof userScanId === 'string' && userScanId.length > 0;
      if (hasNumericRef || hasStringRef) {
        updateUserScan(userScanId as number | string, logParams).then((updated) => {
          if (!updated) logUserScan(logParams).catch(() => {});
        }).catch(() => {});
      } else {
        logUserScan(logParams).catch(() => {});
      }

      return res.status(201).json({ 
        card: newCard
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
      
      return res.json({
        card: updatedCard
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
  
  // Get collection summary for header display. Reads from the active
  // Google Sheet — see the GET /api/cards comment above for the "Sheets
  // is the source of truth" rationale.
  app.get(`${apiPrefix}/collection/summary`, async (req, res) => {
    try {
      const userId = (req.user as any)?.id as number | undefined;
      if (!userId) return res.json({ cardCount: 0, totalValue: 0 });
      const { getActiveSheetRows } = await import('./googleSheets');
      const rows = await getActiveSheetRows(userId);
      const totalValue = rows.reduce(
        (sum, r) => sum + (r.estimatedValue ? Number(r.estimatedValue) : 0),
        0,
      );
      return res.json({ cardCount: rows.length, totalValue });
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
  
  // Stats endpoints for the Stats page. All three read from the active
  // Google Sheet — same rationale as /api/cards and /api/collection/summary.
  // Unauthenticated users get empty data so the page renders its “add cards
  // to grow the curve” state instead of erroring.

  app.get(`${apiPrefix}/stats/summary`, async (req, res) => {
    try {
      const userId = (req.user as any)?.id as number | undefined;
      if (!userId) return res.json({ totalValue: 0, changeValue: 0, changePercent: 0 });
      const { getActiveSheetRows } = await import('./googleSheets');
      const rows = await getActiveSheetRows(userId);
      const totalValue = rows.reduce(
        (sum, r) => sum + (r.estimatedValue ? Number(r.estimatedValue) : 0),
        0,
      );
      // Period-over-period deltas aren't stored yet — value snapshots
      // would need a separate rollup table. Keep 0/0 here so the UI
      // doesn't make up numbers.
      return res.json({ totalValue, changeValue: 0, changePercent: 0 });
    } catch (error) {
      console.error('Error fetching stats summary:', error);
      return res.status(500).json({ error: 'Failed to fetch stats summary' });
    }
  });

  // Top 5 cards by estimated value. Returns sheet rows with the same
  // field names Home.tsx's TopCard type reads (playerFirstName,
  // playerLastName, year, estimatedValue, frontImage, brand.name).
  app.get(`${apiPrefix}/stats/top-cards`, async (req, res) => {
    try {
      const userId = (req.user as any)?.id as number | undefined;
      if (!userId) return res.json([]);
      const { getActiveSheetRows } = await import('./googleSheets');
      const rows = await getActiveSheetRows(userId);
      const top = rows
        .filter((r) => r.estimatedValue && Number(r.estimatedValue) > 0)
        .sort((a, b) => Number(b.estimatedValue || 0) - Number(a.estimatedValue || 0))
        .slice(0, 5);
      return res.json(top);
    } catch (error) {
      console.error('Error fetching top cards:', error);
      return res.status(500).json({ error: 'Failed to fetch top cards' });
    }
  });

  // Charts data (value by year + cards by sport). Grouped client-side
  // on the parsed sheet rows since we're already paying to read the full
  // sheet for the other stats endpoints anyway — the TTL cache means
  // this and /stats/summary share a single Google round trip.
  app.get(`${apiPrefix}/stats/charts`, async (req, res) => {
    try {
      const userId = (req.user as any)?.id as number | undefined;
      if (!userId) return res.json({ valueByYear: [], sportDistribution: [] });
      const { getActiveSheetRows } = await import('./googleSheets');
      const rows = await getActiveSheetRows(userId);

      const yearTotals = new Map<string, number>();
      const sportCounts = new Map<string, number>();
      for (const r of rows) {
        if (r.year != null) {
          const key = String(r.year);
          const v = r.estimatedValue ? Number(r.estimatedValue) : 0;
          yearTotals.set(key, (yearTotals.get(key) ?? 0) + v);
        }
        const sportName = r.sport?.name?.trim();
        if (sportName) {
          sportCounts.set(sportName, (sportCounts.get(sportName) ?? 0) + 1);
        }
      }
      const valueByYear = Array.from(yearTotals.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([year, value]) => ({ year, value }));
      const sportDistribution = Array.from(sportCounts.entries()).map(
        ([name, count]) => ({ name, value: count }),
      );
      return res.json({ valueByYear, sportDistribution });
    } catch (error) {
      console.error('Error fetching charts data:', error);
      return res.status(500).json({ error: 'Failed to fetch charts data' });
    }
  });

  // Test Google Vision API authentication
  app.get(`${apiPrefix}/test-vision`, async (req, res) => {
    try {
      // Create a simple test image (1x1 pixel white PNG in base64)
      const testImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      
      console.log('Testing Google Vision API authentication...');
      const result = await extractTextFromImage(testImage);
      console.log('Google Vision API test successful:', result);
      
      return res.json({
        success: true,
        message: 'Google Vision API is working correctly',
        textLength: result.fullText.length
      });
    } catch (error: any) {
      console.error('Google Vision API test failed:', error);
      return res.status(500).json({
        success: false,
        message: 'Google Vision API authentication failed',
        error: error.message
      });
    }
  });

  // OCR endpoint to analyze card images
  //
  // Quota: gated by `requireScanQuota` (429 with `limit_reached` if exceeded).
  // We increment `users.scanCount` once on a successful 200 response via a
  // res.on('finish') hook so every branch that ends with res.json() (and
  // there are several below for the various ebay/holo paths) is covered
  // without sprinkling increment calls through the handler. 4xx/5xx paths
  // never reach the increment because the status check excludes them.
  app.post(`${apiPrefix}/analyze-card-image`, requireScanQuota, upload.single('image'), async (req, res) => {
    const userId = (req.user as any)?.id as number | undefined;
    res.on('finish', () => {
      if (res.statusCode === 200) void incrementScanCount(userId);
    });
    // Check for special cards first by looking at the request
    const file = req.file;
    
    return handleDualSideCardAnalysis(req, res);
  });

  // eBay search endpoint
  app.get(`${apiPrefix}/search-ebay-values`, async (req, res) => {
    try {
      const { playerName, cardNumber, brand, year, collection, condition, isNumbered, foilType, serialNumber, isAutographed } = req.query;
      
      if (!playerName || !brand || !year) {
        return res.status(400).json({ error: 'Missing required parameters' });
      }
      
      const results = await searchCardValues(
        playerName as string,
        cardNumber as string || '',
        brand as string,
        parseInt(year as string, 10),
        collection as string || '',
        condition as string || '',
        isNumbered === 'true',
        foilType as string || undefined,
        serialNumber as string || undefined,
        undefined,
        isAutographed === 'true'
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
          '',
          req.query.isNumbered === 'true',
          (req.query.foilType as string) || '',
          (req.query.serialNumber as string) || '',
          (req.query.variant as string) || '',
          (req.query.set as string) || undefined,
          undefined, // gradeKeyword — not applicable on this endpoint
          req.query.isAutographed === 'true',
          false, // excludeGraded — single-tier endpoint; no raw/graded split here
        ) 
      });
    }
  });

  // Simple eBay search endpoint for price lookup (no card saving)
  // Clear eBay cache endpoint
  app.get(`${apiPrefix}/ebay-cache-clear`, (req, res) => {
    clearEbayCache();
    res.json({ message: 'eBay cache cleared' });
  });

  app.get(`${apiPrefix}/ebay-search`, async (req, res) => {
    try {
      const { playerName, cardNumber, brand, year, collection, set, condition, isNumbered, foilType, serialNumber, variant, isAutographed } = req.query;
      
      if (!brand || !year) {
        return res.status(400).json({ error: 'Missing required parameters: brand and year are required' });
      }
      
      console.log('eBay search request:', { 
        playerName, 
        cardNumber, 
        brand, 
        year, 
        collection,
        set,
        isNumbered, 
        foilType: foilType || 'UNDEFINED', 
        serialNumber,
        variant: variant || 'NONE'
      });
      
      const results = await searchCardValues(
        String(playerName || ''),
        cardNumber as string || '',
        brand as string,
        parseInt(year as string, 10),
        collection as string || '',
        condition as string || '',
        isNumbered === 'true',
        foilType as string || undefined,
        serialNumber as string || undefined,
        variant as string || undefined,
        isAutographed === 'true',
        undefined,
        set as string || undefined
      );
      
      console.log('eBay search results:', results);
      
      return res.json(results);
    } catch (error) {
      console.error('Error searching eBay:', error);
      return res.status(500).json({ 
        error: 'Failed to search eBay prices',
        results: [],
        averageValue: 0
      });
    }
  });

  // Graded-pricing lookup for Holo users. Given the same card identifiers
  // as /api/ebay-search plus an optional Holo overall grade, runs three
  // eBay queries in parallel and returns:
  //   - raw      : the usual search, minus slabbed sales (-PSA -BGS -…)
  //   - atGrade  : keywords + "PSA {predictedGrade}" (skipped if grade == 10)
  //   - topGrade : keywords + "PSA 10"
  //
  // Each tier has the same shape as /api/ebay-search plus a `grade` label
  // and a boolean `empty` flag (true when count === 0). The frontend uses
  // empty tiers to render a clickable "No comps yet — browse eBay" link
  // instead of AI-invented prices.
  app.get(`${apiPrefix}/ebay-graded-search`, async (req, res) => {
    try {
      const {
        playerName, cardNumber, brand, year, collection, set, condition,
        isNumbered, foilType, serialNumber, variant, isAutographed, overall,
        psaGrade,
      } = req.query;

      if (!brand || !year) {
        return res.status(400).json({ error: 'Missing required parameters: brand and year are required' });
      }

      // User-supplied PSA grade (when the user knows the card is already
      // slabbed) takes precedence over the Holo-predicted grade. PSA only
      // issues integer grades on raw cards (1..10), so we floor any
      // half-step input and clamp to the valid range before building the
      // query keyword.
      const userPsaNum = psaGrade !== undefined && psaGrade !== ''
        ? Number(psaGrade) : NaN;
      let psaInt: number | null = null;
      if (Number.isFinite(userPsaNum) && userPsaNum >= 1 && userPsaNum <= 10) {
        psaInt = Math.round(userPsaNum);
      } else {
        const overallNum = overall !== undefined && overall !== ''
          ? Number(overall) : NaN;
        psaInt = Number.isFinite(overallNum) ? holoOverallToPsaInt(overallNum) : null;
      }
      const atGradeKeyword = psaKeyword(psaInt);
      const topGradeKeyword = 'PSA 10';
      const skipTopGrade = psaInt === 10; // at-grade IS top-grade — don't duplicate

      const runTier = (opts: { gradeKeyword?: string; excludeGraded?: boolean }) =>
        searchCardValues(
          String(playerName || ''),
          cardNumber as string || '',
          brand as string,
          parseInt(year as string, 10),
          collection as string || '',
          condition as string || '',
          isNumbered === 'true',
          foilType as string || undefined,
          serialNumber as string || undefined,
          variant as string || undefined,
          isAutographed === 'true',
          undefined,
          set as string || undefined,
          opts,
        );

      // Run up to three searches in parallel — each call hits the same
      // keyword-builder under the hood, so the cost is network-bound rather
      // than CPU-bound. searchCardValues is already cached, so repeated
      // scans of the same card only pay the eBay cost once per tier.
      const [rawRes, atGradeRes, topGradeRes] = await Promise.all([
        runTier({ excludeGraded: true }),
        atGradeKeyword ? runTier({ gradeKeyword: atGradeKeyword }) : Promise.resolve(null),
        skipTopGrade ? Promise.resolve(null) : runTier({ gradeKeyword: topGradeKeyword }),
      ]);

      const toTier = (
        r: Awaited<ReturnType<typeof searchCardValues>> | null,
        label: string,
      ) => {
        if (!r) return null;
        const count = r.results?.length || 0;
        return {
          grade: label,
          averageValue: r.averageValue || 0,
          count,
          items: r.results || [],
          searchUrl: r.searchUrl || '',
          dataType: r.dataType || 'sold',
          errorMessage: r.errorMessage,
          empty: count === 0,
        };
      };

      return res.json({
        predictedPsaGrade: psaInt,
        raw: toTier(rawRes, 'Raw'),
        atGrade: toTier(atGradeRes, atGradeKeyword || ''),
        // If at-grade IS PSA 10, mirror it into topGrade for the UI so the
        // "Top grade (PSA 10)" column isn't empty when the card already
        // earned a PSA-10 prediction.
        topGrade: skipTopGrade
          ? toTier(atGradeRes, 'PSA 10')
          : toTier(topGradeRes, 'PSA 10'),
      });
    } catch (error: any) {
      console.error('Error in graded eBay search:', error);
      return res.status(500).json({
        error: 'Failed to search graded eBay prices',
        raw: null,
        atGrade: null,
        topGrade: null,
      });
    }
  });

  // =========================================================================
  // Catalog match (SportsCardsPro overlay)
  // =========================================================================
  //
  // Given a scan's structured fields, find the best SportsCardsPro product
  // match and return its price curve. This is an ADDITIVE overlay — eBay
  // comp pricing (above) remains the primary source for the UI; the
  // catalog strip renders alongside as a market benchmark.
  //
  // Intentionally always returns HTTP 200. Clients render the catalog
  // section only on status: "hit"; a "miss" response is a normal outcome
  // for long-tail cards SCP doesn't cover, not an error.
  //
  // Auth: any signed-in user. We pass req.user.id into miss logging so
  // we can trace whose scans keep missing.
  const catalogMatchSchema = z.object({
    playerName: z.string().trim().optional().nullable(),
    year: z.number().int().optional().nullable(),
    brand: z.string().trim().optional().nullable(),
    collection: z.string().trim().optional().nullable(),
    setName: z.string().trim().optional().nullable(),
    cardNumber: z.string().trim().optional().nullable(),
    parallel: z.string().trim().optional().nullable(),
  });

  app.post(`${apiPrefix}/catalog/match`, async (req: Request, res: Response) => {
    const parsed = catalogMatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        status: 'miss', reason: 'bad_request',
        error: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }
    // PR #162: SCP grounding removed. Picker is now Gemini-authoritative
    // and uses live eBay Browse API for listings — no catalog overlay.
    // Endpoint returns a stable miss shape so any client still calling it
    // renders cleanly (CatalogPriceStrip handles `status: 'miss'`).
    return res.status(200).json({ status: 'miss', reason: 'scp_disabled', query: '' });
  });

  // ───────── SportsCardsPro parallel discovery (PR #38b) ─────────
  // Returns the distinct parallel list for a card so the UI parallel
  // picker can show ONLY parallels that SCP actually has for this card,
  // optionally filtered by the scanner's detected color.
  //
  // Called by ScanResult's STEP 3 before it falls back to the local
  // parallels DB. Read-through cache on searchProducts means a repeat
  // scan of the same card hits zero outbound SCP calls.
  //
  // Intentionally always returns 200: an empty list is a normal result
  // (no SCP coverage), not an error state.
  const catalogParallelsSchema = z.object({
    playerName: z.string().trim().optional().nullable(),
    year: z.number().int().optional().nullable(),
    brand: z.string().trim().optional().nullable(),
    collection: z.string().trim().optional().nullable(),
    setName: z.string().trim().optional().nullable(),
    cardNumber: z.string().trim().optional().nullable(),
    // Caller-supplied color filter. When omitted, returns all parallels.
    colorFilter: z.string().trim().optional().nullable(),
    limit: z.number().int().positive().max(200).optional(),
  });

  app.post(`${apiPrefix}/catalog/parallels`, async (req: Request, res: Response) => {
    const parsed = catalogParallelsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        parallels: [],
        filterFellBack: false,
        query: '',
        error: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }
    // PR #162: SCP parallel discovery removed — picker now uses Gemini's
    // detected parallel verbatim plus a free-text fallback (no whitelist
    // filtering). Endpoint kept to avoid breaking any in-flight clients;
    // returns an empty list so callers fall through to their no-parallels
    // code path.
    return res.status(200).json({ parallels: [], filterFellBack: false, query: '' });
  });

  // ───────── eBay Active comps (PR #165) ─────────
  // Active-listings-only Browse API search keyed off final Gemini fields +
  // user-confirmed parallel. PR #163 unmounted the original picker-only
  // /api/picker/ebay-search route; PR #165 brings the underlying
  // ebayPickerSearch module back under a cleaner /api/ebay/comps name and
  // points the result-screen Price tab + the persistent hero "Avg" at it.
  //
  // Active-only by design — the user explicitly confirmed they don't have
  // sold-listings access through the eBay APIs currently in use, so the
  // sold tab from PR #162 is not revived. The dormant module's `sold` /
  // `soldAvailable` fields stay as-is (always empty) so a future MSI-access
  // unlock can flip them on without changing the response shape.
  app.get(`${apiPrefix}/ebay/comps`, async (req, res) => {
    try {
      const { pickerSearch, buildPickerQuery } = await import('./ebayPickerSearch.js');
      const { year, brand, set, cardNumber, player, parallel, subset, gradeKeyword, query: rawQuery, limit } = req.query;
      const parallelStr = typeof parallel === 'string' ? parallel : undefined;
      const subsetStr = typeof subset === 'string' ? subset : undefined;
      const gradeKeywordStr = typeof gradeKeyword === 'string' && gradeKeyword.trim()
        ? gradeKeyword.trim()
        : undefined;
      const query = (typeof rawQuery === 'string' && rawQuery.trim())
        ? rawQuery.trim()
        : buildPickerQuery({
            year: typeof year === 'string' ? year : undefined,
            brand: typeof brand === 'string' ? brand : undefined,
            set: typeof set === 'string' ? set : undefined,
            cardNumber: typeof cardNumber === 'string' ? cardNumber : undefined,
            player: typeof player === 'string' ? player : undefined,
            subset: subsetStr,
            parallel: parallelStr,
            // Bug A (PR #209): apply the negative-keyword chain when the
            // scan is a base card. Skipped automatically inside
            // buildPickerQuery when `parallel` is non-empty. Also skipped
            // when gradeKeyword is set — graded scans use a graded-comp
            // exclusion chain (-raw -ungraded) instead.
            excludeParallels: !parallelStr && !gradeKeywordStr,
            gradeKeyword: gradeKeywordStr,
          });
      const limitNum = Math.max(1, Math.min(parseInt(typeof limit === 'string' ? limit : '10', 10) || 10, 50));
      // Last name is the final whitespace-separated token in the player
      // string ("Drake Powell" → "Powell", "Ronald Acuña Jr." → "Jr.").
      // The post-filter requires both card number AND last name in the
      // listing title, so even a weak last-name token still combines with
      // the card-number gate to produce tight matches.
      const playerStr = typeof player === 'string' ? player : undefined;
      const lastName = playerStr ? playerStr.trim().split(/\s+/).pop() ?? null : null;
      const playerFirstName = playerStr ? playerStr.trim().split(/\s+/)[0] ?? null : null;
      const result = await pickerSearch(query, {
        limit: limitNum,
        requireCardNumber: typeof cardNumber === 'string' ? cardNumber : undefined,
        requirePlayerLastName: lastName,
        scannedParallel: typeof parallel === 'string' ? parallel : undefined,
        brand: typeof brand === 'string' ? brand : undefined,
        set: typeof set === 'string' ? set : undefined,
        year: typeof year === 'string' ? year : undefined,
        playerFirstName,
        // Graded scans require the exact grade phrase ("PSA 10") in titles
        // so the avg price reflects same-grade comps only.
        requireGrade: gradeKeywordStr,
      });
      // Trim the response to the active surface — `sold`/`soldAvailable`
      // are kept off the wire so clients don't accidentally render an
      // unavailable Sold tab. The dormant fields still exist server-side
      // for the eventual MSI-access flip.
      return res.json({ query: result.query, active: result.active });
    } catch (err: any) {
      console.error('[ebay/comps] failed:', err?.message || err);
      return res.status(500).json({ query: '', active: [], error: 'eBay comps lookup failed' });
    }
  });

  // PR G — Single source of truth for the canonical comp-price metric.
  //
  // Pre-PR-G the UI hero averaged ≤10 listings (EbayActiveComps), the
  // Sheet bulk auto-save averaged ≤5 (bulkScan/processor), and the
  // reprice path averaged ≤5 (routes/bulkScan) — three different numbers
  // for the same card. This endpoint hits eBay Browse directly with
  // limit=100 (BIN-only, shipping folded in), applies the same precision
  // filters the picker uses (card # + last name in title), and returns
  // the MEDIAN over the wider pool. Median is robust to the long-tail
  // outliers that skew small-pool means.
  //
  // Mean is returned alongside for diagnostics / backwards compat. The
  // existing `/api/ebay/comps` endpoint above is preserved for the
  // listings strip the UI displays — this is purely an additive endpoint
  // for the price metric.
  app.get(`${apiPrefix}/ebay/comps/summary`, async (req, res) => {
    try {
      const { buildPickerQuery } = await import('./ebayPickerSearch.js');
      const { getCompsSummary } = await import('./ebayCompsSummary.js');
      const { year, brand, set, cardNumber, player, parallel, subset, gradeKeyword, query: rawQuery } = req.query;
      const parallelStr = typeof parallel === 'string' ? parallel : undefined;
      const subsetStr = typeof subset === 'string' ? subset : undefined;
      const gradeKeywordStr = typeof gradeKeyword === 'string' && gradeKeyword.trim()
        ? gradeKeyword.trim()
        : undefined;
      const query = (typeof rawQuery === 'string' && rawQuery.trim())
        ? rawQuery.trim()
        : buildPickerQuery({
            year: typeof year === 'string' ? year : undefined,
            brand: typeof brand === 'string' ? brand : undefined,
            set: typeof set === 'string' ? set : undefined,
            cardNumber: typeof cardNumber === 'string' ? cardNumber : undefined,
            player: typeof player === 'string' ? player : undefined,
            subset: subsetStr,
            parallel: parallelStr,
            excludeParallels: !parallelStr && !gradeKeywordStr,
            gradeKeyword: gradeKeywordStr,
          });
      const playerStr = typeof player === 'string' ? player : undefined;
      const lastName = playerStr ? playerStr.trim().split(/\s+/).pop() ?? null : null;
      const summary = await getCompsSummary(query, {
        requireCardNumber: typeof cardNumber === 'string' ? cardNumber : undefined,
        requirePlayerLastName: lastName,
        requireGrade: gradeKeywordStr,
      });
      return res.json(summary);
    } catch (err: any) {
      console.error('[ebay/comps/summary] failed:', err?.message || err);
      return res.status(500).json({
        median: null,
        mean: null,
        count: 0,
        query: '',
        currency: 'USD',
        error: 'eBay comps summary lookup failed',
      });
    }
  });

  // ── Voice Lookup: transcribe + extract structured card fields ─────────────
  // Public endpoint — user speaks a card ("2025 Topps Series One Nolan
  // Arenado card number 193 pink green polka dots"), we send the audio to
  // Gemini 2.5 Flash which transcribes and returns a structured
  // ExtractedCardFields object. The client renders those fields in a
  // confirm sheet, then maps them into the existing ScanFlow cardData and
  // navigates to /result where runPostScanFlow handles SCP + eBay. No
  // image pipeline, no Holo grading — just identity → price.
  //
  // The endpoint never throws a 5xx; errors come back as
  // { success: false, reason, message } so the client can show a friendly
  // toast. Multer accepts any mimetype here (audio/webm, audio/mp4, etc.)
  // and voiceLookup.ts guards against non-audio uploads.
  app.post(
    `${apiPrefix}/voice-lookup/extract`,
    upload.single('audio'),
    async (req, res) => {
      const voiceStart = Date.now();
      try {
        const file = (req as any).file as Express.Multer.File | undefined;
        if (!file) {
          return res
            .status(200)
            .json({ success: false, reason: 'missing_audio', message: 'No audio file was uploaded.' });
        }
        // Size guard — 15s of compressed audio should be well under 2MB.
        // The multer limit is 60MB for image uploads, so this is our own
        // tighter check for the audio surface.
        if (file.size > 10 * 1024 * 1024) {
          return res
            .status(200)
            .json({
              success: false,
              reason: 'file_too_large',
              message: 'Audio clip is too large. Try a shorter recording.',
            });
        }
        const { extractCardFromAudio } = await import('./voiceLookup');
        const result = await extractCardFromAudio(file.buffer, file.mimetype || 'audio/webm');
        console.log(
          `[voice-lookup] extract ${result.status} in ${Date.now() - voiceStart}ms` +
            (result.status === 'error' ? ` (${result.reason})` : ''),
        );
        if (result.status === 'ok') {
          return res
            .status(200)
            .json({ success: true, transcript: result.transcript, fields: result.fields });
        }
        return res
          .status(200)
          .json({ success: false, reason: result.reason, message: result.message });
      } catch (err) {
        console.error('[voice-lookup] unhandled error:', err);
        return res.status(200).json({
          success: false,
          reason: 'internal_error',
          message: 'Voice lookup failed. Please try again.',
        });
      }
    },
  );

  // ── Voice speculative SCP (F-3b mirror for voice) ────────────────────────
  // Client fires this immediately after /voice-lookup/extract returns, in
  // parallel with rendering the confirm sheet. We kick off an SCP lookup in
  // the background keyed by a client-generated voiceScanId and stash the
  // result in the same scanSession cache used by image-flow F-3b. On confirm,
  // the client hits /voice-lookup/speculative-scp to collect the (usually
  // already-resolved) result and seeds it onto cardData.speculativeCatalog,
  // so CatalogPriceStrip on /result renders immediately without a second
  // /api/catalog/match round trip.
  //
  // Identity gate mirrors F-3b: playerName + one of (brand | year |
  // cardNumber). Voice-extracted fields frequently have all three when the
  // speaker reads the card fully, so the gate is usually satisfied.
  // PSA grade is NOT used here — SCP is price-tier agnostic; PSA only
  // influences the downstream eBay tier selection on /result.
  //
  // All error paths return 200 — a hiccup here must never block the main
  // voice flow.
  app.post(`${apiPrefix}/voice-lookup/preliminary`, async (req, res) => {
    try {
      const voiceScanId = typeof (req.body as any)?.voiceScanId === 'string'
        ? (req.body as any).voiceScanId
        : '';
      const fields = (req.body as any)?.fields as
        | {
            sport?: string | null;
            year?: number | null;
            brand?: string | null;
            collection?: string | null;
            setName?: string | null;
            playerName?: string | null;
            cardNumber?: string | null;
            parallel?: string | null;
            serialNumber?: string | null;
          }
        | undefined;
      if (!voiceScanId || !fields) {
        return res.status(200).json({ success: false, reason: 'missing_fields' });
      }

      // Split playerName into first/last on the server too, so the sanity
      // check in /voice-lookup/speculative-scp can compare against whatever
      // the client ultimately lands on (the client also splits before
      // navigating to /result — see fieldsToCardData in pages/Scan.tsx).
      const { first, last } = splitVoicePlayerName(fields.playerName ?? null);

      const hasSpecGate =
        !!first &&
        !!last &&
        (!!fields.brand || !!fields.year || !!fields.cardNumber);
      if (!hasSpecGate) {
        console.log(`[voice-preliminary-${voiceScanId}] skipped — insufficient fields`);
        return res.status(200).json({ success: false, reason: 'insufficient_fields' });
      }

      // Stash a sparse entry so /voice-lookup/speculative-scp has something
      // to find even before the SCP lookup resolves. frontImageBuffer /
      // frontOCRText stay empty — they're not used on the voice path.
      const { putPendingScan, updatePendingScan } = await import('./scanSession');
      putPendingScan(voiceScanId, {
        frontResult: {
          playerFirstName: first,
          playerLastName: last,
          brand: fields.brand || '',
          year: fields.year ?? 0,
          cardNumber: fields.cardNumber || '',
          collection: fields.collection || '',
          variant: fields.parallel || '',
          serialNumber: fields.serialNumber || '',
        },
        frontOCRText: '',
      });

      const userId = (req.user as any)?.id as number | undefined;
      const specInput: ScpScanQueryInput = {
        playerName: `${first} ${last}`.trim(),
        year: fields.year ?? null,
        brand: fields.brand || null,
        collection: fields.collection || null,
        setName: fields.setName || null,
        cardNumber: fields.cardNumber || null,
        parallel: fields.parallel || null,
      };

      // PR #162: SCP + CardDB grounding removed from the voice path. The
      // picker is now Gemini-authoritative end-to-end and the server-side
      // session entry no longer needs a speculative catalog hit. We still
      // stash explicit nulls so the polling /voice-lookup/speculative-scp
      // endpoint resolves immediately without waiting on a fire that never
      // happens.
      void specInput; // keep the value for future re-enable; reference silences unused-var linting
      updatePendingScan(voiceScanId, { scpResult: null, voiceCardDbResult: null });
      console.log(
        `[voice-preliminary-${voiceScanId}] SCP/CardDB grounding disabled — picker uses Gemini authority.`,
      );

      return res.status(200).json({ success: true });
    } catch (err: any) {
      console.error('[voice-preliminary] unhandled error:', err?.message || err);
      return res.status(200).json({ success: false, reason: 'internal_error' });
    }
  });

  // Consume the speculative SCP result for a voice scan. The client calls
  // this on confirm; the server briefly waits (up to 2s) for the lookup to
  // resolve so slow-resolving SCP calls still benefit. On hit, we sanity-check
  // that the player identity the client is about to navigate with still
  // matches what was fired — if the user edited the player in the confirm
  // sheet, drop the speculative and let the client's fresh /api/catalog/match
  // run (mirrors the image-flow player-identity guard in the dual handler).
  app.get(`${apiPrefix}/voice-lookup/speculative-scp`, async (req, res) => {
    try {
      const voiceScanId = typeof req.query.voiceScanId === 'string' ? req.query.voiceScanId : '';
      const finalFirst = (
        typeof req.query.playerFirstName === 'string' ? req.query.playerFirstName : ''
      ).toLowerCase().trim();
      const finalLast = (
        typeof req.query.playerLastName === 'string' ? req.query.playerLastName : ''
      ).toLowerCase().trim();
      if (!voiceScanId) {
        return res.status(200).json({ success: false, reason: 'missing_voice_scan_id' });
      }

      const { peekPendingScan, waitForPendingScan } = await import('./scanSession');
      // First peek — if the entry is present but scpResult/voiceCardDbResult
      // is still undefined, waitForPendingScan returns the entry shell
      // immediately. We then poll briefly for BOTH lookup results (SCP and
      // CardDB) to resolve before responding.
      let entry = peekPendingScan(voiceScanId);
      if (!entry) {
        entry = await waitForPendingScan(voiceScanId, 500);
      }
      if (!entry) {
        return res.status(200).json({ success: true, scpResult: null, cardDbResult: null });
      }

      // Poll for both scpResult and voiceCardDbResult up to 2s — SCP is
      // typically <1s and CardDB is typically <50ms (local SQLite), so the
      // bottleneck is SCP. `undefined` = still in flight, `null` = completed
      // as a miss. We wait until neither is undefined, then forward both.
      const lookupsPending = () =>
        entry!.scpResult === undefined || entry!.voiceCardDbResult === undefined;
      if (lookupsPending()) {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
          const fresh = peekPendingScan(voiceScanId);
          if (!fresh) break; // evicted
          entry = fresh;
          if (!lookupsPending()) break;
        }
      }
      if (!entry) {
        return res.status(200).json({ success: true, scpResult: null, cardDbResult: null });
      }

      // Player-identity sanity check — only enforce on hit. Misses are safe
      // to forward regardless (saves a redundant round trip for a query we
      // already know can't match).
      const specPlayerFirst = (entry.frontResult.playerFirstName || '').toLowerCase();
      const specPlayerLast = (entry.frontResult.playerLastName || '').toLowerCase();
      const playerMatches =
        specPlayerFirst === finalFirst && specPlayerLast === finalLast;

      let scpResultToReturn: typeof entry.scpResult | null = entry.scpResult ?? null;
      if (scpResultToReturn && scpResultToReturn.status === 'hit') {
        if (!playerMatches) {
          console.log(
            `[voice-speculative-scp] discarding hit for voiceScanId=${voiceScanId}` +
              ` — player identity changed (${specPlayerFirst} ${specPlayerLast} → ${finalFirst} ${finalLast})`,
          );
          scpResultToReturn = null;
        } else {
          console.log(
            `[voice-speculative-scp] forwarding hit for voiceScanId=${voiceScanId}` +
              ` (score ${scpResultToReturn.match.matchScore})`,
          );
        }
      } else if (scpResultToReturn) {
        console.log(
          `[voice-speculative-scp] forwarding miss (${scpResultToReturn.reason}) for voiceScanId=${voiceScanId}`,
        );
      }

      // H-5: CardDB enrichment — same player-identity guard. If the user
      // edited the player in the confirm sheet, discard the enrichment
      // because it was computed against the original spoken player.
      let cardDbResultToReturn: typeof entry.voiceCardDbResult | null =
        entry.voiceCardDbResult ?? null;
      if (cardDbResultToReturn) {
        if (!playerMatches) {
          console.log(
            `[voice-speculative-carddb] discarding hit for voiceScanId=${voiceScanId}` +
              ` — player identity changed`,
          );
          cardDbResultToReturn = null;
        } else {
          console.log(
            `[voice-speculative-carddb] forwarding ${cardDbResultToReturn.source} hit for voiceScanId=${voiceScanId}` +
              ` — cardNumber="${cardDbResultToReturn.hit.cardNumber}" rookie=${!!cardDbResultToReturn.hit.isRookieCard}`,
          );
        }
      }

      return res.status(200).json({
        success: true,
        scpResult: scpResultToReturn,
        cardDbResult: cardDbResultToReturn,
      });
    } catch (err: any) {
      console.error('[voice-speculative-scp] unhandled error:', err?.message || err);
      return res.status(200).json({ success: true, scpResult: null });
    }
  });

  // ── F-3a: Preliminary front-side scan ─────────────────────────────────────
  // Fires from the client on front shutter (before the user flips the card).
  // Runs Google Vision OCR + the dynamic card analyzer on the front image
  // only, then stashes the result in an in-memory session cache keyed by
  // scanId. When the final dual upload arrives, /analyze-card-dual-images
  // pulls the cached result and skips the front leg of the OCR pipeline.
  //
  // Response is intentionally minimal — the client just needs to know the
  // stash succeeded (or silently failed). All error paths return 200 so a
  // hiccup in this optimization can never block the main scan flow.
  app.post(`${apiPrefix}/scan/preliminary`, upload.single('frontImage'), async (req, res) => {
    const prelimStart = Date.now();
    const logPrelimTotal = (tag: string) => {
      console.log(`[preliminary-total] ${tag} took ${Date.now() - prelimStart}ms`);
    };
    try {
      const scanId = typeof (req.body as any)?.scanId === 'string' ? (req.body as any).scanId : '';
      const file = (req as any).file as Express.Multer.File | undefined;

      if (!scanId || !/^[a-zA-Z0-9_-]{8,64}$/.test(scanId)) {
        logPrelimTotal('bad-scanid');
        return res.status(200).json({ success: false, reason: 'invalid_scan_id' });
      }
      if (!file) {
        logPrelimTotal('no-file');
        return res.status(200).json({ success: false, reason: 'missing_front_image' });
      }
      if (file.size > 20 * 1024 * 1024) {
        logPrelimTotal('too-large');
        return res.status(200).json({ success: false, reason: 'file_too_large' });
      }
      if (!file.mimetype?.startsWith('image/')) {
        logPrelimTotal('bad-mime');
        return res.status(200).json({ success: false, reason: 'invalid_mime' });
      }

      // Normalize EXIF orientation once so the cached buffer is drop-in
      // replaceable when the main handler runs later.
      const { normalizeImageOrientation, runFrontSideAnalyzer } = await import('./dualSideOCR');
      const normalized = await normalizeImageOrientation(file.buffer, 'front');

      // ── F-3c: Preliminary visual-foil detection ───────────────────────
      // Run the front-side OCR + analyzer AND the visual-foil detector in
      // parallel on the same normalized buffer. The main dual-image handler
      // uses the cached hint to skip its own `detectFoilFromImage` Vision
      // call inside `combineCardResults`, shaving ~300-600ms off the total
      // scan latency (foil detection is a separate Vision API round trip).
      //
      // `isNumbered: false` because we don't yet have the back-side serial.
      // The confidence thresholds and FoilDB validation that depend on
      // back-side context still run in `combineCardResults` at their
      // existing spot; the preliminary hint is just the raw visual signal.
      const { detectFoilFromImage } = await import('./visualFoilDetector');
      console.time(`preliminary-analyze-${scanId}`);
      const [
        { result: frontResult, ocrText: frontOCRText },
        visualFoilPrelimSettled,
      ] = await Promise.all([
        runFrontSideAnalyzer(normalized),
        detectFoilFromImage(normalized.toString('base64'), {
          isNumbered: false,
          imageBuffer: normalized,
        }).then(
          (r) => ({ ok: true as const, value: r }),
          // Never fail the preliminary call on a visual-foil detector error
          // — just stash `null` and let the main handler run its own pass.
          (err) => {
            console.warn(`[preliminary-foil-${scanId}] failed:`, err?.message || err);
            return { ok: false as const, value: null };
          },
        ),
      ]);
      console.timeEnd(`preliminary-analyze-${scanId}`);
      const visualFoilPrelim = visualFoilPrelimSettled.value;

      const { putPendingScan, updatePendingScan } = await import('./scanSession');
      putPendingScan(scanId, {
        frontResult,
        frontOCRText,
        frontImageBuffer: normalized,
        visualFoilPrelim,
      });

      // ── F-3b: Speculative SportsCardsPro lookup ─────────────────────────
      // Most of a successful SCP hit's cost is network latency to the SCP
      // API (~hundreds of ms). If the front alone gave us enough identity
      // to form a reasonable query, kick off the lookup NOW so its result
      // is waiting in the pending entry by the time the user presses "Use
      // photo" on the back. The main /analyze-card-dual-images handler
      // will attach any completed result to its response as
      // `speculativeCatalog`, and the client short-circuits the separate
      // /api/catalog/match round trip when present.
      //
      // Gate: playerName + at least one of (brand | year | cardNumber).
      // Most flagship cards have brand on the back only, so `year` or
      // `cardNumber` on the front are the common triggers here.
      // PR #162: speculative SCP lookup removed from the preliminary path.
      // The picker is Gemini-authoritative now, so the catalog hint is
      // unused downstream. Stash null so any cache poller resolves cleanly.
      updatePendingScan(scanId, { scpResult: null });
      console.log(`[preliminary-scp-${scanId}] disabled — picker uses Gemini authority.`);

      logPrelimTotal('ok');
      // Expose a minimal slice of the visual-foil hint in the response so
      // the client can surface a "parallel detected" UI earlier if desired.
      // The full detection result (including indicators + regional evidence)
      // lives in the pending entry for the main handler to consume.
      return res.status(200).json({
        success: true,
        visualFoil: visualFoilPrelim
          ? {
              isFoil: visualFoilPrelim.isFoil,
              foilType: visualFoilPrelim.foilType,
              confidence: visualFoilPrelim.confidence,
            }
          : null,
      });
    } catch (err: any) {
      // Never bubble an error to the client — this is a speculative fetch.
      console.error('[preliminary] unexpected error:', err?.message || err);
      logPrelimTotal('error');
      return res.status(200).json({ success: false, reason: 'internal_error' });
    }
  });

  // Dual-image OCR + eBay price lookup endpoint (front for RC, back for details)
  //
  // Quota: same pattern as /analyze-card-image — `requireScanQuota` rejects
  // upfront when the user has hit `users.scanLimit`, and a finish-hook
  // increments scanCount only on 200 responses (the multi-branch ebay
  // success paths all funnel through res.json with status 200, while
  // 400/500 exits never count).
  // Shared handler body for /analyze-card-dual-images and the SSE
  // streaming sibling /analyze-card-dual-images/stream (PR H). The
  // streaming route invokes this with a mock `res` that captures the
  // final JSON payload, which it then ships as the trailing SSE
  // `result` event after the chip-progress events emitted by
  // dualSideOCR.ts.
  async function runAnalyzeCardDualImages(req: Request, res: Response): Promise<any> {
    const quotaUserId = (req.user as any)?.id as number | undefined;
    res.on('finish', () => {
      if (res.statusCode === 200) void incrementScanCount(quotaUserId);
    });
    // ── Scan-wide latency instrumentation ─────────────────────────────────────
    // Single wall-clock timer around the whole handler so mobile dev-log tailing
    // always gets one authoritative "scan-total" number no matter which exit
    // path the response takes (success, empty eBay, eBay error, 400, 500).
    // Individual phase timers (vision-batch, dual-analyzers, combine-card-
    // results, holo-claude, ebay-main-search) are started inline below.
    const scanStart = Date.now();
    const logScanTotal = (tag: string) => {
      console.log(`[scan-total] ${tag} took ${Date.now() - scanStart}ms`);
    };
    try {
      console.log('=== DUAL IMAGE ROUTE CALLED ===');
      console.log('Request received at:', new Date().toISOString());
      
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      console.log('Files received:', files ? Object.keys(files) : 'No files');
      
      if (!files || !files.backImage || !files.backImage[0]) {
        console.log('Missing back image - returning error');
        logScanTotal('400-missing-back');
        return res.status(400).json({ 
          success: false,
          message: 'Back image is required for card analysis',
          error: 'missing_back_image'
        });
      }

      console.log('Starting dual-image OCR + eBay price analysis...');
      console.log('ROUTE HANDLER IS DEFINITELY CALLED!');

      // Holo (Claude) is now a GRADE-ONLY service. Identification is owned
      // end-to-end by Google Vision OCR, the local card database, and the
      // SportsCardsPro catalog — this avoids Sonnet hallucinating parallels
      // that don't exist for a given set (e.g. "Pink Speckle Refractor" on
      // Topps flagship, which has no refractors). Holo runs in parallel
      // with the OCR pipeline so the scan still returns even if Claude is
      // unavailable; `identification` is always persisted as null.
      //
      // Auto-grading is opt-in per user (users.preferences.autoGrade,
      // default false). Dealers inventorying hundreds of raw cards don't
      // want to pay the ~several-second Claude round-trip on every scan,
      // so when the flag is off we short-circuit to null — the rest of
      // the pipeline already handles a missing holo result gracefully
      // (HoloGradeCard + the grade tone pill conditionally render).
      const userId = (req.user as any)?.id as number | undefined;
      const prefs = await getUserPreferences(userId);
      const autoGradeEnabled = prefs.autoGrade === true;
      const frontFileForHolo = files.frontImage?.[0];
      const backFileForHolo = files.backImage?.[0];

      // Persist the scanned images to Replit Object Storage (GCS-backed)
      // so the Home screen's Recent Scans carousel can render a real
      // thumbnail instead of a camera-icon placeholder. We used to write
      // these to a local `./uploads/` dir under the container, but Replit
      // Autoscale wipes the filesystem on every deploy and every new
      // instance spawn — the DB row outlives the container, so old URLs
      // 404ed immediately. Object Storage is persistent across deploys.
      //
      // `storage.saveImage` stores the blob under `/objects/uploads/<uuid>`,
      // which is served by the GET /objects/:path handler registered in
      // server/replit_integrations/object_storage/routes.ts. Failures
      // are non-fatal: we fall back to the original filename-only
      // behavior so a scan never breaks if Object Storage is unreachable.
      //
      // Hoisted out of the Holo IIFE so image persistence + the scan_grades
      // row creation run even when auto-grade is OFF. Otherwise every scan
      // a user made while auto-grade was disabled (the default) was invisible
      // to Recent Scans — we would never insert a row, and the Home carousel
      // stayed empty no matter how many cards the user scanned.
      const persistScanImage = async (
        file: Express.Multer.File,
        side: 'front' | 'back',
      ): Promise<string | null> => {
        try {
          const contentType = file.mimetype || 'image/jpeg';
          const dataUrl = `data:${contentType};base64,${file.buffer.toString('base64')}`;
          const filename = `scan_${side}_${file.originalname || 'scan.jpg'}`;
          return await storage.saveImage(dataUrl, filename);
        } catch (writeErr) {
          console.warn(`Scan: failed to persist ${side} scan image to Object Storage:`, writeErr);
          return null;
        }
      };
      // Kick off image persistence immediately, in parallel with Holo + OCR.
      // Both the graded and ungraded scan_grades insert branches below await
      // this promise before writing the row so frontImagePath is populated.
      const imagePersistPromise: Promise<{ frontUrl: string | null; backUrl: string | null }> =
        (async () => {
          if (!frontFileForHolo) return { frontUrl: null, backUrl: null };
          const [frontUrl, backUrl] = await Promise.all([
            persistScanImage(frontFileForHolo, 'front'),
            backFileForHolo ? persistScanImage(backFileForHolo, 'back') : Promise.resolve(null),
          ]);
          return { frontUrl, backUrl };
        })();

      type HoloResponse = (HoloGrade & {
        id: number;
        createdAt: Date;
        identification: null;
        /** True when the row is a placeholder inserted without a real grade
         *  (auto-grade off). The UI uses this to hide the grade pill. */
        ungraded?: boolean;
      }) | null;

      // When auto-grade is OFF (or Holo fails for any reason) we still want
      // Recent Scans to reflect the scan event — otherwise dealers turning off
      // auto-grade (the default) see an empty Home carousel forever. Insert a
      // sentinel scan_grades row with zeroed sub-grades and model='none' so the
      // row satisfies the NOT NULL constraints without schema churn. The UI
      // treats gradeLabel='UNGRADED' / model='none' as "no grade" and renders
      // the card thumbnail + identification only (no grade pill).
      //
      // Defined as a lazy factory (not an IIFE) because we only want to insert
      // this row when the real grade didn't materialize. Running it eagerly
      // would duplicate every successful graded scan with a paired ungraded row.
      const insertUngradedScanRow = async (): Promise<HoloResponse> => {
        if (!frontFileForHolo) return null;
        try {
          const { frontUrl, backUrl } = await imagePersistPromise;
          const placeholderGrade: HoloGrade = {
            centering: { score: 0, notes: '' },
            centeringBack: null,
            corners: { score: 0, notes: '' },
            edges: { score: 0, notes: '' },
            surface: { score: 0, notes: '' },
            overall: 0,
            label: 'UNGRADED',
            notes: [],
            confidence: 0,
            model: 'none',
            frontOnly: !backFileForHolo,
          } as unknown as HoloGrade;
          const row = await saveGrade({
            userId: userId ?? null,
            frontImagePath: frontUrl || frontFileForHolo.originalname || null,
            backImagePath: backUrl || backFileForHolo?.originalname || null,
            grade: placeholderGrade,
            identification: null,
          });
          return {
            ...placeholderGrade,
            id: row.id,
            createdAt: row.createdAt,
            identification: null,
            ungraded: true,
          };
        } catch (err) {
          console.warn('Scan: failed to persist ungraded scan_grades row:', err);
          return null;
        }
      };

      const holoPromise: Promise<HoloResponse> = (async () => {
        try {
          if (!autoGradeEnabled) {
            console.log('Holo: auto-grade disabled for user, inserting ungraded scan row');
            return await insertUngradedScanRow();
          }
          if (!frontFileForHolo) {
            console.log('Holo: no front image provided, skipping analysis');
            return null;
          }
          const frontInput = {
            base64: frontFileForHolo.buffer.toString('base64'),
            mediaType: (frontFileForHolo.mimetype || 'image/jpeg') as any,
          };
          const backInput = backFileForHolo
            ? {
                base64: backFileForHolo.buffer.toString('base64'),
                mediaType: (backFileForHolo.mimetype || 'image/jpeg') as any,
              }
            : undefined;
          console.log('Holo: starting grade-only analysis...');
          const { grade }: HoloAnalysis = await analyzeCard(
            frontInput,
            backInput,
          );
          console.log(
            'Holo: grade complete -',
            grade.label,
            `(${grade.overall}, grade conf ${grade.confidence.toFixed(2)})`,
          );
          const { frontUrl, backUrl } = await imagePersistPromise;
          try {
            const row = await saveGrade({
              userId: userId ?? null,
              frontImagePath: frontUrl || frontFileForHolo.originalname || null,
              backImagePath: backUrl || backFileForHolo?.originalname || null,
              grade,
              identification: null,
            });
            return {
              ...grade,
              id: row.id,
              createdAt: row.createdAt,
              identification: null,
            };
          } catch (persistErr) {
            console.warn('Holo: failed to persist, returning in-memory:', persistErr);
            return {
              ...grade,
              id: 0,
              createdAt: new Date(),
              identification: null,
            };
          }
        } catch (err) {
          if (err instanceof HoloNotConfiguredError) {
            console.log('Holo: ANTHROPIC_API_KEY not set, inserting ungraded scan row');
            return await insertUngradedScanRow();
          }
          console.error('Holo: analysis failed, falling back to ungraded scan row:', err);
          return await insertUngradedScanRow();
        }
      })();

      // ── GRADED-mode: kick off slab-label VLM in parallel ─────────────
      // Client-supplied `mode` field on the multipart body distinguishes
      // RAW vs GRADED. When mode=graded AND a label image was uploaded,
      // we run the dedicated grading-label prompt against the cropped
      // strip in parallel with the card-body OCR so the request still
      // resolves in one round trip. On any failure we just log and
      // continue with isGraded=false; the scan still works.
      const requestedMode = ((req.body as any)?.mode || '').toString().toLowerCase();
      const isGradedMode = requestedMode === 'graded';
      const labelFile = (files as any).gradingLabelImage?.[0] as Express.Multer.File | undefined;
      const gradingLabelPromise: Promise<import('./vlmGradingPrompt').GradingLabelResult | null> =
        (async () => {
          if (!isGradedMode || !labelFile) return null;
          try {
            const { analyzeGradingLabelWithGemini } = await import('./vlmGrading');
            const result = await analyzeGradingLabelWithGemini(labelFile.buffer, {
              mime: labelFile.mimetype || 'image/jpeg',
            });
            console.log(
              '[grading-label] vlm complete:',
              `company=${result.gradingCompany} grade=${result.numericalGrade}`,
              `cert=${result.certificationNumber ?? 'n/a'} qual=${result.gradeQualifier ?? 'n/a'}`,
            );
            return result;
          } catch (err: any) {
            console.warn('[grading-label] vlm failed (continuing as RAW):', err?.message || err);
            return null;
          }
        })();

      // Analyze back image for detailed card information
      const backFile = files.backImage[0];
      console.log('Analyzing back image for card details...');
      
      // Use dual-side analysis for both front and back images
      const { handleDualSideCardAnalysis } = await import('./dualSideOCR');
      
      // Call the dual-side handler directly
      console.log('About to call handleDualSideCardAnalysis directly...');
      const dualRequest = {
        files: {
          backImage: [backFile],
          ...(files.frontImage && { frontImage: files.frontImage })
        },
        body: req.body || {},
        query: req.query || {},
      } as any;
      
      let backOcrResponse: any = null;
      
      await new Promise<void>((resolve, reject) => {
        const mockResponse = {
          json: (data: any) => {
            console.log('Mock response received:', JSON.stringify(data, null, 2));
            backOcrResponse = data;
            resolve();
          },
          status: (code: number) => ({
            json: (data: any) => {
              console.error(`Dual OCR failed with status ${code}:`, data);
              reject(new Error(`Dual OCR failed with status ${code}: ${JSON.stringify(data)}`));
            }
          })
        };
        
        handleDualSideCardAnalysis(dualRequest, mockResponse as any);
      });

      // Dual-side analysis now handles rookie card detection automatically

      console.time('holo-claude');
      const holoResolved = await holoPromise;
      console.timeEnd('holo-claude');

      // The ungraded sentinel row is only useful for Recent Scans bookkeeping —
      // the ScanResult page expects `data.holo` to be null when there is no
      // real grade, otherwise it would render a giant "0 UNGRADED" pill in the
      // hero. Strip the placeholder here so the client payload keeps its
      // pre-existing "no grade" shape while the DB row still exists for the
      // Home carousel + identification backfill below.
      const holoForClient = holoResolved && (holoResolved as any).ungraded
        ? null
        : holoResolved;

      // Holo is grade-only now — identification comes exclusively from the
      // OCR pipeline (Google Vision → local card DB → SCP catalog). If OCR
      // fails we still return whatever partial data it produced so the
      // client can show the user what was read and let them retry.
      if (!backOcrResponse.success || !backOcrResponse.data) {
        return res.json({
          success: true,
          data: {
            ...(backOcrResponse?.data || {}),
            ebayResults: {
              averageValue: 0,
              results: [],
              searchUrl: '',
              errorMessage: 'Could not analyze card for pricing',
              dataType: 'sold'
            },
            holo: holoForClient,
          }
        });
      }

      // Confirmed-card lookups used to override scan results to firm up the
      // database. Now that the player card_database is populated, the DB
      // lookup is the authoritative source — confirmed thumbs-up presses are
      // still recorded via POST /api/confirmed-cards as positive feedback,
      // but they no longer alter the result of a fresh scan.
      console.log('OCR analysis successful, skipping confirmed-card override (DB lookup is authoritative)');

      // OCR output flows straight through as card identification. Holo
      // contributes only the grade (attached as `data.holo` below).
      const cardData = backOcrResponse.data;

      // ── Cross-validate slab label vs card-body extraction ────────────
      // For GRADED scans, prefer the slab label's identity fields when they
      // disagree with the card-body OCR — the grader's data entry is more
      // authoritative than VLM extraction off a glare-prone slab photo.
      // Mismatches are logged so the dealer can review later. When the
      // slab returns null/empty for a field, keep whatever cardData has.
      const gradingLabel = await gradingLabelPromise;
      if (gradingLabel) {
        const discrepancies: string[] = [];
        const note = (label: string, fromBody: any, fromLabel: any) => {
          if (fromLabel == null || fromLabel === '') return;
          const a = (fromBody ?? '').toString().trim().toLowerCase();
          const b = (fromLabel ?? '').toString().trim().toLowerCase();
          if (!a) return; // body had nothing — silent overwrite is fine
          if (a !== b) discrepancies.push(`${label}: body="${fromBody}" label="${fromLabel}"`);
        };
        note('year', cardData.year, gradingLabel.year);
        note('cardNumber', cardData.cardNumber, gradingLabel.cardNumber);
        note('set', cardData.set, gradingLabel.set);
        if (gradingLabel.player) {
          const composedBody = [cardData.playerFirstName, cardData.playerLastName]
            .filter(Boolean).join(' ').trim();
          note('player', composedBody, gradingLabel.player);
        }
        if (discrepancies.length) {
          console.warn(
            `[grading-label] cross-val mismatch (preferring slab label): ${discrepancies.join('; ')}`,
          );
        }
        // Apply slab-label fields preferentially.
        if (gradingLabel.year != null) cardData.year = gradingLabel.year;
        if (gradingLabel.cardNumber) cardData.cardNumber = gradingLabel.cardNumber;
        if (gradingLabel.set) cardData.set = gradingLabel.set;
        if (gradingLabel.parallel) {
          cardData.variant = cardData.variant || gradingLabel.parallel;
        }
        if (gradingLabel.player) {
          const tokens = gradingLabel.player.trim().split(/\s+/).filter(Boolean);
          if (tokens.length >= 1) {
            cardData.playerFirstName = tokens[0];
            cardData.playerLastName = tokens.slice(1).join(' ') || cardData.playerLastName;
          }
        }
        // Stamp graded fields onto the cardData payload so the client
        // (ScanResult) and downstream consumers (eBay query, sheet write)
        // see them under their canonical names.
        cardData.isGraded = true;
        cardData.gradingCompany = gradingLabel.gradingCompany;
        cardData.numericalGrade = gradingLabel.numericalGrade;
        cardData.gradeQualifier = gradingLabel.gradeQualifier;
        cardData.certificationNumber = gradingLabel.certificationNumber;
      } else if (isGradedMode) {
        // GRADED requested but the label VLM failed or wasn't usable. We
        // still mark the card as graded=true so the UI doesn't snap back
        // to the RAW comp tier; null company/grade fields will surface a
        // friendly "couldn't read the label" hint on the result page.
        cardData.isGraded = true;
      }

      // Lighting / blur diagnostics from the client. Logged for inspection
      // and surfaced in the response so the result page can show a banner
      // when the captured image quality may have hurt extraction.
      const clientLighting = ((req.body as any)?.clientLighting || '').toString();
      const clientBlurScore = (() => {
        const raw = (req.body as any)?.clientBlurScore;
        if (raw == null || raw === '') return null;
        const n = typeof raw === 'number' ? raw : Number(raw);
        return Number.isFinite(n) ? n : null;
      })();
      // Burst-picked sharpness from the in-camera 3-frame pick. Decoupled
      // from clientBlurScore (which is the live-preview 64x64 pre-shutter
      // sample) — these scores are computed off the actual saved frame's
      // 480x480 center crop, so they can be compared apples-to-apples
      // across scans for threshold tuning. Both nullable: not all client
      // builds emit them, and the flash-on capture path skips the burst.
      const parseSharpness = (raw: unknown): number | null => {
        if (raw == null || raw === '') return null;
        const n = typeof raw === 'number' ? raw : Number(raw);
        return Number.isFinite(n) ? n : null;
      };
      const frontSharpness = parseSharpness((req.body as any)?.frontSharpness);
      const backSharpness = parseSharpness((req.body as any)?.backSharpness);
      if (clientLighting || clientBlurScore != null || frontSharpness != null || backSharpness != null) {
        console.log(
          `[scan-quality] clientLighting=${clientLighting || 'unknown'}`,
          `clientBlurScore=${clientBlurScore ?? 'n/a'}`,
          `frontSharpness=${frontSharpness != null ? frontSharpness.toFixed(2) : 'n/a'}`,
          `backSharpness=${backSharpness != null ? backSharpness.toFixed(2) : 'n/a'}`,
          `mode=${isGradedMode ? 'graded' : 'raw'}`,
        );
      }
      if (clientLighting) (cardData as any).clientLighting = clientLighting;
      if (clientBlurScore != null) (cardData as any).clientBlurScore = clientBlurScore;
      // Surface burst-picked sharpness on the response payload so the
      // result page can render a "this scan came from a soft photo"
      // hint without re-computing.
      if (frontSharpness != null) (cardData as any).frontSharpness = frontSharpness;
      if (backSharpness != null) (cardData as any).backSharpness = backSharpness;

      // Patch the scan_grades row with the OCR-derived identification so
      // Home's Recent Scans carousel renders the player's name instead of
      // "Unknown card". saveGrade() persisted the row with identification=null
      // because it ran in parallel with the back OCR; now that cardData is
      // in hand we can backfill the identification column.
      try {
        const gradeRowId = holoResolved?.id;
        if (gradeRowId) {
          const playerName = [cardData.playerFirstName, cardData.playerLastName]
            .filter(Boolean)
            .join(' ')
            .trim();
          if (playerName) {
            await updateGradeIdentification(gradeRowId, {
              player: playerName,
              brand: cardData.brand ?? null,
              setName: cardData.set ?? cardData.collection ?? '',
              collection: cardData.collection ?? null,
              year: cardData.year != null ? String(cardData.year) : '',
              cardNumber: cardData.cardNumber ?? null,
              serialNumber: cardData.serialNumber ?? null,
              parallel: cardData.foilType ?? null,
              variant: cardData.variant ?? null,
              cmpCode: cardData.cmpNumber ?? null,
              sport: cardData.sport ?? '',
              confidence: typeof cardData.confidence === 'number' ? cardData.confidence : 0,
            });
            // Keep the in-memory grade in sync so any downstream consumer
            // (currently none, but future-proofing) sees the enriched id.
            (holoResolved as any).identification = {
              player: playerName,
              year: cardData.year != null ? String(cardData.year) : null,
              brand: cardData.brand ?? null,
              setName: cardData.set ?? cardData.collection ?? null,
            };
          }
        }
      } catch (identErr) {
        console.warn('Failed to backfill scan grade identification:', identErr);
      }

      // ── F-3b: Surface any speculative SportsCardsPro result ───────────────
      // The preliminary handler fires an SCP lookup in the background when
      // the front OCR has enough identity to form a query. By the time the
      // user finishes capturing the back and the dual upload arrives, that
      // lookup has typically already resolved. Peek (don't take) the entry
      // here and forward the result to the client so the ScanResult page
      // renders SCP pricing immediately without a second /api/catalog/match
      // round trip. TTL/GC handles eviction — we never consume. On miss or
      // still-in-flight (no scpResult yet), the client falls through to its
      // existing fetch path with zero regression.
      let speculativeCatalog: any = null;
      const dualScanId: string | undefined =
        typeof (req.body as any)?.scanId === 'string' ? (req.body as any).scanId : undefined;
      if (dualScanId) {
        try {
          const { peekPendingScan } = await import('./scanSession');
          const entry = peekPendingScan(dualScanId);
          if (entry && entry.scpResult) {
            // Sanity check: only forward a HIT whose player name matches the
            // final merged cardData. If the back OCR flipped the player (rare
            // but possible on a misread), the speculative result is stale
            // and we let the client's fresh lookup run.
            if (entry.scpResult.status === 'hit') {
              const specPlayerFirst = (entry.frontResult.playerFirstName || '').toLowerCase();
              const specPlayerLast = (entry.frontResult.playerLastName || '').toLowerCase();
              const finalFirst = (cardData.playerFirstName || '').toLowerCase();
              const finalLast = (cardData.playerLastName || '').toLowerCase();
              const playerMatches =
                specPlayerFirst === finalFirst && specPlayerLast === finalLast;
              if (playerMatches) {
                speculativeCatalog = entry.scpResult;
                console.log(
                  `[scanSession] forwarding speculative SCP hit for scanId=${dualScanId}` +
                  ` (score ${entry.scpResult.match.matchScore})`,
                );
              } else {
                console.log(
                  `[scanSession] discarding speculative SCP for scanId=${dualScanId}` +
                  ` — player identity changed (${specPlayerFirst} ${specPlayerLast} → ${finalFirst} ${finalLast})`,
                );
              }
            } else {
              // Forward the miss too — saves the client a redundant round
              // trip for a query we already know SCP can't match.
              speculativeCatalog = entry.scpResult;
              console.log(
                `[scanSession] forwarding speculative SCP miss (${entry.scpResult.reason}) for scanId=${dualScanId}`,
              );
            }
          }
        } catch (specErr: any) {
          // Never let a speculative-cache hiccup fail the main scan.
          console.warn('[scanSession] speculativeCatalog peek failed:', specErr?.message || specErr);
        }
      }

      console.log('Starting eBay price lookup...');
      
      try {
        const searchQuery = `${cardData.playerFirstName || ''} ${cardData.playerLastName || ''} ${cardData.brand || ''} ${cardData.collection || ''} ${cardData.cardNumber || ''} ${cardData.year || ''}`.trim();
        
        if (searchQuery.length > 5) {
          console.log('Searching eBay with query:', searchQuery);
          
          const playerName = `${cardData.playerFirstName} ${cardData.playerLastName}`.trim();
          console.time('ebay-main-search');
          // GRADED scan: pass the resolved grade keyword (e.g. "PSA 10") so
          // searchCardValues filters its candidate pool to slabbed comps and
          // getEbaySearchUrl appends the same phrase to the click-through URL.
          // RAW scans pass nothing and the existing behavior is preserved.
          const { formatGradeKeyword } = await import('./vlmGradingPrompt');
          const gradeKeyword = cardData.isGraded
            ? formatGradeKeyword(cardData.gradingCompany, cardData.numericalGrade) || undefined
            : undefined;
          // Race the eBay search against an 800ms timeout so a slow eBay day
          // doesn't keep the user staring at a spinner after Gemini already
          // burned ~17s. If eBay wins, behavior is identical to before. If
          // the timeout wins, the response ships with ebayResults=null and
          // the client's EbayActiveComps fetches comps post-mount; the
          // original eBay promise is NOT cancelled so updateGradeEstimatedValue
          // still fires when it eventually resolves.
          const EBAY_RACE_TIMEOUT_MS = 800;
          const ebayPromise = searchCardValues(
            playerName,
            cardData.cardNumber || '',
            cardData.brand || '',
            cardData.year || 2024,
            cardData.collection,
            '',
            cardData.isNumbered || false,
            cardData.foilType,
            cardData.serialNumber,
            cardData.variant,
            cardData.isAutographed || false,
            undefined,
            cardData.set,
            gradeKeyword ? { gradeKeyword } : undefined,
          );
          const TIMEOUT_SENTINEL = Symbol('ebay-race-timeout');
          const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
            setTimeout(() => resolve(TIMEOUT_SENTINEL), EBAY_RACE_TIMEOUT_MS),
          );
          const raceResult = await Promise.race([ebayPromise, timeoutPromise]);
          console.timeEnd('ebay-main-search');

          const persistEstimatedValue = (results: Awaited<typeof ebayPromise>) => {
            const gradeRowId = holoResolved?.id;
            const averageValue = results?.averageValue;
            if (
              gradeRowId != null &&
              typeof averageValue === 'number' &&
              averageValue > 0
            ) {
              void updateGradeEstimatedValue(gradeRowId, averageValue).catch((err) => {
                console.warn('[scan_grades] estimatedValue update failed (non-blocking):', err);
              });
            }
          };

          if (raceResult === TIMEOUT_SENTINEL) {
            console.log(
              `[ebay-race] race-lost — eBay slower than ${EBAY_RACE_TIMEOUT_MS}ms; shipping response with ebayResults=null`,
            );
            // Background-resolve so estimatedValue still gets persisted.
            // Discovered variant/collection backfills are intentionally
            // dropped on this branch — they shape the response and can't be
            // retroactively patched after res.json ships.
            ebayPromise
              .then((results) => {
                persistEstimatedValue(results);
              })
              .catch((err) => {
                console.warn('[ebay-race] background eBay resolution failed:', err?.message || err);
              });
            logScanTotal('ok');
            return res.json({
              success: true,
              data: {
                ...cardData,
                ebayResults: null,
                holo: holoForClient,
                speculativeCatalog,
              }
            });
          }

          console.log('[ebay-race] race-won — eBay returned within timeout');
          const ebayResults = raceResult;
          console.log('eBay search results:', ebayResults);

          // Persist averageValue onto scan_grades so Recent Scans and
          // /scans/:id can render a price even when the user never saves
          // the scan into their cards table. Best-effort — never block the
          // response on this update.
          persistEstimatedValue(ebayResults);

          const updatedCardData = { ...cardData };
          if (ebayResults.discoveredVariant && !cardData.foilType) {
            console.log(`eBay discovered foil type "${ebayResults.discoveredVariant}" - updating card data`);
            updatedCardData.foilType = ebayResults.discoveredVariant;
            updatedCardData.isFoil = true;
            // Note: variant is NOT set from eBay-discovered foil types; variant is for printed card variations only
          }
          if (ebayResults.discoveredCollection) {
            console.log(`eBay discovered more specific collection "${ebayResults.discoveredCollection}" - updating card data`);
            updatedCardData.collection = ebayResults.discoveredCollection;
          }

          logScanTotal('ok');
          return res.json({
            success: true,
            data: {
              ...updatedCardData,
              ebayResults,
              holo: holoForClient,
              speculativeCatalog,
            }
          });
        } else {
          console.log('Search query too short, skipping eBay lookup');
          logScanTotal('ok-query-too-short');
          return res.json({
            success: true,
            data: {
              ...cardData,

              ebayResults: {
                averageValue: 0,
                results: [],
                searchUrl: '',
                errorMessage: 'Insufficient card information for price lookup',
                dataType: 'sold'
              },
              holo: holoForClient,
              speculativeCatalog,
            }
          });
        }
      } catch (ebayError) {
        console.error('eBay search error:', ebayError);
        logScanTotal('ok-ebay-error');
        return res.json({
          success: true,
          data: {
            ...cardData,

            ebayResults: {
              averageValue: 0,
              results: [],
              searchUrl: '',
              errorMessage: 'eBay search failed',
              dataType: 'sold'
            },
            holo: holoForClient,
            speculativeCatalog,
          }
        });
      }

    } catch (error: any) {
      console.error('Error in dual-image analysis:', error);
      logScanTotal('500-handler-error');
      return res.status(500).json({
        success: false,
        message: error.message || 'Dual-image analysis failed',
        error: 'analysis_failed'
      });
    }
  }

  // Legacy non-streaming entry point (PR #191 + everything that calls it).
  // Bulk depends on this URL; the streaming sibling registered below
  // delegates into the same shared body so behavior stays identical
  // when streaming isn't requested.
  app.post(`${apiPrefix}/analyze-card-dual-images`, requireScanQuota, upload.fields([
    { name: 'frontImage', maxCount: 1 },
    { name: 'backImage', maxCount: 1 },
    // GRADED-mode path (additive). Client uploads ONE additional image — the
    // top ~18% strip cropped from the slab label — alongside the regular
    // front/back photos. When present, the route runs the grading-label
    // VLM in parallel with the card-body analyzer so we still resolve in
    // a single round trip.
    { name: 'gradingLabelImage', maxCount: 1 },
  ]), async (req, res) => {
    await runAnalyzeCardDualImages(req, res);
  });

  // PR H — SSE streaming sibling for the single-card scan flow. Same
  // multipart input as the legacy route, plus four `stage` events
  // streamed live as the analyze pipeline hits each milestone, then a
  // single trailing `result` event carrying the same JSON payload the
  // legacy route would return. Bulk and any non-streaming caller stay
  // on the legacy route untouched. EventSource can't POST, so the
  // client uses fetch() with a ReadableStream reader.
  //
  // Event schema:
  //   data: {"type":"stage","stage":"analyzing_card","status":"in_progress","label":"Analyzing card"}\n\n
  //   data: {"type":"stage","stage":"analyzing_card","status":"completed","label":"Analyzing card"}\n\n
  //   ... (detecting_parallel, verifying_with_ebay, getting_price)
  //   data: {"type":"result","status":<httpStatus>,"body":<legacy JSON>}\n\n
  //   data: {"type":"error","message":"..."}\n\n   (terminal alternative)
  app.post(
    `${apiPrefix}/analyze-card-dual-images/stream`,
    requireScanQuota,
    upload.fields([
      { name: 'frontImage', maxCount: 1 },
      { name: 'backImage', maxCount: 1 },
      { name: 'gradingLabelImage', maxCount: 1 },
    ]),
    async (req, res) => {
      const quotaUserId = (req.user as any)?.id as number | undefined;
      let finalEmitted = false;
      res.on('close', () => {
        if (finalEmitted) void incrementScanCount(quotaUserId);
      });

      // SSE preamble. X-Accel-Buffering disables proxy buffering so
      // chips render live; no-cache is critical because intermediaries
      // would otherwise hold the stream until completion.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const send = (payload: Record<string, unknown>) => {
        try {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch (writeErr) {
          console.warn('[analyze-stream] SSE write failed:', writeErr);
        }
      };

      // Attach the stage emitter onto the request so dualSideOCR.ts
      // can fire events at its four milestones. Non-streaming callers
      // never set this and the helper is a silent no-op for them.
      (req as any).onStage = (event: { stage: string; status: string; label: string }) => {
        send({ type: 'stage', ...event });
      };

      // Mock response that the shared handler can write its final JSON
      // payload into. We capture status + body, then forward via SSE
      // rather than letting the shared handler ship a JSON response.
      let captured: { status: number; body: any } | null = null;
      const mockRes: any = {
        statusCode: 200,
        on: (_event: string, _cb: () => void) => mockRes,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(body: any) {
          captured = { status: this.statusCode || 200, body };
          return this;
        },
      };

      try {
        await runAnalyzeCardDualImages(req as Request, mockRes as Response);
        if (!captured) {
          send({ type: 'error', message: 'analyze pipeline produced no result' });
          res.end();
          return;
        }
        finalEmitted = (captured as any).status === 200;
        send({ type: 'result', status: (captured as any).status, body: (captured as any).body });
        res.end();
      } catch (err: any) {
        console.error('[analyze-stream] pipeline failed:', err);
        send({ type: 'error', message: err?.message || 'Analyze pipeline failed' });
        res.end();
      }
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  // BR-1: Gemini streaming endpoint for single-scan UI (perceived latency).
  //
  // Adds a server-sent-events (SSE) endpoint that streams the Gemini VLM
  // response progressively so the single-scan UI can show partial fields
  // (year, brand, player, …) in 1–2s instead of waiting ~17s for the full
  // pipeline to return. Real wall-clock is unchanged.
  //
  // Scope: this endpoint streams ONLY the Gemini visual reading. The full
  // /api/analyze-card-dual-images endpoint (eBay pricing, holo grading,
  // OCR pipeline, scan_grades persistence) is byte-identical and untouched
  // — bulk depends on it (PR #191) and the existing Scan.tsx flow keeps
  // calling it for the authoritative response.
  //
  // Year-rule guardrail: the FINAL `final` SSE event is built by passing
  // the fully-accumulated stream text through finalizeGeminiText() — the
  // EXACT same post-processor the non-streaming path uses (vlmGemini.ts).
  // Year rule v2026-04-28.7 lives in the prompt; both paths use the same
  // VLM_FULL_PROMPT and the same JSON.parse + normalizeGeminiResult chain.
  // The streaming finalize is a shared pure function — not a parallel
  // parser — so byte-identical equivalence is structural, not coincidental.
  //
  // SSE event schema (one event per `data: <json>\n\n` block):
  //   { type: "open",    promptVersion: string }                — handshake
  //   { type: "partial", fields: Partial<GeminiCardResult>,
  //                      bytes: number }                         — best-effort
  //                                                                partial JSON
  //                                                                parse so far
  //   { type: "final",   result: GeminiCardResult,
  //                      promptVersion: string }                 — same shape as
  //                                                                analyzeCardBuffersWithGemini
  //   { type: "error",   message: string }                       — terminal
  app.post(
    `${apiPrefix}/cards/analyze/stream`,
    requireScanQuota,
    upload.fields([
      { name: 'frontImage', maxCount: 1 },
      { name: 'backImage', maxCount: 1 },
    ]),
    async (req, res) => {
      const quotaUserId = (req.user as any)?.id as number | undefined;
      // Only count successful streams (a `final` event was emitted). The
      // finish hook fires on any close, so we gate via a flag.
      let finalEmitted = false;
      res.on('close', () => {
        if (finalEmitted) void incrementScanCount(quotaUserId);
      });

      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
      const frontFile = files?.frontImage?.[0];
      const backFile = files?.backImage?.[0];
      if (!frontFile || !backFile) {
        return res.status(400).json({
          success: false,
          message: 'Both front and back images are required for streaming analysis',
          error: 'missing_images',
        });
      }

      // Lazy-load the Gemini module so this endpoint mirrors how
      // dualSideOCR pulls it in — keeps the cold-start surface tight.
      const {
        analyzeCardBuffersWithGeminiStream,
        VLM_INFO: streamVlmInfo,
      } = await import('./vlmGemini');

      // SSE handshake.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (event: Record<string, unknown>) => {
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch (writeErr) {
          console.warn('[gemini-stream] SSE write failed:', writeErr);
        }
      };
      send({ type: 'open', promptVersion: streamVlmInfo.promptVersion });

      let lastSentBytes = 0;
      let lastSentJson = '';
      const onPartial = (accumulated: string) => {
        // Throttle: only attempt a parse once we have meaningfully more
        // bytes than the last successful emit, to avoid hammering the
        // partial parser on every tiny chunk.
        if (accumulated.length - lastSentBytes < 24) return;
        // Strip leading fences if Gemini wrapped its JSON.
        const trimmed = accumulated.replace(/^```(?:json)?\s*/i, '').trim();
        const open = trimmed.indexOf('{');
        if (open < 0) return;
        const parsed = tryParsePartialJson(trimmed.slice(open));
        if (!parsed) return;
        const json = JSON.stringify(parsed);
        if (json === lastSentJson) return;
        lastSentJson = json;
        lastSentBytes = accumulated.length;
        send({ type: 'partial', fields: parsed, bytes: accumulated.length });
      };

      try {
        const result = await analyzeCardBuffersWithGeminiStream(
          frontFile.buffer,
          backFile.buffer,
          {
            frontMime: frontFile.mimetype || 'image/jpeg',
            backMime: backFile.mimetype || 'image/jpeg',
            onPartialText: onPartial,
          },
        );
        finalEmitted = true;
        send({ type: 'final', result, promptVersion: streamVlmInfo.promptVersion });
        res.end();
      } catch (err: any) {
        console.error('[gemini-stream] analysis failed:', err);
        send({ type: 'error', message: err?.message || 'Gemini stream failed' });
        res.end();
      }
    },
  );

  // Combined OCR + eBay price lookup endpoint (legacy single image)
  //
  // Quota: see /analyze-card-image — same gate + finish-hook pattern.
  app.post(`${apiPrefix}/analyze-card-with-prices`, requireScanQuota, upload.single('image'), async (req, res) => {
    const quotaUserId = (req.user as any)?.id as number | undefined;
    res.on('finish', () => {
      if (res.statusCode === 200) void incrementScanCount(quotaUserId);
    });
    try {
      if (!req.file) {
        return res.status(400).json({ 
          success: false,
          message: 'No image provided',
          error: 'missing_file'
        });
      }

      console.log('Starting combined OCR + eBay price analysis...');
      
      // First, perform OCR analysis
      const ocrResponse = await new Promise<any>((resolve, reject) => {
        const mockRes = {
          json: (data: any) => resolve(data),
          status: (code: number) => ({
            json: (data: any) => reject(new Error(`OCR failed with status ${code}: ${JSON.stringify(data)}`))
          })
        };
        
        handleDualSideCardAnalysis(req, mockRes as any);
      });

      if (!ocrResponse.success || !ocrResponse.data) {
        return res.json({
          success: true,
          data: {
            ...ocrResponse.data,
            ebayResults: [],
            averageValue: 0,
            error: 'OCR analysis failed'
          }
        });
      }

      const cardData = ocrResponse.data;
      console.log('OCR completed, starting eBay search for:', cardData);
      console.log('OCR foilType specifically:', cardData.foilType);

      // Then perform eBay price lookup with the OCR results
      let ebayResults = [];
      let averageValue = 0;

      if (cardData.playerFirstName && cardData.playerLastName && cardData.brand && cardData.year) {
        try {
          const playerName = `${cardData.playerFirstName} ${cardData.playerLastName}`;
          const ebayData = await searchCardValues(
            playerName,
            cardData.cardNumber || '',
            cardData.brand,
            cardData.year,
            cardData.collection || '',
            cardData.condition || '',
            cardData.isNumbered || false,
            cardData.foilType || undefined,
            cardData.serialNumber || undefined,
            cardData.variant || undefined,
            cardData.isAutographed || false,
            undefined,
            cardData.set || undefined
          );
          
          ebayResults = ebayData.results || [];
          averageValue = ebayData.averageValue || 0;
          
          console.log(`eBay search completed: ${ebayResults.length} results, average value: $${averageValue}`);
        } catch (ebayError) {
          console.error('eBay search failed:', ebayError);
        }
      } else {
        console.log('Insufficient card data for eBay search');
      }

      return res.json({
        success: true,
        data: {
          ...cardData,
          ebayResults,
          averageValue,
          estimatedValue: averageValue // Update the estimated value with eBay data
        }
      });

    } catch (error: any) {
      console.error('Error in combined analysis:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Combined analysis failed',
        error: 'analysis_failed'
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

  // Test foil detection directly
  app.post('/api/test-foil-detection', (req, res) => {
    const { detectFoilVariant } = require('./foilVariantDetector');
    
    // Test with sample text that should detect green foil
    const testText = "2023-24 Donruss Basketball Jayson Tatum #197 Green Parallel Boston Celtics";
    console.log('Testing foil detection with text:', testText);
    
    const result = detectFoilVariant(testText);
    console.log('Foil detection test result:', result);
    
    res.json({
      testText,
      result,
      success: true
    });
  });

  app.post('/api/confirmed-cards', async (req: Request, res: Response) => {
    try {
      const { sport, playerFirstName, playerLastName, brand, collection, cardNumber, year, variant, serialNumber, isRookieCard, isAutographed, isNumbered } = req.body;

      if (!playerFirstName || !playerLastName || !brand || !cardNumber || !year || !sport) {
        return res.status(400).json({ error: 'Missing required fields: sport, playerFirstName, playerLastName, brand, cardNumber, and year are all required' });
      }

      const parsedYear = Number(year);
      if (isNaN(parsedYear) || parsedYear < 1900 || parsedYear > new Date().getFullYear()) {
        return res.status(400).json({ error: 'Year must be between 1900 and the current year' });
      }

      let serialLimit: string | null = null;
      if (serialNumber && typeof serialNumber === 'string') {
        const trimmed = serialNumber.trim();
        const limitMatch = trimmed.match(/\/(\d+)\s*$/);
        if (limitMatch) {
          serialLimit = `/${limitMatch[1]}`;
        }
      }

      const normalizedVariant = variant && variant.trim() ? variant.trim() : null;

      const conditions = [
        eq(confirmedCards.cardNumber, cardNumber),
        eq(confirmedCards.year, parsedYear),
        eq(confirmedCards.brand, brand),
        eq(confirmedCards.playerLastName, playerLastName),
      ];
      if (normalizedVariant) {
        conditions.push(eq(confirmedCards.variant, normalizedVariant));
      } else {
        conditions.push(isNull(confirmedCards.variant));
      }

      const existing = await db.select().from(confirmedCards).where(
        and(...conditions)
      ).limit(1);

      const syncData = {
        sport,
        playerFirstName,
        playerLastName,
        brand,
        collection: collection && collection.trim() ? collection.trim() : null,
        cardNumber,
        year: parsedYear,
        variant: normalizedVariant,
        serialLimit,
        isRookieCard: isRookieCard || false,
        isAutographed: isAutographed || false,
        isNumbered: isNumbered || false,
      };

      if (existing.length > 0) {
        const updated = await db.update(confirmedCards)
          .set({
            confirmCount: sql`${confirmedCards.confirmCount} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(confirmedCards.id, existing[0].id))
          .returning();

        syncConfirmedCard(syncData).catch(() => {});

        return res.json({ success: true, data: updated[0], action: 'incremented' });
      }

      const [inserted] = await db.insert(confirmedCards).values({
        ...syncData,
        confirmCount: 1,
      }).returning();

      syncConfirmedCard(syncData).catch(() => {});

      return res.status(201).json({ success: true, data: inserted, action: 'created' });
    } catch (error: any) {
      console.error('Error confirming card:', error);
      return res.status(500).json({ error: 'Failed to confirm card data' });
    }
  });

  // ─── Card Database Routes ───────────────────────────────────────────────────

  // ── Admin gate middleware ───────────────────────────────────────────────────
  // Protects destructive card-database routes with a two-factor gate:
  //   1) The caller must be authenticated as the admin user (email match).
  //   2) They must also supply the shared ADMIN_PASSWORD via x-admin-password.
  //
  // ADMIN_EMAIL defaults to daniel.j.holley@gmail.com (case-insensitive) so the
  // owner's account is always authorized even in fresh deployments. Override
  // with the ADMIN_EMAIL env var if the app is ever operated by a different
  // user. Fails closed (500) when ADMIN_PASSWORD is missing so admin routes
  // are never accidentally accessible in a misconfigured deployment.
  const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'daniel.j.holley@gmail.com').toLowerCase();
  function requireAdminPassword(req: Request, res: Response, next: NextFunction) {
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
      // Secret not configured — fail closed so admin routes are never accidentally open.
      return res.status(500).json({ error: 'Admin password not configured on this server' });
    }
    // Cron / machine-caller bypass: a CRON_TOKEN env secret + matching
    // x-cron-token header skips the session-and-password check. Used by the
    // Replit cron that pulls fresh CSVs from Drive on a schedule — cron jobs
    // have no Express session and no admin password to send. The token is a
    // separate secret from ADMIN_PASSWORD so machine access can be revoked
    // independently from the human admin login.
    const cronToken = process.env.CRON_TOKEN;
    const providedCron = req.headers['x-cron-token'];
    if (cronToken && providedCron && providedCron === cronToken) {
      return next();
    }
    // Must be signed in as the admin user first — password alone is not enough.
    const userEmail = ((req.user as any)?.email || '').toString().toLowerCase();
    if (!req.isAuthenticated?.() || !userEmail || userEmail !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Forbidden: admin access restricted' });
    }
    const provided = req.headers['x-admin-password'];
    if (!provided || provided !== adminPassword) {
      return res.status(401).json({ error: 'Unauthorized: invalid admin password' });
    }
    return next();
  }

  // GET /api/card-database/check-auth — lightweight password validation used by the
  // frontend gate so users get immediate feedback before attempting a real import.
  app.get(`${apiPrefix}/card-database/check-auth`, requireAdminPassword, (_req, res) => {
    return res.json({ ok: true });
  });

  // GET /api/card-database/stats — counts with deltas from the first import of the day
  app.get(`${apiPrefix}/card-database/stats`, async (_req, res) => {
    try {
      const [[cardCount], [varCount], sportResult] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(cardDatabase),
        db.select({ count: sql<number>`count(*)::int` }).from(cardVariations),
        db.execute(sql`SELECT count(distinct reverse(split_part(reverse(brand_id), '_', 1)))::int as count FROM card_database`),
      ]);
      const sportsCount = (sportResult as any).rows?.[0]?.count ?? (sportResult as any)?.[0]?.count ?? 0;

      // Today midnight UTC — used to find the first import of the current day
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);

      // First import of today for each type (gives us the countBefore baseline)
      const [[firstCardsToday], [firstVariationsToday]] = await Promise.all([
        db.select().from(importHistory)
          .where(and(eq(importHistory.type, 'cards'), gte(importHistory.importedAt, todayStart)))
          .orderBy(importHistory.importedAt)
          .limit(1),
        db.select().from(importHistory)
          .where(and(eq(importHistory.type, 'variations'), gte(importHistory.importedAt, todayStart)))
          .orderBy(importHistory.importedAt)
          .limit(1),
      ]);

      // Fallback: most recent historical import when there is no import today
      const [[lastCardsImport], [lastVariationsImport]] = await Promise.all([
        firstCardsToday
          ? Promise.resolve([firstCardsToday])
          : db.select().from(importHistory)
              .where(eq(importHistory.type, 'cards'))
              .orderBy(desc(importHistory.importedAt))
              .limit(1),
        firstVariationsToday
          ? Promise.resolve([firstVariationsToday])
          : db.select().from(importHistory)
              .where(eq(importHistory.type, 'variations'))
              .orderBy(desc(importHistory.importedAt))
              .limit(1),
      ]);

      // Delta = current table total minus count-before of the reference import.
      // When there were imports today, this accumulates all of today's growth.
      // When falling back to a historical import, use that import's own delta.
      const cardsDelta = firstCardsToday
        ? (cardCount?.count ?? 0) - firstCardsToday.countBefore
        : (lastCardsImport?.delta ?? null);
      const variationsDelta = firstVariationsToday
        ? (varCount?.count ?? 0) - firstVariationsToday.countBefore
        : (lastVariationsImport?.delta ?? null);

      // "since" timestamp is the first import of the day (or last ever import)
      const lastCardsImportedAt = lastCardsImport?.importedAt ?? null;
      const lastVariationsImportedAt = lastVariationsImport?.importedAt ?? null;

      const timestamps = [lastCardsImportedAt, lastVariationsImportedAt].filter(Boolean) as Date[];
      const lastImportedAt = timestamps.length
        ? timestamps.reduce((a, b) => (a > b ? a : b))
        : null;

      return res.json({
        cards: cardCount?.count ?? 0,
        variations: varCount?.count ?? 0,
        sports: sportsCount,
        cardsDelta,
        variationsDelta,
        lastImportedAt,
        lastCardsImportedAt,
        lastVariationsImportedAt,
      });
    } catch (error: any) {
      console.error('Error fetching card database stats:', error);
      return res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // Multer error handler for CSV uploads — returns JSON instead of HTML on file-size/upload errors
  function handleUpload(req: Request, res: Response, next: NextFunction) {
    upload.single('file')(req as any, res as any, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'File is too large (max 20 MB). Please reduce the file size and retry.' });
        }
        return res.status(400).json({ error: err.message || 'File upload error' });
      }
      next();
    });
  }

  function decompressIfNeeded(req: MulterRequest): Buffer {
    if (!req.file) throw new Error('No file provided');
    const isCompressed = req.body?.compressed === 'gzip' || req.file.originalname?.endsWith('.gz');
    if (isCompressed) {
      console.log(`[Import] Decompressing gzip upload (${(req.file.buffer.length / 1024 / 1024).toFixed(1)} MB compressed)`);
      const decompressed = gunzipSync(req.file.buffer);
      console.log(`[Import] Decompressed to ${(decompressed.length / 1024 / 1024).toFixed(1)} MB`);
      return decompressed;
    }
    return req.file.buffer;
  }

  // POST /api/card-database/import-cards — upload cards CSV (returns job ID immediately)
  app.post(
    `${apiPrefix}/card-database/import-cards`,
    requireAdminPassword,
    handleUpload,
    async (req: MulterRequest, res) => {
      try {
        const csvBuffer = decompressIfNeeded(req);
        const [beforeRow] = await db.select({ count: sql<number>`count(*)::int` }).from(cardDatabase);
        const countBefore = beforeRow?.count ?? 0;
        const jobId = randomUUID();
        importJobs.set(jobId, { status: 'queued', type: 'cards', progress: { processed: 0, total: 0 }, startedAt: Date.now() });
        runCardsImportJob(jobId, csvBuffer, countBefore);
        return res.json({ jobId });
      } catch (error: any) {
        console.error('Error starting cards import job:', error);
        return res.status(500).json({ error: error.message || 'Failed to start import' });
      }
    }
  );

  // POST /api/card-database/import-variations — upload variations CSV (returns job ID immediately)
  app.post(
    `${apiPrefix}/card-database/import-variations`,
    requireAdminPassword,
    handleUpload,
    async (req: MulterRequest, res) => {
      try {
        const csvBuffer = decompressIfNeeded(req);
        const [beforeRow] = await db.select({ count: sql<number>`count(*)::int` }).from(cardVariations);
        const countBefore = beforeRow?.count ?? 0;
        const jobId = randomUUID();
        importJobs.set(jobId, { status: 'queued', type: 'variations', progress: { processed: 0, total: 0 }, startedAt: Date.now() });
        runVariationsImportJob(jobId, csvBuffer, countBefore);
        return res.json({ jobId });
      } catch (error: any) {
        console.error('Error starting variations import job:', error);
        return res.status(500).json({ error: error.message || 'Failed to start import' });
      }
    }
  );

  // GET /api/card-database/import-status/:jobId — poll for background import progress
  app.get(`${apiPrefix}/card-database/import-status/:jobId`, requireAdminPassword, (req, res) => {
    const job = importJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found or expired' });
    return res.json(job);
  });

  // ── Drive → cardDatabase / cardVariations sync ──────────────────────────────
  // Pulls the latest CSV from each Drive folder (cards + variations), feeds it
  // into the existing import pipeline, and records what was imported in
  // csv_sync_log so repeat calls (e.g. cron every 30 min) skip unchanged files.
  // The actual import runs through the same runCardsImportJob /
  // runVariationsImportJob workers as the upload path so progress UX is shared.

  // GET /api/card-database/drive-sync-status — latest synced revision per table
  // and whether the env vars are wired. Used to render the admin UI section
  // and to let the cron know whether it should even attempt a run.
  app.get(`${apiPrefix}/card-database/drive-sync-status`, requireAdminPassword, async (_req, res) => {
    try {
      const configured = isDriveSyncConfigured();
      // Pull the most recent log row per table_name. Two small queries beats
      // a window-function query and is portable across Postgres versions.
      const [latestCards] = await db.select().from(csvSyncLog)
        .where(eq(csvSyncLog.tableName, 'cards'))
        .orderBy(desc(csvSyncLog.importedAt))
        .limit(1);
      const [latestVariations] = await db.select().from(csvSyncLog)
        .where(eq(csvSyncLog.tableName, 'variations'))
        .orderBy(desc(csvSyncLog.importedAt))
        .limit(1);
      return res.json({
        configured,
        cards: latestCards ?? null,
        variations: latestVariations ?? null,
      });
    } catch (err: any) {
      console.error('[DriveSync] status error:', err);
      return res.status(500).json({ error: err.message || 'Failed to read drive sync status' });
    }
  });

  // POST /api/card-database/sync-from-drive — picks the latest CSV in each of
  // the configured Drive folders, skips any whose (file_id, modified_time)
  // already exists in csv_sync_log, and kicks off background import jobs for
  // the rest. Returns one jobId per table that started; null when skipped.
  // Accepts ?force=1 to bypass the skip-check for manual re-imports.
  app.post(`${apiPrefix}/card-database/sync-from-drive`, requireAdminPassword, async (req, res) => {
    try {
      if (!isDriveSyncConfigured()) {
        return res.status(400).json({
          error: 'Drive sync is not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON, DRIVE_FOLDER_CARDS_ID, and DRIVE_FOLDER_VARIATIONS_ID secrets and share both folders with the service account email.',
        });
      }
      const force = req.query.force === '1' || (req.body as any)?.force === true;
      // Cron-token presence on the request distinguishes 'auto' (Replit cron)
      // from 'manual' (admin button) for the trigger column. Same value is
      // used by the bypass branch in requireAdminPassword.
      const trigger: 'auto' | 'manual' = req.headers['x-cron-token'] ? 'auto' : 'manual';

      const summary: {
        cards: { jobId: string | null; skipped: boolean; file: { fileId: string; fileName: string; modifiedTime: string } | null; reason?: string };
        variations: { jobId: string | null; skipped: boolean; file: { fileId: string; fileName: string; modifiedTime: string } | null; reason?: string };
      } = {
        cards: { jobId: null, skipped: false, file: null },
        variations: { jobId: null, skipped: false, file: null },
      };

      // Cards
      const cardsFile = await findLatestCsvInFolder(getCardsFolderId());
      if (!cardsFile) {
        summary.cards.skipped = true;
        summary.cards.reason = 'No CSV or Google Sheet files found in cards folder';
      } else {
        summary.cards.file = {
          fileId: cardsFile.fileId,
          fileName: cardsFile.fileName,
          modifiedTime: cardsFile.modifiedTime.toISOString(),
        };
        const existing = force ? null : await findExistingSyncLog('cards', cardsFile.fileId, cardsFile.modifiedTime);
        if (existing) {
          summary.cards.skipped = true;
          summary.cards.reason = `Already imported at ${existing.importedAt.toISOString()}`;
        } else {
          const buffer = await downloadFile(cardsFile.fileId, cardsFile.mimeType);
          const [beforeRow] = await db.select({ count: sql<number>`count(*)::int` }).from(cardDatabase);
          const countBefore = beforeRow?.count ?? 0;
          const jobId = randomUUID();
          importJobs.set(jobId, { status: 'queued', type: 'cards', progress: { processed: 0, total: 0 }, startedAt: Date.now() });
          // Fire-and-forget the import, then write the sync-log row when it
          // completes (or skip the log on error so a failed run can retry).
          (async () => {
            await runCardsImportJob(jobId, buffer, countBefore);
            const finalJob = importJobs.get(jobId);
            if (finalJob?.status === 'done' && finalJob.result) {
              await db.insert(csvSyncLog).values({
                tableName: 'cards',
                driveFileId: cardsFile.fileId,
                driveFileName: cardsFile.fileName,
                driveModifiedTime: cardsFile.modifiedTime,
                rowsImported: finalJob.result.imported,
                rowsReplaced: finalJob.result.replaced,
                errorCount: finalJob.result.errorCount,
                trigger,
              });
              console.log(`[DriveSync] cards: imported ${finalJob.result.imported} rows from ${cardsFile.fileName}`);
            } else if (finalJob?.status === 'error') {
              console.error(`[DriveSync] cards import failed: ${finalJob.error}`);
            }
          })().catch((err) => console.error('[DriveSync] cards post-import logging failed:', err));
          summary.cards.jobId = jobId;
        }
      }

      // Variations
      const varsFile = await findLatestCsvInFolder(getVariationsFolderId());
      if (!varsFile) {
        summary.variations.skipped = true;
        summary.variations.reason = 'No CSV or Google Sheet files found in variations folder';
      } else {
        summary.variations.file = {
          fileId: varsFile.fileId,
          fileName: varsFile.fileName,
          modifiedTime: varsFile.modifiedTime.toISOString(),
        };
        const existing = force ? null : await findExistingSyncLog('variations', varsFile.fileId, varsFile.modifiedTime);
        if (existing) {
          summary.variations.skipped = true;
          summary.variations.reason = `Already imported at ${existing.importedAt.toISOString()}`;
        } else {
          const buffer = await downloadFile(varsFile.fileId, varsFile.mimeType);
          const [beforeRow] = await db.select({ count: sql<number>`count(*)::int` }).from(cardVariations);
          const countBefore = beforeRow?.count ?? 0;
          const jobId = randomUUID();
          importJobs.set(jobId, { status: 'queued', type: 'variations', progress: { processed: 0, total: 0 }, startedAt: Date.now() });
          (async () => {
            await runVariationsImportJob(jobId, buffer, countBefore);
            const finalJob = importJobs.get(jobId);
            if (finalJob?.status === 'done' && finalJob.result) {
              await db.insert(csvSyncLog).values({
                tableName: 'variations',
                driveFileId: varsFile.fileId,
                driveFileName: varsFile.fileName,
                driveModifiedTime: varsFile.modifiedTime,
                rowsImported: finalJob.result.imported,
                rowsReplaced: finalJob.result.replaced,
                errorCount: finalJob.result.errorCount,
                trigger,
              });
              console.log(`[DriveSync] variations: imported ${finalJob.result.imported} rows from ${varsFile.fileName}`);
            } else if (finalJob?.status === 'error') {
              console.error(`[DriveSync] variations import failed: ${finalJob.error}`);
            }
          })().catch((err) => console.error('[DriveSync] variations post-import logging failed:', err));
          summary.variations.jobId = jobId;
        }
      }

      return res.json(summary);
    } catch (err: any) {
      console.error('[DriveSync] sync-from-drive error:', err);
      return res.status(500).json({ error: err.message || 'Sync failed' });
    }
  });

  // ── Push Dev → Prod ─────────────────────────────────────────────────────────
  // Streams the contents of card_database + card_variations from this app's DB
  // into the database pointed at by PROD_DATABASE_URL using Postgres COPY. The
  // job runs in the background; the client polls for progress.

  // POST /api/card-database/push-to-prod — start a push job
  app.post(
    `${apiPrefix}/card-database/push-to-prod`,
    requireAdminPassword,
    async (_req, res) => {
      const prodUrl = process.env.PROD_DATABASE_URL;
      if (!prodUrl) {
        return res.status(400).json({
          error: 'PROD_DATABASE_URL is not configured. Add it as a secret to enable Dev → Prod sync.',
        });
      }
      if (prodUrl === process.env.DATABASE_URL) {
        return res.status(400).json({
          error: 'PROD_DATABASE_URL is identical to DATABASE_URL — refusing to truncate the same database we are reading from.',
        });
      }

      const jobId = randomUUID();
      const job = makeInitialJobState();
      pushJobs.set(jobId, job);

      // Fire and forget — errors are captured into job.status / job.error
      runPushToProdJob(job, prodUrl, sourcePool).catch((err) => {
        console.error('[PushToProd] Unexpected error in push job:', err);
      });

      return res.json({ jobId });
    }
  );

  // GET /api/card-database/push-to-prod-status/:jobId — poll for progress
  app.get(
    `${apiPrefix}/card-database/push-to-prod-status/:jobId`,
    requireAdminPassword,
    (req, res) => {
      const job = pushJobs.get(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found or expired' });
      return res.json(job);
    }
  );

  // DELETE /api/card-database/clear — wipe and re-import (admin utility)
  app.delete(`${apiPrefix}/card-database/clear`, requireAdminPassword, async (_req, res) => {
    try {
      await db.delete(cardVariations);
      await db.delete(cardDatabase);
      return res.json({ success: true, message: 'Card database cleared' });
    } catch (error: any) {
      console.error('Error clearing card database:', error);
      return res.status(500).json({ error: 'Failed to clear card database' });
    }
  });

  // ─── Card Search & Autocomplete Routes ─────────────────────────────────────

  // Simple in-memory cache for autocomplete lists (refreshed every 5 minutes)
  let brandsCache: { data: string[]; timestamp: number } | null = null;
  const collectionsCache = new Map<string, { data: string[]; timestamp: number }>();
  const AUTOCOMPLETE_CACHE_TTL = 5 * 60 * 1000;

  // GET /api/card-database/brands — distinct brand names for autocomplete
  app.get(`${apiPrefix}/card-database/brands`, async (_req, res) => {
    try {
      const now = Date.now();
      if (brandsCache && (now - brandsCache.timestamp) < AUTOCOMPLETE_CACHE_TTL) {
        return res.json(brandsCache.data);
      }
      const rows = await db
        .select({ brand: cardDatabase.brand })
        .from(cardDatabase)
        .groupBy(cardDatabase.brand)
        .orderBy(cardDatabase.brand);
      const data = rows.map(r => r.brand);
      brandsCache = { data, timestamp: now };
      return res.json(data);
    } catch (error: any) {
      console.error('Error fetching brands for autocomplete:', error);
      return res.status(500).json({ error: 'Failed to fetch brands' });
    }
  });

  // GET /api/card-database/collections — distinct collections, optionally filtered by brand and/or year
  app.get(`${apiPrefix}/card-database/collections`, async (req, res) => {
    try {
      const brand = req.query.brand ? String(req.query.brand) : '';
      const yearStr = req.query.year ? String(req.query.year) : '';
      const year = yearStr ? parseInt(yearStr, 10) : 0;
      const set = req.query.set ? String(req.query.set) : '';
      const playerLastName = req.query.playerLastName ? String(req.query.playerLastName).trim() : '';
      const cacheKey = `${brand.toLowerCase()}|${year || ''}|${set.toLowerCase()}|${playerLastName.toLowerCase()}`;
      const now = Date.now();
      const cached = collectionsCache.get(cacheKey);
      if (cached && (now - cached.timestamp) < AUTOCOMPLETE_CACHE_TTL) {
        return res.json(cached.data);
      }
      const baseConditions: any[] = [];
      if (brand) baseConditions.push(sql`lower(${cardDatabase.brand}) = lower(${brand})`);
      if (year) baseConditions.push(eq(cardDatabase.year, year));
      if (set) baseConditions.push(sql`lower(${cardDatabase.set}) = lower(${set})`);
      const runQuery = async (extraConditions: any[]) => {
        const conds = [...baseConditions, ...extraConditions];
        const whereExpr = conds.length ? and(...conds) : undefined;
        const rows = await db
          .select({ collection: cardDatabase.collection })
          .from(cardDatabase)
          .where(whereExpr as any)
          .groupBy(cardDatabase.collection)
          .orderBy(cardDatabase.collection);
        return rows.map(r => r.collection).filter((c): c is string => !!c);
      };
      let data: string[] = playerLastName
        ? await runQuery([sql`lower(${cardDatabase.playerName}) like ${'%' + playerLastName.toLowerCase() + '%'}`])
        : await runQuery([]);
      // If narrowing by player yielded no collections, fall back to the
      // unfiltered brand+year list so the user always sees a dropdown when
      // the catalog has SOME data for this brand+year. Otherwise the UI
      // wrongly drops to a free-text input on edits where the OCR'd player
      // last-name simply isn't present in the catalog for the new year.
      if (data.length === 0 && playerLastName) data = await runQuery([]);
      collectionsCache.set(cacheKey, { data, timestamp: now });
      return res.json(data);
    } catch (error: any) {
      console.error('Error fetching collections for autocomplete:', error);
      return res.status(500).json({ error: 'Failed to fetch collections' });
    }
  });

  // GET /api/card-database/sets — distinct set names, optionally filtered by brand/year/collection
  const setsCache = new Map<string, { data: string[]; timestamp: number }>();
  app.get(`${apiPrefix}/card-database/sets`, async (req, res) => {
    try {
      const brand = req.query.brand ? String(req.query.brand) : '';
      const yearStr = req.query.year ? String(req.query.year) : '';
      const collection = req.query.collection ? String(req.query.collection) : '';
      const year = yearStr ? parseInt(yearStr, 10) : 0;
      const playerLastName = req.query.playerLastName ? String(req.query.playerLastName).trim() : '';
      const cacheKey = `${brand.toLowerCase()}|${year || ''}|${collection.toLowerCase()}|${playerLastName.toLowerCase()}`;
      const now = Date.now();
      const cached = setsCache.get(cacheKey);
      if (cached && (now - cached.timestamp) < AUTOCOMPLETE_CACHE_TTL) {
        return res.json(cached.data);
      }
      const baseConditions: any[] = [];
      if (brand) baseConditions.push(sql`lower(${cardDatabase.brand}) = lower(${brand})`);
      if (year) baseConditions.push(eq(cardDatabase.year, year));
      if (collection) baseConditions.push(sql`lower(${cardDatabase.collection}) = lower(${collection})`);
      const runQuery = async (extraConditions: any[]) => {
        const conds = [...baseConditions, ...extraConditions];
        const whereExpr = conds.length ? and(...conds) : undefined;
        const rows = await db
          .select({ set: cardDatabase.set })
          .from(cardDatabase)
          .where(whereExpr as any)
          .groupBy(cardDatabase.set)
          .orderBy(cardDatabase.set);
        return rows.map(r => r.set).filter((s): s is string => !!s);
      };
      let data: string[] = playerLastName
        ? await runQuery([sql`lower(${cardDatabase.playerName}) like ${'%' + playerLastName.toLowerCase() + '%'}`])
        : await runQuery([]);
      // Same fallback as collections — never hide the dropdown just because
      // the OCR'd player name is missing from the catalog for this brand+year.
      if (data.length === 0 && playerLastName) data = await runQuery([]);
      setsCache.set(cacheKey, { data, timestamp: now });
      return res.json(data);
    } catch (error: any) {
      console.error('Error fetching sets for autocomplete:', error);
      return res.status(500).json({ error: 'Failed to fetch sets' });
    }
  });

  // GET /api/card-search — look up a card by structured fields, return resolved card info
  app.get(`${apiPrefix}/card-search`, async (req, res) => {
    try {
      const {
        year: yearStr,
        brand,
        collection,
        cardNumber,
        variant,
        playerFirstName,
        playerLastName,
      } = req.query as Record<string, string | undefined>;

      const year = yearStr ? parseInt(yearStr, 10) : 0;

      // Try DB lookup when we have enough structured fields
      if (brand && year && cardNumber) {
        const dbResult = await lookupCard({
          brand,
          year,
          collection: collection || undefined,
          cardNumber,
        });

        if (dbResult.found) {
          return res.json({
            found: true,
            source: 'card_database',
            cardData: {
              playerFirstName: dbResult.playerFirstName || '',
              playerLastName: dbResult.playerLastName || '',
              brand: dbResult.brand || brand,
              year: dbResult.year || year,
              collection: dbResult.collection || collection || '',
              set: dbResult.set || undefined,
              cardNumber: dbResult.cardNumber || cardNumber,
              variant: variant || dbResult.variation || '',
              serialNumber: dbResult.serialNumber || '',
              isRookieCard: dbResult.isRookieCard || false,
              isAutographed: false,
              isNumbered: !!(dbResult.serialNumber),
              isFoil: false,
              sport: '',
              cmpNumber: dbResult.cmpNumber || undefined,
            },
          });
        }
      }

      // No DB match — fall back to exactly what the user typed
      return res.json({
        found: false,
        source: 'user_input',
        cardData: {
          playerFirstName: playerFirstName || '',
          playerLastName: playerLastName || '',
          brand: brand || '',
          year: year || 0,
          collection: collection || '',
          cardNumber: cardNumber || '',
          variant: variant || '',
          isRookieCard: false,
          isAutographed: false,
          isNumbered: false,
          isFoil: false,
          sport: '',
        },
      });
    } catch (error: any) {
      console.error('Error in card-search:', error);
      return res.status(500).json({ error: 'Search failed' });
    }
  });

  // GET /api/card-variations/options — return distinct variation options for a given brand/year/collection/set
  // Used by the variant dropdown and parallel picker. Accepts optional collection and set params.
  // Queries with decreasing specificity so the most targeted match wins.
  app.get(`${apiPrefix}/card-variations/options`, async (req, res) => {
    try {
      const { brand, year: yearStr, collection, set, serialStatus, kind } = req.query as Record<string, string | undefined>;
      if (!brand || !yearStr) {
        return res.status(400).json({ error: 'brand and year are required' });
      }
      const year = parseInt(yearStr, 10);
      if (isNaN(year)) {
        return res.status(400).json({ error: 'Invalid year' });
      }

      // Optional serial-status filter:
      //   serialStatus=none      → only non-serialized parallels (serial_number is null/empty)
      //   serialStatus=numbered  → only serialized parallels
      // Anything else (or omitted) returns both.
      const serialFilter = serialStatus === 'none'
        ? sql`(${cardVariations.serialNumber} is null or trim(${cardVariations.serialNumber}) = '')`
        : serialStatus === 'numbered'
          ? sql`(${cardVariations.serialNumber} is not null and trim(${cardVariations.serialNumber}) <> '')`
          : undefined;

      // Optional kind filter — splits catalog rows into "variant" vs "parallel"
      // by whether the variation_or_parallel name contains the word
      // "Variation"/"Variations" (case-insensitive, whole word).
      //   kind=variant   → only rows whose name matches /\bvariations?\b/i
      //   kind=parallel  → only rows whose name does NOT match
      const kindFilter = kind === 'variant'
        ? sql`${cardVariations.variationOrParallel} ~* '\\mvariations?\\M'`
        : kind === 'parallel'
          ? sql`${cardVariations.variationOrParallel} !~* '\\mvariations?\\M'`
          : undefined;

      const baseFilters = [
        sql`lower(${cardVariations.brand}) = lower(${brand.trim()})`,
        eq(cardVariations.year, year),
      ];
      if (serialFilter) baseFilters.push(serialFilter);
      if (kindFilter) baseFilters.push(kindFilter);
      const base = and(...baseFilters);

      const runQuery = (extra?: any) =>
        db
          .select({
            variationOrParallel: cardVariations.variationOrParallel,
            serialNumber: cardVariations.serialNumber,
            cmpNumber: max(cardVariations.cmpNumber),
          })
          .from(cardVariations)
          .where(extra ? and(base, extra) : base)
          .groupBy(cardVariations.variationOrParallel, cardVariations.serialNumber)
          .orderBy(cardVariations.variationOrParallel)
          .limit(300);

      // Pass 1: collection + set (most precise)
      if (collection?.trim() && set?.trim()) {
        const options = await runQuery(and(
          sql`lower(${cardVariations.collection}) = lower(${collection.trim()})`,
          sql`lower(${cardVariations.set}) = lower(${set.trim()})`
        ));
        if (options.length > 0) return res.json({ options });
      }

      // Pass 2: set only (handles cases where DB collection ≠ OCR collection)
      if (set?.trim()) {
        const options = await runQuery(sql`lower(${cardVariations.set}) = lower(${set.trim()})`);
        if (options.length > 0) return res.json({ options });
      }

      // Pass 3: collection only
      if (collection?.trim()) {
        const options = await runQuery(sql`lower(${cardVariations.collection}) = lower(${collection.trim()})`);
        if (options.length > 0) return res.json({ options });
      }

      // Pass 4: brand+year only (broadest fallback; caller filters client-side by keyword)
      const options = await runQuery();
      return res.json({ options });
    } catch (err: any) {
      console.error('Error fetching variation options:', err.message);
      return res.status(500).json({ error: 'Failed to fetch variation options' });
    }
  });

  // Scan correction log — captures user edits to OCR-detected
  // fields (card #, parallel, etc.) so we can review patterns later and
  // tune the vision prompts. Lightweight: log-only for now (writes a
  // line to server logs), never blocks the UI. Returns 202 on accept.
  app.post(`${apiPrefix}/scan-corrections`, async (req, res) => {
    try {
      const {
        field, detected, corrected,
        brand, year, collection, set,
        playerFirstName, playerLastName,
      } = (req.body || {}) as Record<string, any>;
      console.log('[ScanCorrection]', JSON.stringify({
        field, detected, corrected,
        brand, year, collection, set,
        player: [playerFirstName, playerLastName].filter(Boolean).join(' ').trim() || null,
        ts: new Date().toISOString(),
      }));
      return res.status(202).json({ ok: true });
    } catch (err: any) {
      // Correction logging is best-effort — never 500 back to the client.
      console.warn('[ScanCorrection] log failed:', err?.message);
      return res.status(202).json({ ok: false });
    }
  });

  // Holo grade history for the authenticated user
  app.get(`${apiPrefix}/scan-grades`, requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any)?.id as number;
      const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
      const rows = await listGradesForUser(userId, limit);
      const grades = rows.map(hydrateGrade);

      const cardIds = Array.from(
        new Set(
          grades
            .map((g) => g.cardId)
            .filter((id): id is number => typeof id === 'number' && id > 0),
        ),
      );
      const priceByCardId = new Map<number, number>();
      if (cardIds.length > 0) {
        const priceRows = await db
          .select({ id: cards.id, estimatedValue: cards.estimatedValue })
          .from(cards)
          .where(inArray(cards.id, cardIds));
        for (const row of priceRows) {
          const v = row.estimatedValue != null ? Number(row.estimatedValue) : NaN;
          if (Number.isFinite(v) && v > 0) priceByCardId.set(row.id, v);
        }
      }
      const enriched = grades.map((g) => {
        // Prefer the saved card's estimatedValue (it gets re-priced via the
        // backfill endpoint and reflects the user's chosen variant). Fall
        // back to the scan-time average persisted on the scan_grades row so
        // unsaved scans still render a price.
        const cardPrice = g.cardId != null ? priceByCardId.get(g.cardId) ?? null : null;
        const cachedPrice = cardPrice != null ? cardPrice : g.estimatedValue ?? null;
        return { ...g, cachedPrice };
      });
      return res.json({ success: true, grades: enriched });
    } catch (err: any) {
      console.error('Error fetching scan grades:', err);
      return res.status(500).json({ success: false, error: 'Failed to fetch scan grades' });
    }
  });

  // Per-scan detail. Powers the /scans/:id detail page reached from the
  // Home Recent Scans tiles. Returns the same hydrated shape as the list
  // endpoint plus `cachedPrice`, so the client can render front+back +
  // identification + grade + cached value from a single call.
  //
  // Ownership gate: 404 (not 403) when the row belongs to another user, so
  // we don't leak existence of other users' scan ids.
  app.get(`${apiPrefix}/scan-grades/:id`, requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any)?.id as number;
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid scan id' });
      }
      const row = await getGradeById(id);
      if (!row || row.userId !== userId) {
        return res.status(404).json({ success: false, error: 'Not found' });
      }
      const grade = hydrateGrade(row);
      let cachedPrice: number | null = null;
      if (grade.cardId != null) {
        const [priceRow] = await db
          .select({ estimatedValue: cards.estimatedValue })
          .from(cards)
          .where(eq(cards.id, grade.cardId))
          .limit(1);
        const v = priceRow?.estimatedValue != null ? Number(priceRow.estimatedValue) : NaN;
        if (Number.isFinite(v) && v > 0) cachedPrice = v;
      }
      // Fall back to the scan-time average value persisted on the
      // scan_grades row when no saved-card price is available.
      if (cachedPrice == null && grade.estimatedValue != null && grade.estimatedValue > 0) {
        cachedPrice = grade.estimatedValue;
      }
      return res.json({ success: true, grade: { ...grade, cachedPrice } });
    } catch (err: any) {
      console.error('Error fetching scan grade:', err);
      return res.status(500).json({ success: false, error: 'Failed to fetch scan grade' });
    }
  });

  // POST /api/scan-grades/:id/refresh-price — re-run the eBay price lookup
  // against an already-stored scan's identification and persist the result.
  // Powers the "Refresh price" button on /scans/:id (see ScanDetail). The
  // resolution pattern (cards+brands JOIN when cardId is set, else the
  // identification JSONB blob) mirrors scripts/backfill_scan_grades_estimated_value.ts
  // so the live and backfill paths stay in sync.
  //
  // Persistence: only writes a hit. A miss leaves any existing
  // estimated_value untouched so a transient eBay outage can't erase a
  // good price.
  app.post(`${apiPrefix}/scan-grades/:id/refresh-price`, requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any)?.id as number;
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid scan id' });
      }
      const row = await getGradeById(id);
      // 404 (not 403) on cross-user access — same rationale as the GET sibling:
      // don't leak existence of other users' scan ids.
      if (!row || row.userId !== userId) {
        return res.status(404).json({ success: false, error: 'Not found' });
      }

      type Resolved = {
        playerName: string;
        cardNumber: string;
        brand: string;
        year: number;
        collection: string | undefined;
        set: string | undefined;
        isNumbered: boolean;
        foilType: string | undefined;
        serialNumber: string | undefined;
        variant: string | undefined;
        isAutographed: boolean;
        gradeKeyword: string | undefined;
      };

      let resolved: Resolved | null = null;

      if (row.cardId != null) {
        const [cardRow] = await db
          .select({
            playerFirstName: cards.playerFirstName,
            playerLastName: cards.playerLastName,
            brandName: brands.name,
            collection: cards.collection,
            cardNumber: cards.cardNumber,
            year: cards.year,
            variant: cards.variant,
            serialNumber: cards.serialNumber,
            isNumbered: cards.isNumbered,
            isAutographed: cards.isAutographed,
            foilType: cards.foilType,
            isGraded: cards.isGraded,
            gradingCompany: cards.gradingCompany,
            numericalGrade: cards.numericalGrade,
          })
          .from(cards)
          .innerJoin(brands, eq(cards.brandId, brands.id))
          .where(eq(cards.id, row.cardId))
          .limit(1);
        if (cardRow) {
          const { formatGradeKeyword } = await import('./vlmGradingPrompt');
          const playerName =
            `${cardRow.playerFirstName ?? ''} ${cardRow.playerLastName ?? ''}`.trim();
          const gradeNum =
            cardRow.numericalGrade != null ? Number(cardRow.numericalGrade) : null;
          const gradeKeyword = cardRow.isGraded
            ? formatGradeKeyword(
                cardRow.gradingCompany ?? null,
                gradeNum != null && Number.isFinite(gradeNum) ? gradeNum : null,
              ) || undefined
            : undefined;
          resolved = {
            playerName,
            cardNumber: cardRow.cardNumber || '',
            brand: cardRow.brandName || '',
            year: cardRow.year || 2024,
            collection: cardRow.collection || undefined,
            set: undefined,
            isNumbered: !!cardRow.isNumbered,
            foilType: cardRow.foilType || undefined,
            serialNumber: cardRow.serialNumber || undefined,
            variant: cardRow.variant || undefined,
            isAutographed: !!cardRow.isAutographed,
            gradeKeyword,
          };
        }
      }

      if (!resolved) {
        const ident = (row.identification ?? null) as
          | {
              player?: string | null;
              brand?: string | null;
              setName?: string | null;
              collection?: string | null;
              year?: string | number | null;
              cardNumber?: string | null;
              serialNumber?: string | null;
              parallel?: string | null;
              variant?: string | null;
            }
          | null;
        const playerName = (ident?.player || '').toString().trim();
        if (playerName) {
          let yearNum = 2024;
          if (typeof ident?.year === 'number' && Number.isFinite(ident.year)) {
            yearNum = Math.floor(ident.year);
          } else if (typeof ident?.year === 'string') {
            const m = ident.year.match(/\d{4}/);
            if (m) yearNum = Number(m[0]);
          }
          resolved = {
            playerName,
            cardNumber: (ident?.cardNumber || '').toString().trim(),
            brand: (ident?.brand || '').toString().trim(),
            year: yearNum,
            collection: ident?.collection ? ident.collection.toString().trim() : undefined,
            set: ident?.setName ? ident.setName.toString().trim() : undefined,
            isNumbered: !!(ident?.serialNumber && ident.serialNumber.toString().trim()),
            foilType: ident?.parallel ? ident.parallel.toString().trim() : undefined,
            serialNumber: ident?.serialNumber
              ? ident.serialNumber.toString().trim()
              : undefined,
            variant: ident?.variant ? ident.variant.toString().trim() : undefined,
            isAutographed: false,
            gradeKeyword: undefined,
          };
        }
      }

      if (!resolved || !resolved.playerName) {
        return res.status(422).json({
          success: false,
          error: 'No identification on this scan to search with',
        });
      }

      const ebay = await searchCardValues(
        resolved.playerName,
        resolved.cardNumber,
        resolved.brand,
        resolved.year,
        resolved.collection,
        '',
        resolved.isNumbered,
        resolved.foilType,
        resolved.serialNumber,
        resolved.variant,
        resolved.isAutographed,
        undefined,
        resolved.set,
        resolved.gradeKeyword ? { gradeKeyword: resolved.gradeKeyword } : undefined,
      );

      const value = ebay?.averageValue;
      const resultCount = Array.isArray(ebay?.results) ? ebay!.results.length : 0;
      const query = ebay?.searchUrl ?? '';
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        await updateGradeEstimatedValue(id, value);
        return res.json({
          success: true,
          estimatedValue: value,
          query,
          resultCount,
        });
      }
      // No listings — leave the existing estimated_value alone so a
      // transient miss can't erase a good price.
      return res.json({
        success: true,
        estimatedValue: null,
        query,
        resultCount: 0,
      });
    } catch (err: any) {
      console.error('Error refreshing scan price:', err);
      return res
        .status(500)
        .json({ success: false, error: err?.message || 'Failed to refresh price' });
    }
  });

  // ─── Beta Launch: Scan Quota + Feedback + Admin User Management ───────────
  // These endpoints support the closed beta (~6 testers + 1 dealer). They
  // are NOT bolted onto the existing card-database admin routes because:
  //   1. The existing admin gate requires BOTH email match AND a shared
  //      ADMIN_PASSWORD header — appropriate for destructive ops like CSV
  //      imports. The beta admin page (per-user limit edits, count resets)
  //      is lower-stakes and used during dev, so we drop the password gate
  //      to reduce friction. Email match alone is sufficient.
  //   2. Mixing these routes into the destructive-ops middleware would
  //      force a password prompt on the admin page that the user wouldn't
  //      want during normal beta operations.

  // GET /api/user/scan-quota — current user's quota state. Used by the header
  // usage indicator ("X / 50 cards used") and by Single/Bulk Scan to render
  // a clean "limit reached" empty state instead of letting users try to scan
  // and getting back a 429.
  app.get(`${apiPrefix}/user/scan-quota`, requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any)?.id as number;
      const quota = await getScanQuota(userId);
      return res.json(quota);
    } catch (err: any) {
      console.error('[scanQuota] GET /user/scan-quota failed:', err);
      return res.status(500).json({ error: 'Failed to fetch quota' });
    }
  });

  // POST /api/feedback — append a row to the admin's feedback Google Sheet.
  // Auth-gated so anonymous traffic can't spam the sheet. Body shape is
  // validated lightly (category + message required); the rest is best-effort
  // metadata captured from the client.
  const feedbackBodySchema = z.object({
    category: z.enum(['Bug', 'Idea', 'Question', 'Other']),
    message: z.string().trim().min(1).max(4000),
    pageUrl: z.string().max(2000).optional().nullable(),
    lastScanId: z.union([z.number(), z.string()]).optional().nullable(),
  });
  app.post(`${apiPrefix}/feedback`, requireAuth, async (req, res) => {
    const parsed = feedbackBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_body',
        details: parsed.error.flatten(),
      });
    }
    try {
      const { appendFeedbackRow, FeedbackNotConfiguredError } = await import('./feedback');
      const u = req.user as any;
      const userAgent = (req.headers['user-agent'] as string | undefined) || null;
      try {
        await appendFeedbackRow({
          userId: u?.id ?? null,
          userEmail: u?.email ?? null,
          category: parsed.data.category,
          message: parsed.data.message,
          pageUrl: parsed.data.pageUrl ?? null,
          lastScanId: parsed.data.lastScanId ?? null,
          userAgent,
        });
        return res.json({ success: true });
      } catch (err: any) {
        if (err instanceof FeedbackNotConfiguredError) {
          // 503 (not 500) so the frontend can show a "feedback temporarily
          // unavailable" message rather than a generic crash toast.
          console.warn('[feedback] not configured:', err.message);
          return res.status(503).json({ error: 'feedback_unavailable', detail: err.message });
        }
        throw err;
      }
    } catch (err: any) {
      console.error('[feedback] append failed:', err);
      return res.status(500).json({ error: 'feedback_write_failed' });
    }
  });

  // ── Admin user-management gate ───────────────────────────────────────────
  // Email-only — see top-of-section rationale. Mirrors the email check from
  // requireAdminPassword but skips the shared-secret header.
  function requireAdminUser(req: Request, res: Response, next: NextFunction) {
    const userEmail = ((req.user as any)?.email || '').toString().toLowerCase();
    if (!req.isAuthenticated?.() || !userEmail || userEmail !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Forbidden: admin access restricted' });
    }
    return next();
  }

  // GET /api/admin/users — table for the admin page. Returns one row per user
  // with the fields we need to render usage + edit limits. We deliberately
  // omit token columns (googleAccessToken, password hash) to keep the
  // response small and avoid leaking secrets to the admin UI.
  app.get(`${apiPrefix}/admin/users`, requireAuth, requireAdminUser, async (_req, res) => {
    try {
      const rows = await db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          username: schema.users.username,
          scanLimit: schema.users.scanLimit,
          scanCount: schema.users.scanCount,
          createdAt: schema.users.createdAt,
        })
        .from(schema.users)
        .orderBy(desc(schema.users.createdAt));
      return res.json({ users: rows });
    } catch (err: any) {
      console.error('[admin] list users failed:', err);
      return res.status(500).json({ error: 'Failed to list users' });
    }
  });

  // PATCH /api/admin/users/:id — update a single user's scan limit and/or
  // reset their count. Body: { scanLimit?: number, resetCount?: boolean }.
  // We accept partial updates so the admin UI can do "edit limit" or
  // "reset count" independently with a single endpoint.
  const adminUserPatchSchema = z.object({
    scanLimit: z.number().int().min(0).max(100000).optional(),
    resetCount: z.boolean().optional(),
  }).refine((b) => b.scanLimit !== undefined || b.resetCount === true, {
    message: 'Provide scanLimit or resetCount',
  });
  app.patch(`${apiPrefix}/admin/users/:id`, requireAuth, requireAdminUser, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid_user_id' });
    }
    const parsed = adminUserPatchSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    try {
      const update: Record<string, unknown> = {};
      if (parsed.data.scanLimit !== undefined) update.scanLimit = parsed.data.scanLimit;
      if (parsed.data.resetCount) update.scanCount = 0;
      const [row] = await db
        .update(schema.users)
        .set(update)
        .where(eq(schema.users.id, id))
        .returning({
          id: schema.users.id,
          email: schema.users.email,
          scanLimit: schema.users.scanLimit,
          scanCount: schema.users.scanCount,
        });
      if (!row) return res.status(404).json({ error: 'user_not_found' });
      return res.json({ user: row });
    } catch (err: any) {
      console.error(`[admin] patch user ${id} failed:`, err);
      return res.status(500).json({ error: 'Failed to update user' });
    }
  });

  // POST /api/admin/users/bump-all — add `delta` to every user's scanLimit.
  // Used to give all testers another batch of scans at once during beta
  // (the user's stated workflow when monetization is paused). We allow
  // negative deltas too in case we need to course-correct, but never let
  // a user's limit go below zero — clamp at 0 in SQL.
  const adminBumpSchema = z.object({
    delta: z.number().int().min(-100000).max(100000),
  });
  app.post(`${apiPrefix}/admin/users/bump-all`, requireAuth, requireAdminUser, async (req, res) => {
    const parsed = adminBumpSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const { delta } = parsed.data;
    if (delta === 0) return res.json({ updated: 0, delta });
    try {
      const result = await db
        .update(schema.users)
        .set({ scanLimit: sql`GREATEST(0, ${schema.users.scanLimit} + ${delta})` })
        .returning({ id: schema.users.id });
      return res.json({ updated: result.length, delta });
    } catch (err: any) {
      console.error('[admin] bump-all failed:', err);
      return res.status(500).json({ error: 'Failed to bump limits' });
    }
  });

  // ─── /admin/scans — user scan review ────────────────────────────────────
  // List rows from `user_scans`. Same email-only gate as /admin/users. The
  // table is intentionally large (one row per save event), so we paginate
  // and let the admin filter by action + user.
  const adminScansQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    action: z.enum(['confirmed', 'declined_edited', 'saved_no_feedback', 'analyzed_no_save']).optional(),
    userId: z.coerce.number().int().positive().optional(),
  });
  app.get(`${apiPrefix}/admin/scans`, requireAuth, requireAdminUser, async (req, res) => {
    const parsed = adminScansQuerySchema.safeParse(req.query || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
    }
    const limit = parsed.data.limit ?? 50;
    const offset = parsed.data.offset ?? 0;
    try {
      const filters = [] as any[];
      if (parsed.data.action) filters.push(eq(schema.userScans.userAction, parsed.data.action));
      if (parsed.data.userId !== undefined) filters.push(eq(schema.userScans.userId, parsed.data.userId));

      // Join users so the admin can see who scanned each card without a
      // second round-trip. We left-join because `user_scans.user_id` is
      // nullable (a user-deleted-account scenario keeps the row).
      const baseQuery = db
        .select({
          id: schema.userScans.id,
          userId: schema.userScans.userId,
          userEmail: schema.users.email,
          cardId: schema.userScans.cardId,
          scannedAt: schema.userScans.scannedAt,
          userAction: schema.userScans.userAction,
          fieldsChanged: schema.userScans.fieldsChanged,
          finalPlayerFirstName: schema.userScans.finalPlayerFirstName,
          finalPlayerLastName: schema.userScans.finalPlayerLastName,
          finalBrand: schema.userScans.finalBrand,
          finalYear: schema.userScans.finalYear,
          finalCardNumber: schema.userScans.finalCardNumber,
          finalSet: schema.userScans.finalSet,
          finalCollection: schema.userScans.finalCollection,
          finalVariant: schema.userScans.finalVariant,
          finalTeam: schema.userScans.finalTeam,
          finalCmpNumber: schema.userScans.finalCmpNumber,
          frontImage: schema.userScans.frontImage,
          scpScore: schema.userScans.scpScore,
          cardDbCorroborated: schema.userScans.cardDbCorroborated,
        })
        .from(schema.userScans)
        .leftJoin(schema.users, eq(schema.users.id, schema.userScans.userId));

      const rows = await (filters.length
        ? baseQuery.where(and(...filters))
        : baseQuery)
        .orderBy(desc(schema.userScans.scannedAt))
        .limit(limit)
        .offset(offset);

      const totalRow = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.userScans)
        .where(filters.length ? and(...filters) : sql`true`);
      const total = totalRow[0]?.count ?? 0;

      return res.json({ scans: rows, total, limit, offset });
    } catch (err: any) {
      console.error('[admin] list scans failed:', err);
      return res.status(500).json({ error: 'Failed to list scans' });
    }
  });

  // GET /api/admin/scans/:id — full row including all detected/final fields
  // and back image. Used by the detail drawer on the admin page.
  app.get(`${apiPrefix}/admin/scans/:id`, requireAuth, requireAdminUser, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid_id' });
    }
    try {
      const rows = await db
        .select({
          scan: schema.userScans,
          userEmail: schema.users.email,
        })
        .from(schema.userScans)
        .leftJoin(schema.users, eq(schema.users.id, schema.userScans.userId))
        .where(eq(schema.userScans.id, id))
        .limit(1);
      if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
      // Parse the persisted Gemini snapshot string into an object so the
      // admin client doesn't have to re-parse it. Falls back to null on
      // legacy rows or malformed JSON — the modal's per-field fallback
      // path uses the existing `detectedX` columns when this is null.
      const rawSnapshot = (rows[0].scan as any).geminiSnapshot as string | null | undefined;
      let parsedGeminiSnapshot: any = null;
      if (typeof rawSnapshot === 'string' && rawSnapshot.trim()) {
        try { parsedGeminiSnapshot = JSON.parse(rawSnapshot); }
        catch { parsedGeminiSnapshot = null; }
      }
      return res.json({
        scan: {
          ...rows[0].scan,
          userEmail: rows[0].userEmail,
          geminiSnapshot: parsedGeminiSnapshot,
        },
      });
    } catch (err: any) {
      console.error(`[admin] get scan ${id} failed:`, err);
      return res.status(500).json({ error: 'Failed to load scan' });
    }
  });

  // ─── /admin/bulk-batches — bulk-scan stage-timing diagnostics ──────────
  // Returns the per-batch `timings` JSONB written by the bulk-scan worker
  // (see server/bulkScan/timingsRecorder.ts). Prod log streams have proven
  // unreliable for the bulk-scan worker, so this DB-backed payload is the
  // canonical source of stage durations: list-inbox latency, per-file
  // download/probe/classify times, per-pair Gemini/eBay/CardDB times, and
  // the time-to-first-pair landmark. Same email-only admin gate as
  // /admin/scans and /admin/users.
  app.get(`${apiPrefix}/admin/bulk-batches/recent`, requireAuth, requireAdminUser, async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    try {
      const rows = await db
        .select({
          id: schema.scanBatches.id,
          userId: schema.scanBatches.userId,
          status: schema.scanBatches.status,
          fileCount: schema.scanBatches.fileCount,
          processedCount: schema.scanBatches.processedCount,
          reviewQueueCount: schema.scanBatches.reviewQueueCount,
          dryRun: schema.scanBatches.dryRun,
          createdAt: schema.scanBatches.createdAt,
          completedAt: schema.scanBatches.completedAt,
          timings: schema.scanBatches.timings,
          userEmail: schema.users.email,
        })
        .from(schema.scanBatches)
        .leftJoin(schema.users, eq(schema.users.id, schema.scanBatches.userId))
        .orderBy(desc(schema.scanBatches.createdAt))
        .limit(limit);
      return res.json({ batches: rows });
    } catch (err: any) {
      console.error('[admin] list recent bulk batches failed:', err);
      return res.status(500).json({ error: 'Failed to list bulk batches' });
    }
  });

  app.get(`${apiPrefix}/admin/bulk-batches/:id/timings`, requireAuth, requireAdminUser, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid_id' });
    }
    try {
      const [row] = await db
        .select({
          id: schema.scanBatches.id,
          userId: schema.scanBatches.userId,
          status: schema.scanBatches.status,
          fileCount: schema.scanBatches.fileCount,
          processedCount: schema.scanBatches.processedCount,
          reviewQueueCount: schema.scanBatches.reviewQueueCount,
          createdAt: schema.scanBatches.createdAt,
          completedAt: schema.scanBatches.completedAt,
          timings: schema.scanBatches.timings,
        })
        .from(schema.scanBatches)
        .where(eq(schema.scanBatches.id, id))
        .limit(1);
      if (!row) return res.status(404).json({ error: 'not_found' });
      return res.json({ batch: row });
    } catch (err: any) {
      console.error(`[admin] get bulk batch ${id} timings failed:`, err);
      return res.status(500).json({ error: 'Failed to load batch timings' });
    }
  });

  // POST /api/admin/rebuild-ebay-urls — one-shot backfill that recomputes
  // the eBay-URL column for every row in the user's active sheet using the
  // fixed `getEbaySearchUrl`. Subset is NOT a sheet column, so backfill
  // produces URLs without the subset hint — still correct (real player in
  // the quoted slot, eBay returns listings). Body: `{ userId?, dryRun? }`.
  // dryRun=true returns a 5-row before/after preview without writing.
  app.post(`${apiPrefix}/admin/rebuild-ebay-urls`, requireAuth, requireAdminUser, async (req, res) => {
    const dryRun = req.body?.dryRun === true;
    const reqUserIdRaw = req.body?.userId;
    const callerUserId = (req.user as any)?.id;
    const targetUserId = typeof reqUserIdRaw === 'number' && Number.isFinite(reqUserIdRaw)
      ? reqUserIdRaw
      : callerUserId;
    if (typeof targetUserId !== 'number' || !Number.isFinite(targetUserId)) {
      return res.status(400).json({ error: 'invalid_user' });
    }
    try {
      const { rebuildEbayUrlsForUser } = await import('./googleSheets');
      const buildUrl = (row: any): string => {
        const player = [row.playerFirstName, row.playerLastName].filter(Boolean).join(' ').trim();
        const brandName = (row.brand && typeof row.brand === 'object') ? row.brand.name : (row.brand || '');
        if (!brandName || !player) return '';
        const yr = typeof row.year === 'number' ? row.year : 0;
        return getEbaySearchUrl(
          player,
          row.cardNumber || '',
          brandName,
          yr,
          row.collection || '',
          '',
          !!row.isNumbered,
          row.foilType || '',
          row.serialNumber || '',
          row.variant || '',
          row.set || '',
          undefined,
          !!row.isAutographed,
          false,
          '', // subset not stored in sheet — see helper docstring
        );
      };
      const result = await rebuildEbayUrlsForUser(targetUserId, buildUrl, { dryRun });
      return res.json({ dryRun, userId: targetUserId, ...result });
    } catch (err: any) {
      console.error('[admin] rebuild-ebay-urls failed:', err);
      return res.status(500).json({ error: err?.message || 'rebuild_failed' });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}