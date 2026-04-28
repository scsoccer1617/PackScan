/**
 * Gemini VLM integration for the Holo scanning engine.
 *
 * Provides an independent visual reading of a card (front + back) that the
 * agreement-scorer can compare against the existing OCR pipeline. When the
 * two label sources agree, we have a high-confidence training-data row;
 * when they disagree, the card goes to the human review queue.
 *
 * Uses @google/genai (the current Google Gen AI SDK; the older
 * @google/generative-ai package is deprecated). Auth via process.env.GEMINI_API_KEY.
 */

import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs/promises';
import * as path from 'path';
import { VLM_FULL_PROMPT, VLM_PROMPT_VERSION } from './vlmPrompts';
import { normalizeGeminiResult } from './geminiNormalize';

let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set. Add it to Replit Secrets or your environment.');
  }
  cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.heic' || ext === '.heif') return 'image/heic';
  // default: jpeg
  return 'image/jpeg';
}

export interface GeminiCardResult {
  subjectType?: string | null;
  sport?: string | null;
  player?: string | null;
  year?: number | null;
  yearPrintedRaw?: string | null;
  brand?: string | null;
  set?: string | null;
  collection?: string | null;
  cardNumber?: string | null;
  /** Manufacturer reference code printed in the back-side legal strip
   *  (e.g. "CMP100358"). Used as a structural anchor for set/collection
   *  disambiguation when present. Null when not visible or unreadable. */
  cmpCode?: string | null;
  parallel?: {
    name?: string | null;
    isFoil?: boolean;
    isRefractor?: boolean;
    borderTint?: string | null;
    saturation?: string | null;
  } | null;
  isAutograph?: boolean;
  isRelic?: boolean;
  isRookie?: boolean;
  printRun?: number | string | null;
  team?: string | null;
  position?: string | null;
  /** Numeric confidence map. Older prompt versions returned string labels
   *  ("High"/"Medium"/"Low") here; current prompt requires floats 0.0–1.0,
   *  but downstream code should still tolerate either shape. */
  confidence?: Record<string, number | string | null>;
  notes?: string | null;
}

export interface AnalyzeOptions {
  /** Override the default Gemini model. Defaults to gemini-2.5-flash for cost/speed. */
  model?: string;
  /** Override the prompt. Defaults to the versioned VLM_FULL_PROMPT. */
  prompt?: string;
  /** Override the result-template fragment (already included in VLM_FULL_PROMPT). */
  resultTemplate?: string;
}

/**
 * Analyse a trading card image pair (front + back) with Gemini.
 *
 * Returns the parsed JSON metadata Gemini extracted, or throws on
 * network / auth / parse errors. Use a try/catch at the call site —
 * batch runners should mark the card as "errored" and continue.
 */
export async function analyzeCardWithGemini(
  frontPath: string,
  backPath: string,
  promptOrSystem?: string,
  resultTemplate?: string,
  opts: AnalyzeOptions = {}
): Promise<GeminiCardResult> {
  const [front, back] = await Promise.all([
    fs.readFile(frontPath),
    fs.readFile(backPath),
  ]);
  return analyzeCardBuffersWithGemini(
    front,
    back,
    {
      ...opts,
      frontMime: mimeFromPath(frontPath),
      backMime: mimeFromPath(backPath),
    },
    promptOrSystem,
    resultTemplate,
  );
}

/**
 * Buffer-input variant of analyzeCardWithGemini. Used by the live scan
 * pipeline where front/back image buffers are already in memory after EXIF
 * orientation normalization — avoids a redundant fs round-trip.
 */
export async function analyzeCardBuffersWithGemini(
  frontBuffer: Buffer,
  backBuffer: Buffer,
  opts: AnalyzeOptions & { frontMime?: string; backMime?: string } = {},
  promptOrSystem?: string,
  resultTemplate?: string,
): Promise<GeminiCardResult> {
  const client = getClient();
  const model = opts.model || 'gemini-2.5-flash';

  // Build the prompt. Backwards-compatible: callers can pass (prompt,
  // template) as positional args (older shape) OR rely on VLM_FULL_PROMPT.
  let fullPrompt: string;
  if (promptOrSystem && resultTemplate) {
    fullPrompt = `${promptOrSystem}\n\nReturn JSON matching this template:\n${resultTemplate}`;
  } else if (promptOrSystem) {
    fullPrompt = promptOrSystem;
  } else {
    fullPrompt = VLM_FULL_PROMPT;
  }

  const frontMime = opts.frontMime || 'image/jpeg';
  const backMime = opts.backMime || 'image/jpeg';

  const response = await client.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          { text: fullPrompt },
          { inlineData: { data: frontBuffer.toString('base64'), mimeType: frontMime } },
          { inlineData: { data: backBuffer.toString('base64'), mimeType: backMime } },
        ],
      },
    ],
    config: { responseMimeType: 'application/json' },
  });

  const text = response.text ?? '';
  if (!text.trim()) {
    throw new Error('Gemini returned empty response');
  }

  // Strip markdown fences if the model wrapped its JSON despite the
  // response-mime-type hint (rare but happens on edge prompts).
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  try {
    // Normalize at the boundary: Gemini sometimes returns the literal
    // string "None detected" (and other sentinels) for parallel.name
    // and set, defeating downstream "is this empty?" gates. Convert
    // sentinels to null here so every consumer reads a consistent
    // shape. See server/geminiNormalize.ts for the sentinel tables.
    const parsed = JSON.parse(cleaned) as GeminiCardResult;
    return normalizeGeminiResult(parsed as Record<string, any>) as GeminiCardResult;
  } catch (err: any) {
    throw new Error(
      `Gemini JSON parse error: ${err.message}. First 200 chars: ${cleaned.slice(0, 200)}`
    );
  }
}

export const VLM_INFO = { promptVersion: VLM_PROMPT_VERSION };
