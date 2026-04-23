/**
 * Holo — unified AI card analyzer.
 *
 * A single Claude-vision call returns BOTH:
 *   1. Identification — player, brand, set, collection, year, card number,
 *      serial, parallel, variant, CMP code, sport, confidence.
 *   2. Condition grade — PSA-style sub-grades + overall + label + confidence.
 *
 * This replaces the previous grade-only flow. Doing identification and grading
 * in one call halves per-scan API cost compared with two round-trips and keeps
 * latency flat because we were already making this Claude call for grading.
 *
 * The model is instructed to emit strict JSON and to be honest about
 * uncertainty — callers inspect `identification.confidence` to decide whether
 * to trust Claude or fall back to PackScan's existing OCR pipeline.
 *
 * Credentials: requires the `ANTHROPIC_API_KEY` environment variable. When it
 * is missing, callers receive a `HoloNotConfiguredError` so Holo can degrade
 * gracefully without blocking the rest of the scan pipeline.
 */

import Anthropic from "@anthropic-ai/sdk";

const HOLO_MODEL = process.env.HOLO_MODEL || "claude-sonnet-4-5";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HoloSubGrade = { score: number; notes: string };

export type HoloIdentification = {
  player: string;
  brand: string | null;
  setName: string;
  collection: string | null;
  year: string;
  cardNumber: string | null;
  serialNumber: string | null;
  parallel: string | null;
  variant: string | null;
  cmpCode: string | null;
  sport: string;
  /** 0.0–1.0 match confidence. Callers use this to gate fallbacks. */
  confidence: number;
};

export type HoloGrade = {
  centering: HoloSubGrade;
  centeringBack: HoloSubGrade | null;
  corners: HoloSubGrade;
  edges: HoloSubGrade;
  surface: HoloSubGrade;
  overall: number;
  label: string;
  notes: string[];
  confidence: number;
  model: string;
  /** True when only a front image was provided. */
  frontOnly: boolean;
};

export type HoloAnalysis = {
  identification: HoloIdentification;
  grade: HoloGrade;
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert trading card specialist combining TWO roles:

1. CARD IDENTIFICATION — You recognize sports cards (baseball, basketball, football, hockey, soccer) and TCGs (Pokémon, Magic, Yu-Gi-Oh). Extract as many of these fields as you can read:
   • player — player or character name
   • brand — manufacturer (Topps, Panini, Upper Deck, Bowman, Fleer, Donruss, Leaf, Wizards of the Coast, The Pokémon Company, etc.)
   • set_name — the product line, NOT the brand. Read the large wordmark on the card front and/or the "<YEAR> <BRAND> - <PRODUCT> <SPORT>" line on the card back. Examples: "Origins", "Contenders", "Select", "Immaculate", "Chronicles", "Prizm", "Mosaic", "Optic", "Obsidian", "Chrome", "Heritage", "Stadium Club", "Bowman Draft", "Bowman Chrome", "SP Authentic", "Young Guns", "Base Set" (Pokémon). If you can clearly read a large wordmark on the front (ORIGINS, CONTENDERS, SELECT, IMMACULATE, etc.), that wordmark IS the set_name — do NOT substitute the brand's most common product line ("Prizm" for Panini, "Chrome" for Topps) when the wordmark says something different.
   • collection — the sub-collection or insert line inside the set if one is branded on the card (e.g. "Stadium Club", "Select Premier", "Gold Label", "Legends of the Game", "Rookies & Stars") — null if just base
   • year — season/year printed or strongly inferable (e.g. "1986", "2023-24")
   • card_number — the printed card number (e.g. "57", "BDC-12", "RC-45")
   • serial_number — hand-numbered print count if visible (e.g. "12/99", "1/1", "57/150") — null if unnumbered
   • parallel — the parallel/finish (e.g. "Refractor", "Gold Prizm", "Silver Wave", "Shadowless", "Reverse Holo") — null if base
   • variant — the variation (e.g. "Base", "SP", "SSP", "Image Variation", "Photo Variation", "Rookie", "Error") — null if nothing distinguishes it from base
   • cmp_code — the small Card Manufacturing Plant code printed in the fine print on the BACK of many modern cards (Topps, Bowman, Panini — usually a multi-digit number like "053", "075", "329", "587"). null if not visible or back not provided.
   • sport — one of: baseball, basketball, football, hockey, soccer, pokemon, magic, yugioh, other
   • confidence — 0..1 confidence in the overall identification (be honest; low confidence is always acceptable)

   How to use CMP code: CMP codes often distinguish base vs variants in modern Topps/Bowman cards — the last 3 digits typically shift between base and short-print/variation/SSP versions of the same card number. If a CMP code is visible AND you recognize it as a variant signature, reflect that in the variant field (e.g. "Image Variation", "Golden Mirror SP"). If you are not sure, keep variant conservative and just record the CMP code faithfully. Never fabricate a CMP code.

2. CONDITION GRADING — You apply PSA's 10-point scale with half-grade increments. Produce four sub-grades from the photo(s):
   • CENTERING — front L/R and T/B borders. 50/50 is perfect. >65/35 front drops meaningfully. If a back image is provided, ALSO produce a separate centering_back score (back centering tolerance is looser — 75/25 is still NM).
   • CORNERS — sharpness across all four corners on both sides. Any whitening, fuzz, or blunting matters.
   • EDGES — chipping, whitening, roughness along the four edges of front and back.
   • SURFACE — print lines, scratches, indents, stains, print dots, focus, gloss on both sides if back provided.
   Then compute an OVERALL GRADE (1-10, half-steps allowed) that respects the lowest sub-grade — a 10 requires all sub-grades essentially flawless. Map overall to the PSA label:
   10 = GEM MT, 9 = MINT, 8 = NM-MT, 7 = NM, 6 = EX-MT, 5 = EX, 4 = VG-EX, 3 = VG, 2 = GOOD, 1 = POOR.

GUARDRAILS:
- If an image is blurry, off-angle, or not a trading card, lower confidence and explain in notes — never invent fields or grades.
- Never fabricate a specific serial number, CMP code, card number, or set name. null is always acceptable.
- If only a front image is provided, set centering_back to null and acknowledge in grade notes that back-side was not assessed (lower grade confidence accordingly).
- Cards sometimes arrive in one-touch or snap holders — surface assessment is limited by reflections/plastic; mention this in grade notes when relevant.

OUTPUT FORMAT — respond with ONLY this JSON object, no prose before or after:

{
  "identification": {
    "player": "string",
    "brand": "string or null",
    "set_name": "string",
    "collection": "string or null",
    "year": "string",
    "card_number": "string or null",
    "serial_number": "string or null",
    "parallel": "string or null",
    "variant": "string or null",
    "cmp_code": "string or null",
    "sport": "baseball | basketball | football | hockey | soccer | pokemon | magic | yugioh | other",
    "confidence": 0.0
  },
  "grade": {
    "centering":      { "score": 0.0, "notes": "1 short sentence (front centering)" },
    "centering_back": { "score": 0.0, "notes": "1 short sentence" } OR null,
    "corners":        { "score": 0.0, "notes": "1 short sentence" },
    "edges":          { "score": 0.0, "notes": "1 short sentence" },
    "surface":        { "score": 0.0, "notes": "1 short sentence" },
    "overall":        0.0,
    "label":          "GEM MT 10 | MINT 9 | NM-MT 8 | NM 7 | EX-MT 6 | EX 5 | VG-EX 4 | VG 3 | GOOD 2 | POOR 1",
    "notes":          ["up to 3 short bullet takeaways, plain sentences"],
    "confidence":     0.0
  }
}`;

// ---------------------------------------------------------------------------
// Claude client + errors
// ---------------------------------------------------------------------------

type ImageInput = {
  base64: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
};

export class HoloNotConfiguredError extends Error {
  code = "not_configured" as const;
  constructor() {
    super("ANTHROPIC_API_KEY is not set; Holo is disabled.");
  }
}

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new HoloNotConfiguredError();
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a card from one or two images. Returns identification + grade in a
 * single Claude call. Throws `HoloNotConfiguredError` when the API key is
 * missing — callers should catch and treat Holo as optional.
 */
export async function analyzeCard(
  front: ImageInput,
  back?: ImageInput,
): Promise<HoloAnalysis> {
  const client = getClient();

  const content: any[] = [
    {
      type: "image",
      source: { type: "base64", media_type: front.mediaType, data: front.base64 },
    },
  ];
  if (back) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: back.mediaType, data: back.base64 },
    });
  }
  content.push({
    type: "text",
    text: back
      ? "First image is the FRONT of the card. Second image is the BACK — use it to read CMP code, serial number, and any set/parallel/collection branding printed on the back, and to evaluate back centering, edges, surface, and corners."
      : "Single image is the FRONT of the card. No back image provided — set centering_back to null, leave CMP code null, and lower confidence on back-only fields (CMP code, serial number if back-printed).",
  });

  const response = await client.messages.create({
    model: HOLO_MODEL,
    max_tokens: 1600,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Holo: empty model response");
  }

  const raw = textBlock.text.trim();
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) {
      parsed = JSON.parse(cleaned.slice(first, last + 1));
    } else {
      throw new Error("Holo: model did not return valid JSON");
    }
  }

  return {
    identification: normalizeIdentification(parsed?.identification),
    grade: normalizeGrade(parsed?.grade, !back),
  };
}

/**
 * Back-compat shim. The grading-only call still works and internally uses the
 * unified analyzer. Callers that only need the grade can keep calling this.
 */
export async function gradeCard(
  front: ImageInput,
  back?: ImageInput,
): Promise<HoloGrade> {
  const { grade } = await analyzeCard(front, back);
  return grade;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function clampGrade(n: any): number {
  const v = Number(n);
  if (Number.isFinite(v)) return Math.max(1, Math.min(10, Math.round(v * 2) / 2));
  return 5;
}

function sub(s: any): HoloSubGrade {
  return {
    score: clampGrade(s?.score),
    notes: String(s?.notes ?? "").slice(0, 240),
  };
}

function subOrNull(s: any): HoloSubGrade | null {
  if (s === null || s === undefined) return null;
  if (typeof s !== "object") return null;
  if (s.score === null || s.score === undefined) return null;
  return sub(s);
}

function strOrNull(v: any, max: number): string | null {
  return v === null || v === undefined || v === "" ? null : String(v).slice(0, max);
}

function clampConfidence(n: any, fallback = 0.5): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}

function normalizeIdentification(a: any): HoloIdentification {
  const sport = String(a?.sport ?? "other").toLowerCase();
  return {
    player: String(a?.player ?? "Unknown Card").slice(0, 120),
    brand: strOrNull(a?.brand, 60),
    setName: String(a?.set_name ?? "Unknown Set").slice(0, 120),
    collection: strOrNull(a?.collection, 80),
    year: String(a?.year ?? "Unknown").slice(0, 20),
    cardNumber: strOrNull(a?.card_number, 40),
    serialNumber: strOrNull(a?.serial_number, 40),
    parallel: strOrNull(a?.parallel, 60),
    variant: strOrNull(a?.variant, 60),
    cmpCode: strOrNull(a?.cmp_code, 20),
    sport,
    confidence: clampConfidence(a?.confidence, 0.5),
  };
}

function normalizeGrade(a: any, frontOnly: boolean): HoloGrade {
  return {
    centering: sub(a?.centering),
    centeringBack: frontOnly ? null : subOrNull(a?.centering_back),
    corners: sub(a?.corners),
    edges: sub(a?.edges),
    surface: sub(a?.surface),
    overall: clampGrade(a?.overall),
    label: String(a?.label ?? "NM 7").slice(0, 20),
    notes: Array.isArray(a?.notes)
      ? a.notes.slice(0, 3).map((n: any) => String(n).slice(0, 240))
      : [],
    confidence: clampConfidence(a?.confidence, 0.7),
    model: HOLO_MODEL,
    frontOnly,
  };
}

/**
 * Tone bucket for sub-grade colouring in UI. Kept server-side so the shape is
 * part of the public Holo response contract.
 */
export function gradeTone(score: number): "gold" | "cyan" | "green" | "amber" | "red" {
  if (score >= 9.5) return "gold";
  if (score >= 9) return "cyan";
  if (score >= 8) return "green";
  if (score >= 6) return "amber";
  return "red";
}

// ---------------------------------------------------------------------------
// Field mapping — Claude identification → PackScan cardData shape
// ---------------------------------------------------------------------------

/**
 * Map Holo's identification output to PackScan's expected cardData shape so
 * the existing scan UI, eBay lookup, edit form, and Google Sheets export all
 * work without modification. Conservative: only fills fields that are
 * confidently extracted.
 */
export function identificationToCardData(id: HoloIdentification): Record<string, any> {
  const { first, last } = splitPlayerName(id.player);
  const yearNum = parseYear(id.year);

  // PackScan treats "variant" as printed card variations (SP/SSP/image-var).
  // Parallels (refractor, gold prizm, silver, etc.) live on foilType.
  const parallelIsFoil = id.parallel && id.parallel.toLowerCase() !== "base";

  // Pass set_name through to cardData.set. Previously only `collection` was
  // mapped, which meant the product line Holo identified (e.g. "Origins",
  // "Contenders") was discarded. Downstream DB lookup and eBay query building
  // both read cardData.set, so without this mapping Holo could read the
  // correct set off the card and it would still get lost.
  // Normalize away meaningless placeholders ("Unknown Set", empty string).
  const setRaw = (id.setName || "").trim();
  const setPlaceholder = !setRaw || /^unknown(\s+set)?$/i.test(setRaw);
  return {
    sport: id.sport || "other",
    playerFirstName: first,
    playerLastName: last,
    brand: id.brand ?? "",
    set: setPlaceholder ? undefined : setRaw,
    collection: id.collection ?? undefined,
    cardNumber: id.cardNumber ?? "",
    year: yearNum,
    variant: id.variant ?? undefined,
    serialNumber: id.serialNumber ?? undefined,
    cmpNumber: id.cmpCode ?? undefined,
    foilType: parallelIsFoil ? id.parallel : null,
    isFoil: !!parallelIsFoil,
    isNumbered: !!id.serialNumber,
    _engine: "holo" as any,
  };
}

function splitPlayerName(full: string): { first: string; last: string } {
  const trimmed = (full || "").trim();
  if (!trimmed) return { first: "Unknown", last: "Card" };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  const first = parts[0];
  const last = parts.slice(1).join(" ");
  return { first, last };
}

function parseYear(raw: string): number {
  if (!raw) return new Date().getFullYear();
  const m = String(raw).match(/(\d{4})/);
  if (m) {
    const y = parseInt(m[1], 10);
    if (Number.isFinite(y) && y >= 1900 && y <= new Date().getFullYear() + 1) {
      return y;
    }
  }
  return new Date().getFullYear();
}
