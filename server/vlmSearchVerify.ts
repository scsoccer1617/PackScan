/**
 * Standalone Gemini + Google-Search-grounding identification verifier.
 *
 * What this does
 * --------------
 * Given a card identification produced by the primary VLM pipeline
 * (`server/vlmGemini.ts` → `server/vlmApply.ts`), call Gemini one more
 * time with the `googleSearch` grounding tool enabled and ask it to
 * verify or correct the identification against TCDB / Beckett / COMC /
 * eBay sold listings / Cardboard Connection / The Trading Card Database.
 *
 * Why a separate module
 * ---------------------
 * Grounding adds ~1.5–3s of wall-clock latency per call. Burning that on
 * every scan would regress the median time-to-result; this verifier is
 * intended to fire only on weak cards (eBay zero-result, low Gemini
 * confidence, year/set conflict, etc.). Keeping it isolated lets PR-B
 * gate it behind `VLM_SEARCH_VERIFY_ENABLED` and call it from the
 * post-eBay-zero branch in the analyze handler — without touching the
 * primary pipeline at all.
 *
 * Cost / latency profile
 * ----------------------
 * - Input tokens: identification context (~150-300 tokens), no images.
 * - Search calls: 1-3 web searches per request, dynamically chosen by
 *   the model.
 * - Wall-clock: ~1.5-3s typical, up to ~6s on cold-cache misses.
 * - Cost: search-grounded responses are billed at the standard text
 *   token rate plus a per-search-call fee (Google publishes the rate
 *   on https://ai.google.dev/gemini-api/docs/grounding#pricing).
 *
 * Failure modes
 * -------------
 * - Grounding returns no useful sources: we return the input unchanged,
 *   `confidence: 'low'`, sources empty, reasoning explains the miss.
 * - Model emits unparseable text: we capture it in `rawResponse` and
 *   return `confidence: 'low'` with the input echoed back.
 * - SDK error / network failure: we throw — callers (PR-B) should
 *   catch and fall through to the un-verified identification.
 *
 * Structured output + grounding do not compose in the @google/genai SDK
 * (as of v1.x; setting `responseMimeType: 'application/json'` together
 * with `tools: [{ googleSearch: {} }]` is rejected by the API). We
 * therefore parse fenced JSON out of the model's text reply.
 *
 * @see https://ai.google.dev/gemini-api/docs/grounding
 */

import { GoogleGenAI } from '@google/genai';

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

// Re-uses the same model env vars as `vlmGemini.ts` so a project-wide
// model swap (e.g. `VLM_MODEL=gemini-3-flash-preview`) covers this
// module too without a second config knob.
const VERIFY_MODEL = process.env.VLM_SEARCH_VERIFY_MODEL
  || process.env.VLM_MODEL
  || 'gemini-3-flash-preview';

export interface SearchVerifyInput {
  player: string;
  year: number | string;
  brand: string;
  set?: string;
  cardNumber: string;
  subset?: string;
  sport?: string;
}

export interface SearchVerifyCorrection {
  field: 'player' | 'year' | 'brand' | 'set' | 'cardNumber';
  oldValue: string;
  newValue: string;
}

export interface SearchVerifyResult {
  player: string;
  year: number | string;
  brand: string;
  set: string;
  cardNumber: string;
  corrections: SearchVerifyCorrection[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  sources: string[];
  rawResponse?: string;
}

const VERIFY_PROMPT = `You are a baseball/basketball/football trading card identification verifier with access to Google Search. Given a card identification produced by another system, search the web (TCDB, Beckett, COMC, eBay sold listings, Cardboard Connection, Trading Card Database) to verify or correct it.

Common errors to look for:
1. Year off by one (very common for Upper Deck Minor League and similar products): the copyright year on the card may be the prior year while the actual product release year is one later. E.g., a card with "© 1994" in the copyright is often part of the 1995 Upper Deck Minor League product released early 1995. Cross-reference with TCDB/Beckett product listings.
2. Set name confusion: subset/insert names printed on the card (e.g., "Future Stock", "Top Prospect", "The Upper Deck Times", "Electric Moments") are NOT the set — the set is the product line (e.g., "Upper Deck Minor League", "Upper Deck Series 1"). If the input set is a known subset/insert, correct to the actual product line.
3. Card number mismatch: sometimes the front shows a serial number and the back shows the actual catalog number — they're different things.

Search guidance:
- Prefer queries that combine player name + year + brand + card number ("Pokey Reese 1995 Upper Deck Minor League 28").
- Cross-check at least two sources before applying a correction.
- If sources disagree, prefer TCDB and Beckett over auction-listing-only data.

Return ONLY a JSON object inside a fenced \`\`\`json code block, matching this schema exactly:

\`\`\`json
{
  "player": "...",
  "year": "...",
  "brand": "...",
  "set": "...",
  "cardNumber": "...",
  "corrections": [{"field": "year", "oldValue": "1994", "newValue": "1995"}],
  "confidence": "high|medium|low",
  "reasoning": "Brief explanation of what the search results showed.",
  "sources": ["url1", "url2"]
}
\`\`\`

Rules for the response:
- If the input is correct, echo it back with an empty corrections array and confidence "high".
- If you cannot verify (no useful search results, ambiguous), return the input unchanged with confidence "low" and reasoning explaining why.
- Only include a correction when you have a concrete source supporting the new value.
- The "field" in each correction must be one of: player, year, brand, set, cardNumber.
- "year" may be a number or a string ("1995" or 1995); preserve whichever shape the input used unless the correction itself is a year change.
- "sources" must be an array of plain URLs, no markdown.`;

function buildIdentificationBlock(input: SearchVerifyInput): string {
  const lines: string[] = [];
  lines.push(`Player: ${input.player}`);
  lines.push(`Year: ${input.year}`);
  lines.push(`Brand: ${input.brand}`);
  if (input.set) lines.push(`Set: ${input.set}`);
  lines.push(`Card number: ${input.cardNumber}`);
  if (input.subset) lines.push(`Subset (printed on card, NOT necessarily the set): ${input.subset}`);
  if (input.sport) lines.push(`Sport: ${input.sport}`);
  return lines.join('\n');
}

function extractFencedJson(text: string): string | null {
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return null;
}

function coerceCorrection(raw: any): SearchVerifyCorrection | null {
  if (!raw || typeof raw !== 'object') return null;
  const allowed = new Set(['player', 'year', 'brand', 'set', 'cardNumber']);
  const field = String(raw.field ?? '').trim();
  if (!allowed.has(field)) return null;
  return {
    field: field as SearchVerifyCorrection['field'],
    oldValue: String(raw.oldValue ?? ''),
    newValue: String(raw.newValue ?? ''),
  };
}

function coerceConfidence(raw: any): SearchVerifyResult['confidence'] {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  return 'low';
}

function fallbackResult(
  input: SearchVerifyInput,
  reasoning: string,
  rawResponse?: string,
): SearchVerifyResult {
  return {
    player: input.player,
    year: input.year,
    brand: input.brand,
    set: input.set ?? '',
    cardNumber: input.cardNumber,
    corrections: [],
    confidence: 'low',
    reasoning,
    sources: [],
    rawResponse,
  };
}

function extractSourcesFromGrounding(response: any): string[] {
  const out: string[] = [];
  const candidates = response?.candidates ?? [];
  for (const c of candidates) {
    const chunks = c?.groundingMetadata?.groundingChunks ?? [];
    for (const ch of chunks) {
      const uri = ch?.web?.uri;
      if (typeof uri === 'string' && uri && !out.includes(uri)) out.push(uri);
    }
  }
  return out;
}

/**
 * Verify a card identification against the live web via Gemini's
 * `googleSearch` grounding tool. Returns the (possibly corrected) fields,
 * a confidence rating, the model's reasoning, and the citation URLs the
 * search produced. Throws on SDK / network errors so the caller can
 * decide whether to fall through to the un-verified identification.
 */
export async function verifyIdentificationWithSearch(
  input: SearchVerifyInput,
): Promise<SearchVerifyResult> {
  const client = getClient();
  const userMessage = `${VERIFY_PROMPT}\n\nInput identification:\n${buildIdentificationBlock(input)}`;

  let response: any;
  try {
    response = await client.models.generateContent({
      model: VERIFY_MODEL,
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      config: {
        tools: [{ googleSearch: {} }],
      },
    });
  } catch (err: any) {
    throw new Error(
      `vlmSearchVerify: Gemini search-grounded call failed: ${String(err?.message ?? err).slice(0, 500)}`,
    );
  }

  const text = (response?.text ?? '').toString();
  const groundingSources = extractSourcesFromGrounding(response);

  if (!text.trim()) {
    return fallbackResult(input, 'Empty response from Gemini', text);
  }

  const jsonStr = extractFencedJson(text);
  if (!jsonStr) {
    const result = fallbackResult(input, 'Could not locate JSON in model response', text);
    if (groundingSources.length) result.sources = groundingSources;
    return result;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    const result = fallbackResult(
      input,
      `JSON parse failed: ${String((err as Error).message).slice(0, 200)}`,
      text,
    );
    if (groundingSources.length) result.sources = groundingSources;
    return result;
  }

  const corrections: SearchVerifyCorrection[] = Array.isArray(parsed.corrections)
    ? parsed.corrections.map(coerceCorrection).filter((c: SearchVerifyCorrection | null): c is SearchVerifyCorrection => c !== null)
    : [];

  const modelSources: string[] = Array.isArray(parsed.sources)
    ? parsed.sources.filter((s: any) => typeof s === 'string' && s.trim()).map((s: string) => s.trim())
    : [];
  // Prefer model-cited sources; fall back to raw grounding URIs if the
  // model omitted them. De-dupe while preserving order.
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const s of [...modelSources, ...groundingSources]) {
    if (!seen.has(s)) {
      seen.add(s);
      sources.push(s);
    }
  }

  return {
    player: typeof parsed.player === 'string' && parsed.player.trim() ? parsed.player.trim() : input.player,
    year: parsed.year != null && parsed.year !== '' ? parsed.year : input.year,
    brand: typeof parsed.brand === 'string' && parsed.brand.trim() ? parsed.brand.trim() : input.brand,
    set: typeof parsed.set === 'string' ? parsed.set.trim() : (input.set ?? ''),
    cardNumber: typeof parsed.cardNumber === 'string' && parsed.cardNumber.trim() ? parsed.cardNumber.trim() : input.cardNumber,
    corrections,
    confidence: coerceConfidence(parsed.confidence),
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.trim() : '',
    sources,
    rawResponse: text,
  };
}
