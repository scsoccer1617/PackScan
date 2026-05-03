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
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { VLM_FULL_PROMPT, VLM_PROMPT_VERSION } from './vlmPrompts';
import { normalizeGeminiResult } from './geminiNormalize';
import { isExemplarsEnabled, getExemplarTextPrefix, getExemplarParts } from './vlmExemplars';

let cachedClient: GoogleGenAI | null = null;

// QW-3: in-memory LRU cache for Gemini responses keyed by image content +
// prompt version + model. Users frequently retry the same buffers after a
// "didn't get it" toast and bulk testers re-upload the same Drive folders;
// the same (front, back, prompt, model) tuple should not pay the ~17s
// network round-trip twice. Cache is process-local — Replit dyno restarts
// wipe it, which is fine. Capped at 200 entries × ~1-3KB JSON = <1MB RAM.
// Including VLM_PROMPT_VERSION in the key means a prompt edit auto-
// invalidates every entry; including the model name means a VLM_MODEL env
// var swap invalidates entries for the old model.
type GeminiCacheEntry = { value: GeminiCardResult; expiresAt: number };
const GEMINI_CACHE_MAX = 200;
const GEMINI_CACHE_TTL_MS = 60 * 60 * 1000;
const geminiCache = new Map<string, GeminiCacheEntry>();

function geminiCacheKey(
  frontBuffer: Buffer,
  backBuffer: Buffer,
  model: string,
): string {
  const hash = createHash('sha256')
    .update(frontBuffer ?? Buffer.alloc(0))
    .update(backBuffer ?? Buffer.alloc(0))
    .digest('hex');
  return `${hash}|${VLM_PROMPT_VERSION}|${model}`;
}

function geminiCacheGet(key: string): GeminiCardResult | null {
  const entry = geminiCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    geminiCache.delete(key);
    return null;
  }
  // LRU touch: re-insert so this key becomes most-recently-used.
  geminiCache.delete(key);
  geminiCache.set(key, entry);
  return entry.value;
}

function geminiCacheSet(key: string, value: GeminiCardResult): void {
  if (geminiCache.has(key)) geminiCache.delete(key);
  if (geminiCache.size >= GEMINI_CACHE_MAX) {
    const oldest = geminiCache.keys().next().value;
    if (oldest !== undefined) geminiCache.delete(oldest);
  }
  geminiCache.set(key, { value, expiresAt: Date.now() + GEMINI_CACHE_TTL_MS });
}

// Model selection. Defaults to gemini-3-flash-preview (PR: vlm gemini-3 swap)
// based on a user A/B that showed it correctly reads dense back-of-card legal
// strips that gemini-2.5-flash misreads. gemini-2.5-flash is kept as the
// automatic fallback when the primary errors with model-availability errors
// (404, "model not found", "not available", preview deprecation, etc.) — NOT
// for transient 429/quota, which has its own retry loop. Override either side
// via env to pin a specific model for tests / rollback.
const VLM_PRIMARY_MODEL = process.env.VLM_MODEL || 'gemini-3-flash-preview';
const VLM_FALLBACK_MODEL = process.env.VLM_FALLBACK_MODEL || 'gemini-2.5-flash';

// Regex/status check for "this model is unreachable" vs "transient error".
// Only the former should trigger the fallback swap; 429/quota stays on the
// per-model retry loop because both candidate models share the same project
// quota and swapping wouldn't help.
function isModelAvailabilityError(err: any): boolean {
  const msg = String(err?.message ?? err ?? '');
  const status = err?.status ?? err?.code ?? err?.response?.status;
  return (
    status === 404 ||
    /model.*not.*found/i.test(msg) ||
    /not.*available/i.test(msg) ||
    /preview.*deprecat/i.test(msg) ||
    /unsupported/i.test(msg)
  );
}

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
  /** Multi-player extraction (prompt v2026-05-01.1+). Array of every named
   *  player visible on the card front, ordered top-to-bottom / left-to-right.
   *  Single-player cards still produce a 1-element array. `role` is set only
   *  when an inline label is printed next to the name (OUTFIELDER, PITCHER,
   *  MANAGER, etc.). Optional so older logged outputs remain typecheckable. */
  players?: Array<{
    firstName?: string | null;
    lastName?: string | null;
    role?: string | null;
  }> | null;
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
  /** Subset descriptor for cards that don't depict a single player (Team
   *  Leaders, Record Breakers, All-Star, Manager, etc.). Used by the eBay
   *  query builder to substitute the subset name for the player name when
   *  present, since real listings for these cards rarely include the
   *  pictured player. Null for standard individual-player cards. */
  subset?: string | null;
  notes?: string | null;
  /** Which Gemini model actually answered this scan. Captured for the audit
   *  Sheet so we can correlate quality regressions to a specific model — the
   *  primary (VLM_MODEL, default gemini-3-flash-preview) and the fallback
   *  (VLM_FALLBACK_MODEL, default gemini-2.5-flash) live behind the same
   *  function, so without this field the Sheet can't tell which one ran on
   *  any given row. Optional so older logged outputs still typecheck. */
  geminiModel?: string | null;
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
  // When opts.model is set (tests / pinned override), skip the fallback chain
  // and use only that model. Otherwise the chain is [primary, fallback].
  const candidateModels = opts.model
    ? [opts.model]
    : [VLM_PRIMARY_MODEL, VLM_FALLBACK_MODEL];

  // QW-3 cache lookup. Only consults the cache when callers use the
  // default prompt path (no positional prompt override) — a custom prompt
  // would invalidate the prompt-version component of the key. Keyed by the
  // first candidate model: on a future identical call we'd attempt that
  // same primary first, so serving the cached response (even if it
  // originally came from the fallback) is semantically equivalent and
  // saves the ~17s round-trip.
  const isDefaultPrompt = !promptOrSystem && !resultTemplate;
  const cacheKey = isDefaultPrompt
    ? geminiCacheKey(frontBuffer, backBuffer, candidateModels[0])
    : null;
  if (cacheKey) {
    const cached = geminiCacheGet(cacheKey);
    if (cached) {
      console.log(`[gemini-cache-hit] ${cacheKey.slice(0, 12)}…`);
      return cached;
    }
  }

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
  let response: any = null;
  let actualModelUsed: string = candidateModels[0];
  let modelAvailabilityErr: any = null;
  try {
    // Model fallback chain: try primary, then fallback, ONLY for
    // model-availability errors (404 / "not found" / preview deprecated).
    // 429/quota retries live INSIDE the per-model attempt — both candidates
    // share the same project quota, so swapping models on a transient rate
    // limit wouldn't help.
    for (const candidateModel of candidateModels) {
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
            const parts: any[] = [
              { text: fullPrompt },
              { inlineData: { data: frontBuffer.toString('base64'), mimeType: frontMime } },
              { inlineData: { data: backBuffer.toString('base64'), mimeType: backMime } },
            ];
            // Parallel Exemplar Library v1 (MOLO-grounded). Off by default;
            // when VLM_EXEMPLARS_ENABLED=true, append a short instructional
            // text part + 54 inline reference JPEGs so Gemini can match the
            // scanned card's parallel against canonical patterns. The base
            // prompt (vlmPrompts.ts, year rule v2026-04-28.7) is NOT
            // modified — exemplar guidance lives only in the appended
            // parts.
            if (isExemplarsEnabled()) {
              parts.push({ text: getExemplarTextPrefix() });
              parts.push(...getExemplarParts());
            }
            response = await client.models.generateContent({
              model: candidateModel,
              contents: [{ role: 'user', parts }],
              config: { responseMimeType: 'application/json' },
            });
            actualModelUsed = candidateModel;
            if (candidateModel !== candidateModels[0]) {
              console.warn(
                `[vlmGemini] primary model "${candidateModels[0]}" unavailable; succeeded on fallback "${candidateModel}"`,
              );
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
            console.warn(
              `[vlmGemini] 429/quota on attempt ${attempt} (model=${candidateModel}), retrying in ${delay}ms: ${message.slice(0, 200)}`,
            );
            await new Promise((r) => setTimeout(r, delay));
          }
        }
        break; // success — stop the model fallback chain
      } catch (err: any) {
        if (!isModelAvailabilityError(err)) throw err;
        modelAvailabilityErr = err;
        console.warn(
          `[vlmGemini] model "${candidateModel}" unavailable: ${String(err?.message ?? err).slice(0, 200)}`,
        );
        // continue to next candidate
      }
    }
    if (!response) throw modelAvailabilityErr ?? new Error('all candidate Gemini models failed');
  } finally {
    console.timeEnd(networkLabel);
  }

  const text = response.text ?? '';
  const result = finalizeGeminiText(text);
  result.geminiModel = actualModelUsed;
  // QW-3 cache write. Only on success — failures throw before reaching here,
  // so any response that lands in the cache parsed cleanly through
  // finalizeGeminiText (no empty/placeholder result).
  if (cacheKey) geminiCacheSet(cacheKey, result);
  return result;
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
  const candidateModels = opts.model
    ? [opts.model]
    : [VLM_PRIMARY_MODEL, VLM_FALLBACK_MODEL];
  const fullPrompt = opts.prompt || VLM_FULL_PROMPT;
  const frontMime = opts.frontMime || 'image/jpeg';
  const backMime = opts.backMime || 'image/jpeg';

  // QW-3 cache lookup (streaming variant). Only consult the cache for the
  // default prompt path. A cache hit returns immediately without invoking
  // onPartialText — the caller treats it as a single final delivery, which
  // is consistent with how non-streaming consumers see the same hit.
  const isDefaultPrompt = !opts.prompt;
  const cacheKey = isDefaultPrompt
    ? geminiCacheKey(frontBuffer, backBuffer, candidateModels[0])
    : null;
  if (cacheKey) {
    const cached = geminiCacheGet(cacheKey);
    if (cached) {
      console.log(`[gemini-cache-hit] ${cacheKey.slice(0, 12)}… (stream)`);
      return cached;
    }
  }

  const networkLabel = `gemini-stream-network[${Math.random().toString(36).slice(2, 8)}]`;
  console.time(networkLabel);
  let accumulated = '';
  let actualModelUsed: string = candidateModels[0];
  let modelAvailabilityErr: any = null;
  let succeeded = false;
  try {
    for (const candidateModel of candidateModels) {
      try {
        // Same 429 retry envelope as the non-streaming path. The stream
        // request itself is a single SDK call that returns an async
        // generator; transient quota errors typically surface on the
        // initial request, so retrying the whole stream is safe.
        const RETRY_DELAYS_MS = [1000, 2000, 4000];
        let attempt = 0;
        while (true) {
          try {
            accumulated = '';
            const parts: any[] = [
              { text: fullPrompt },
              { inlineData: { data: frontBuffer.toString('base64'), mimeType: frontMime } },
              { inlineData: { data: backBuffer.toString('base64'), mimeType: backMime } },
            ];
            if (isExemplarsEnabled()) {
              parts.push({ text: getExemplarTextPrefix() });
              parts.push(...getExemplarParts());
            }
            const stream = await client.models.generateContentStream({
              model: candidateModel,
              contents: [{ role: 'user', parts }],
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
            actualModelUsed = candidateModel;
            if (candidateModel !== candidateModels[0]) {
              console.warn(
                `[vlmGemini.stream] primary model "${candidateModels[0]}" unavailable; succeeded on fallback "${candidateModel}"`,
              );
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
            console.warn(
              `[vlmGemini.stream] 429/quota on attempt ${attempt} (model=${candidateModel}), retrying in ${delay}ms: ${message.slice(0, 200)}`,
            );
            await new Promise((r) => setTimeout(r, delay));
          }
        }
        succeeded = true;
        break; // success — stop the model fallback chain
      } catch (err: any) {
        if (!isModelAvailabilityError(err)) throw err;
        modelAvailabilityErr = err;
        console.warn(
          `[vlmGemini.stream] model "${candidateModel}" unavailable: ${String(err?.message ?? err).slice(0, 200)}`,
        );
        // continue to next candidate
      }
    }
    if (!succeeded) {
      throw modelAvailabilityErr ?? new Error('all candidate Gemini models failed');
    }
  } finally {
    console.timeEnd(networkLabel);
  }

  const result = finalizeGeminiText(accumulated);
  result.geminiModel = actualModelUsed;
  // QW-3 cache write — same gate as the non-streaming path.
  if (cacheKey) geminiCacheSet(cacheKey, result);
  return result;
}

export const VLM_INFO = {
  promptVersion: VLM_PROMPT_VERSION,
  primaryModel: VLM_PRIMARY_MODEL,
  fallbackModel: VLM_FALLBACK_MODEL,
};
