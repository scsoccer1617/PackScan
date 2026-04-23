/**
 * Voice Lookup — Gemini-powered transcription + structured extraction.
 *
 * Takes a short audio clip from the user describing a card ("2025 Topps
 * Series One Nolan Arenado card number 193 pink green polka dots") and
 * returns a structured `ExtractedCardFields` object plus the raw
 * transcript. The caller (routes.ts /api/voice-lookup/extract) shows the
 * fields in a confirm sheet; on confirm it runs the existing SCP + eBay
 * pipelines with the confirmed fields.
 *
 * Single-call architecture: Gemini 2.5 Flash accepts audio natively and
 * returns JSON via responseSchema, so we don't need a separate Whisper
 * step. Safer, cheaper, one vendor.
 *
 * The module NEVER throws — callers get a discriminated result with a
 * `reason` string on failure, matching the defensive pattern in
 * sportscardspro/index.ts.
 */

import { GoogleGenAI, Type } from "@google/genai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedCardFields {
  /** "Baseball" | "Basketball" | etc — defaults to null if user didn't say */
  sport: string | null;
  /** Spoken year, e.g. 2025. Null if unclear. */
  year: number | null;
  /** Brand: "Topps", "Panini", "Upper Deck", etc. Capitalized. */
  brand: string | null;
  /** Product line / collection: "Series One", "Chrome", "Prizm", "Holiday". */
  collection: string | null;
  /** Sub-set like "Stars of MLB" — most users won't say this, fine to be null. */
  setName: string | null;
  /** Player full name as spoken, trimmed. */
  playerName: string | null;
  /** Card number as a string (may include prefixes like "RC-3" or "AA-11"). */
  cardNumber: string | null;
  /** Parallel / variant description — "Gold", "Refractor", "Pink Green Polka Dots". */
  parallel: string | null;
  /** Serial number if the user said one, e.g. "12/99". */
  serialNumber: string | null;
  /** Anything else the user described that didn't fit the above fields. */
  notes: string | null;
}

export type VoiceExtractResult =
  | {
      status: "ok";
      transcript: string;
      fields: ExtractedCardFields;
    }
  | {
      status: "error";
      reason:
        | "not_configured"
        | "audio_too_short"
        | "audio_invalid"
        | "no_speech"
        | "api_error";
      message: string;
    };

// ---------------------------------------------------------------------------
// Gemini client (lazy — so missing env var doesn't crash server boot)
// ---------------------------------------------------------------------------

let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI | null {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

export function isVoiceLookupConfigured(): boolean {
  return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

// ---------------------------------------------------------------------------
// Gemini structured output schema
// ---------------------------------------------------------------------------

const EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    transcript: {
      type: Type.STRING,
      description: "Verbatim transcription of everything the user said.",
    },
    sport: {
      type: Type.STRING,
      description:
        "Sport: Baseball, Basketball, Football, Hockey, Soccer, Pokemon, or empty string if unclear.",
    },
    year: {
      type: Type.INTEGER,
      description:
        "Card year as a 4-digit integer. 0 if not mentioned.",
    },
    brand: {
      type: Type.STRING,
      description:
        "Brand name (Topps, Panini, Upper Deck, Bowman, Donruss, Fleer, Score, etc.). Empty string if not mentioned.",
    },
    collection: {
      type: Type.STRING,
      description:
        "Product line / set: 'Series One', 'Series Two', 'Chrome', 'Update', 'Holiday', 'Heritage', 'Prizm', 'Select', 'Optic', 'Obsidian', etc. Empty string if not mentioned. Normalize 'Series 1' to 'Series One'.",
    },
    setName: {
      type: Type.STRING,
      description:
        "Sub-set or insert name like 'Stars of MLB' or '1989 All-Stars'. Most users won't say this — empty string is fine.",
    },
    playerName: {
      type: Type.STRING,
      description:
        "Full player name in Title Case: 'Nolan Arenado', 'Shohei Ohtani'. Empty string if not mentioned.",
    },
    cardNumber: {
      type: Type.STRING,
      description:
        "Card number as a string. May be purely numeric ('193') or prefixed ('RC-3', 'AA-11', 'H1'). Empty string if not mentioned.",
    },
    parallel: {
      type: Type.STRING,
      description:
        "Parallel / variant description in a short Title Case phrase. Keep descriptive color/pattern words the user said: 'Gold', 'Refractor', 'Pink Green Polka Dots', 'Rainbow Foil', 'Silver Prizm'. Empty string if not mentioned.",
    },
    serialNumber: {
      type: Type.STRING,
      description:
        "Numbered serial like '12/99' or '/25'. Empty string if not mentioned.",
    },
    notes: {
      type: Type.STRING,
      description:
        "Anything else the user said that didn't fit the above fields. Empty string if nothing.",
    },
  },
  required: [
    "transcript",
    "sport",
    "year",
    "brand",
    "collection",
    "setName",
    "playerName",
    "cardNumber",
    "parallel",
    "serialNumber",
    "notes",
  ],
  propertyOrdering: [
    "transcript",
    "sport",
    "year",
    "brand",
    "collection",
    "setName",
    "playerName",
    "cardNumber",
    "parallel",
    "serialNumber",
    "notes",
  ],
} as const;

const SYSTEM_INSTRUCTION = `You transcribe a sports card collector's spoken description of a single trading card, then extract the identifying fields.

Examples of typical descriptions:
- "2025 Topps Series One Nolan Arenado card number 193 pink green polka dots"
- "2024 Bowman Chrome Paul Skenes RC-20 refractor"
- "1989 Upper Deck Ken Griffey Jr rookie number 1"
- "2023 Panini Prizm basketball Victor Wembanyama silver prizm rookie card"

Rules:
- Preserve any spoken color/pattern words for the parallel field — if the user says "pink green polka dots" that IS the parallel description, even if it doesn't match a catalog name.
- For card numbers, spell out the prefix: "RC dash 20" → "RC-20", "H 1" → "H1".
- If the user says "rookie" or "RC", note it in the notes field; don't invent a card number from it.
- If the user mumbles through a year (e.g. "twenty twenty five"), convert to 4-digit integer 2025.
- Use empty string "" for string fields you can't identify. Use 0 for year if not mentioned.
- DO NOT hallucinate fields the user didn't say. An empty string is always better than a guess.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transcribe + extract card fields from an audio buffer.
 *
 * @param audioBuffer Raw audio bytes (webm/mp4/wav/ogg all supported by Gemini)
 * @param mimeType    IANA type from multer — "audio/webm", "audio/mp4", etc.
 */
export async function extractCardFromAudio(
  audioBuffer: Buffer,
  mimeType: string,
): Promise<VoiceExtractResult> {
  const client = getClient();
  if (!client) {
    return {
      status: "error",
      reason: "not_configured",
      message:
        "Voice lookup is not configured. Set GEMINI_API_KEY in the server environment.",
    };
  }

  // Sanity-check the clip — Gemini will happily process 100-byte noise clips
  // and return garbage. Require at least ~1KB of audio (very conservative).
  if (audioBuffer.byteLength < 1024) {
    return {
      status: "error",
      reason: "audio_too_short",
      message: "Audio clip is too short. Try again and speak for a second or two.",
    };
  }

  // Only accept actual audio mimetypes — a UI bug that uploads an image here
  // would otherwise hit Gemini with confusing billable input.
  if (!mimeType.startsWith("audio/")) {
    return {
      status: "error",
      reason: "audio_invalid",
      message: `Unexpected content type: ${mimeType}`,
    };
  }

  try {
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: EXTRACTION_SCHEMA as any,
        // Deterministic extraction — this is a parsing task, not creative.
        temperature: 0,
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType,
                data: audioBuffer.toString("base64"),
              },
            },
            {
              text:
                "Transcribe this audio verbatim, then extract the trading card identifying fields per your system instructions. Return JSON only.",
            },
          ],
        },
      ],
    });

    const text = response.text;
    if (!text) {
      return {
        status: "error",
        reason: "api_error",
        message: "Gemini returned an empty response.",
      };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      console.warn("[voiceLookup] JSON parse failed; raw response:", text.slice(0, 500));
      return {
        status: "error",
        reason: "api_error",
        message: "Could not parse Gemini response as JSON.",
      };
    }

    const transcript = typeof parsed.transcript === "string" ? parsed.transcript.trim() : "";
    if (!transcript) {
      return {
        status: "error",
        reason: "no_speech",
        message: "We couldn't hear any speech in that recording. Try again.",
      };
    }

    const fields: ExtractedCardFields = {
      sport: nonEmpty(parsed.sport),
      year: typeof parsed.year === "number" && parsed.year >= 1900 ? parsed.year : null,
      brand: nonEmpty(parsed.brand),
      collection: nonEmpty(parsed.collection),
      setName: nonEmpty(parsed.setName),
      playerName: nonEmpty(parsed.playerName),
      cardNumber: nonEmpty(parsed.cardNumber),
      parallel: nonEmpty(parsed.parallel),
      serialNumber: nonEmpty(parsed.serialNumber),
      notes: nonEmpty(parsed.notes),
    };

    return { status: "ok", transcript, fields };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[voiceLookup] Gemini call failed:", message);
    return {
      status: "error",
      reason: "api_error",
      message: "Voice lookup failed. Please try again.",
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Split a spoken "First Last" into first/last, preserving suffixes (Jr, Sr,
 * III) with the last-name chunk so CardFormValues fields line up with what
 * eBay / SCP expect downstream.
 */
export function splitPlayerName(
  playerName: string | null,
): { firstName: string; lastName: string } {
  if (!playerName) return { firstName: "", lastName: "" };
  const tokens = playerName.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { firstName: "", lastName: "" };
  if (tokens.length === 1) return { firstName: tokens[0], lastName: "" };

  // Generational suffix attaches to the last name.
  const suffixRe = /^(jr|sr|ii|iii|iv|v)\.?$/i;
  const lastToken = tokens[tokens.length - 1];
  if (suffixRe.test(lastToken) && tokens.length >= 3) {
    return {
      firstName: tokens[0],
      lastName: `${tokens[tokens.length - 2]} ${lastToken}`,
    };
  }
  // Middle tokens collapse into the last name so SCP still gets the full
  // spoken name; eBay has its own stripMiddleNames pass that handles this.
  return {
    firstName: tokens[0],
    lastName: tokens.slice(1).join(" "),
  };
}
