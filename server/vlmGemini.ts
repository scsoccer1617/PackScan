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
  /** Which of the two input images Gemini judged to be the FRONT of the card.
   *  0 = first image passed to analyzeCardBuffersWithGemini (i.e. frontBuffer
   *      slot in the API call) is the actual front.
   *  1 = second image (backBuffer slot) is the actual front — i.e. the caller's
   *      pair was reversed and the persisted front/back URLs should be swapped.
   *  null/absent = Gemini could not decide; caller falls back to whatever
   *  upstream signal it had. Optional so older deployments returning the
   *  field absent still typecheck. */
  frontImageIndex?: 0 | 1 | null;
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

  // QW-1 instrumentation: dedicated timer for the Gemini network call
  // alone, separate from the broader 'gemini-vlm' timer that also covers
  // prompt assembly + JSON parse. Lets us read the network slice in
  // isolation when judging future quick wins (e.g. server-side downscale).
  const networkLabel = `gemini-network[${Math.random().toString(36).slice(2, 8)}]`;
  console.time(networkLabel);
  let response;
  try {
    // 429-only retry with exponential backoff (1s, 2s, 4s; 3 attempts).
    // Bulk Phase 2 runs at concurrency=8 — Gemini's per-minute (not
    // concurrent) quota means a transient burst can 429 a single pair,
    // and a one-attempt failure here propagates as a permanent
    // processItem error. Non-429 errors fall straight through unchanged.
    const RETRY_DELAYS_MS = [1000, 2000, 4000];
    let attempt = 0;
    while (true) {
      try {
        response = await client.models.generateContent({
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
        break;
      } catch (err: any) {
        const status = err?.status ?? err?.code ?? err?.response?.status;
        const message = String(err?.message ?? err ?? '');
        const isRateLimit =
          status === 429 ||
          /\b429\b/.test(message) ||
          /RESOURCE_EXHAUSTED/i.test(message) ||
          /rate.?limit/i.test(message) ||
          /quota/i.test(message);
        if (!isRateLimit || attempt >= RETRY_DELAYS_MS.length) throw err;
        const delay = RETRY_DELAYS_MS[attempt++];
        console.warn(
          `[vlmGemini] 429/quota on attempt ${attempt}, retrying in ${delay}ms: ${message.slice(0, 200)}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  } finally {
    console.timeEnd(networkLabel);
  }

  const text = response.text ?? '';
  return finalizeGeminiText(text);
}

/**
 * Strip markdown fences and parse Gemini's JSON output, then run it through
 * the boundary sentinel-normalizer. Pure function — no I/O, no SDK calls —
 * so the streaming path (analyzeCardBuffersWithGeminiStream) and the
 * non-streaming path (analyzeCardBuffersWithGemini) can share ONE
 * post-processor.
 *
 * INVARIANT: streaming and non-streaming Gemini responses, given the same
 * accumulated text, produce byte-identical GeminiCardResult objects. Year
 * rule application (vlmPrompts.ts v2026-04-28.7) flows entirely through
 * the prompt + JSON.parse here; there is no parallel parser. Do NOT add
 * a second normalizer for the streaming case.
 */
export function finalizeGeminiText(text: string): GeminiCardResult {
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

/**
 * Streaming variant of analyzeCardBuffersWithGemini. Uses Gemini's
 * generateContentStream so the SSE endpoint can surface partial fields
 * to the client while the model is still emitting tokens (perceived
 * latency win — first text arrives in ~1–2s, not the full ~17s).
 *
 * The return value is built by passing the FULLY accumulated stream
 * text through finalizeGeminiText — the EXACT same post-processor the
 * non-streaming path uses. Byte-identical final result is guaranteed
 * for the same accumulated text.
 *
 * @param onPartialText fired on every chunk with the accumulated text
 * so the SSE handler can attempt incremental parsing for partial UX.
 */
export async function analyzeCardBuffersWithGeminiStream(
  frontBuffer: Buffer,
  backBuffer: Buffer,
  opts: AnalyzeOptions & {
    frontMime?: string;
    backMime?: string;
    onPartialText?: (accumulatedText: string) => void;
  } = {},
): Promise<GeminiCardResult> {
  const client = getClient();
  const model = opts.model || 'gemini-2.5-flash';
  const fullPrompt = opts.prompt || VLM_FULL_PROMPT;
  const frontMime = opts.frontMime || 'image/jpeg';
  const backMime = opts.backMime || 'image/jpeg';

  const networkLabel = `gemini-stream-network[${Math.random().toString(36).slice(2, 8)}]`;
  console.time(networkLabel);
  let accumulated = '';
  try {
    // Same 429 retry envelope as the non-streaming path. The stream
    // request itself is a single SDK call that returns an async
    // generator; transient quota errors typically surface on the
    // initial request, so retrying the whole stream is safe.
    const RETRY_DELAYS_MS = [1000, 2000, 4000];
    let attempt = 0;
    while (true) {
      try {
        const stream = await client.models.generateContentStream({
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
        for await (const chunk of stream) {
          const t = chunk.text ?? '';
          if (!t) continue;
          accumulated += t;
          if (opts.onPartialText) {
            try {
              opts.onPartialText(accumulated);
            } catch (cbErr) {
              // Swallow callback errors so a flaky SSE writer never
              // kills the underlying Gemini stream.
              console.warn('[vlmGemini.stream] onPartialText callback threw:', cbErr);
            }
          }
        }
        break;
      } catch (err: any) {
        const status = err?.status ?? err?.code ?? err?.response?.status;
        const message = String(err?.message ?? err ?? '');
        const isRateLimit =
          status === 429 ||
          /\b429\b/.test(message) ||
          /RESOURCE_EXHAUSTED/i.test(message) ||
          /rate.?limit/i.test(message) ||
          /quota/i.test(message);
        if (!isRateLimit || attempt >= RETRY_DELAYS_MS.length) throw err;
        const delay = RETRY_DELAYS_MS[attempt++];
        accumulated = '';
        console.warn(
          `[vlmGemini.stream] 429/quota on attempt ${attempt}, retrying in ${delay}ms: ${message.slice(0, 200)}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  } finally {
    console.timeEnd(networkLabel);
  }

  return finalizeGeminiText(accumulated);
}

export const VLM_INFO = { promptVersion: VLM_PROMPT_VERSION };
