/**
 * VLM prompts and result-template scaffolding for the Holo scanning engine.
 *
 * Versioned here so we can iterate on prompt copy without touching the SDK
 * call site in vlmGemini.ts. When the prompt changes meaningfully, bump
 * VLM_PROMPT_VERSION so logged outputs can be traced back to the exact
 * instructions Gemini was given.
 */

export const VLM_PROMPT_VERSION = '2026-04-27.1';

/**
 * System prompt: tells the VLM what role it plays and the card-domain
 * conventions it must respect. Kept under 200 words by design — short
 * prompts are easier to iterate on and cheaper per call.
 */
export const VLM_SYSTEM_PROMPT = `You are the vision model behind Holo, the scanning engine inside PackScan.
On every image pair (front + back), identify whether the subject is a single trading card or sealed product (pack, blaster, hanger, box), then extract structured metadata.

Card-domain rules you MUST follow:
- For NBA/NHL season spans like "2024-25", return the season-START year (2024) in the year field. Preserve the printed string in yearPrintedRaw.
- Never confuse the trailing "-YY" of a season span for a card number.
- "Base" is a valid parallel name when no foil/colour treatment is detected. Do not return empty string for parallel.
- Judge parallel by visible border tint and saturation, not just printed text.
- If a field is unreadable, return null. Never guess.
- Return ONLY valid JSON matching the provided template. No prose, no markdown fences.`;

/**
 * Result template: shown to the model alongside the system prompt so it
 * knows exactly which keys to populate. Strings are placeholders; the
 * model fills them in with extracted values (or null).
 */
export const VLM_RESULT_TEMPLATE = `{
  "subjectType": "card",
  "sport": null,
  "player": null,
  "year": null,
  "yearPrintedRaw": null,
  "brand": null,
  "set": null,
  "cardNumber": null,
  "parallel": {
    "name": null,
    "isFoil": false,
    "isRefractor": false,
    "borderTint": null,
    "saturation": null
  },
  "isAutograph": false,
  "isRelic": false,
  "isRookie": false,
  "printRun": null,
  "team": null,
  "position": null,
  "confidence": {
    "player": null,
    "year": null,
    "set": null,
    "cardNumber": null,
    "parallel": null
  },
  "notes": null
}`;

export const VLM_FULL_PROMPT = `${VLM_SYSTEM_PROMPT}

Return JSON matching this template (replace nulls with extracted values, keep all keys):
${VLM_RESULT_TEMPLATE}`;
