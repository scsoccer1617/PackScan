/**
 * Gemini call site for the GRADED-mode slab-label image. Lives separate from
 * `vlmGemini.ts` so the in-flight model-swap PR (feat/vlm-gemini-3-flash) can
 * land cleanly without conflicting on this file. Uses the same @google/genai
 * SDK + GEMINI_API_KEY env var the card analyzer uses.
 *
 * The GRADED scan uploads two images to /api/analyze-card-dual-images:
 *   1. The card body (front), analyzed by the existing card pipeline.
 *   2. The slab label strip, analyzed here against VLM_GRADING_LABEL_PROMPT.
 * Cross-validation between the two reads happens in routes.ts after both
 * resolve.
 */

import { GoogleGenAI } from '@google/genai';
import {
  VLM_GRADING_LABEL_PROMPT,
  normalizeGradingLabel,
  type GradingLabelResult,
} from './vlmGradingPrompt';

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

/**
 * Analyse a slab-label image with Gemini and return the normalized label
 * result. Throws on network / auth errors so the caller can fall back to a
 * RAW-style scan. Failure here should NOT block the broader scan response;
 * the route handler logs and continues with `isGraded=false`.
 */
export async function analyzeGradingLabelWithGemini(
  labelBuffer: Buffer,
  opts: { mime?: string; model?: string } = {},
): Promise<GradingLabelResult> {
  const client = getClient();
  const model = opts.model || 'gemini-2.5-flash';
  const mime = opts.mime || 'image/jpeg';

  const parts: any[] = [
    { text: VLM_GRADING_LABEL_PROMPT },
    { inlineData: { data: labelBuffer.toString('base64'), mimeType: mime } },
  ];

  const response = await client.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: { responseMimeType: 'application/json' },
  });

  const text = (response as any).text ?? '';
  if (!text || !text.trim()) {
    throw new Error('Gemini returned empty grading-label response');
  }
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err: any) {
    throw new Error(
      `Gemini grading-label JSON parse error: ${err.message}. First 200 chars: ${cleaned.slice(0, 200)}`,
    );
  }
  return normalizeGradingLabel(parsed);
}
