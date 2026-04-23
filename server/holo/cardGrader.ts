/**
 * Holo — AI condition grader.
 *
 * A single Claude-vision call returns a PSA-style grade: four sub-grades
 * (centering / corners / edges / surface) + overall + label + confidence.
 *
 * Card IDENTIFICATION is intentionally NOT part of this call anymore.
 * Google Vision OCR + the local card database + SCP's catalog own
 * identification end-to-end. Holo focuses on one thing: grading pixels.
 *
 * History: Holo used to do identification too, but Sonnet hallucinated
 * parallels that didn't exist for the set (e.g. "Pink Speckle Refractor"
 * on a Topps flagship card that has no refractors). Those hallucinations
 * overwrote OCR's correct `parallelSuspected=true` signal and blocked
 * the parallel picker. Dropping identification from the prompt also
 * shrinks the call from ~1600 output tokens to ~400, which in practice
 * halves latency.
 *
 * Credentials: requires the `ANTHROPIC_API_KEY` environment variable.
 * When it is missing, callers receive a `HoloNotConfiguredError` so the
 * rest of the scan pipeline keeps working.
 */

import Anthropic from "@anthropic-ai/sdk";

const HOLO_MODEL = process.env.HOLO_MODEL || "claude-sonnet-4-5";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HoloSubGrade = { score: number; notes: string };

/**
 * Retained for backward compatibility with the `scan_grades.identification`
 * JSONB column. Existing rows may still hold identification data; new rows
 * write `null` here. The type exists only so storage.ts and any migration
 * scripts can still describe the column shape.
 */
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

/**
 * Shape returned by `analyzeCard`. `identification` is always `null` now —
 * kept in the shape so callers that destructure it don't break, and so
 * the field can be re-populated in the future without another contract
 * change if we ever reintroduce AI-based identification.
 */
export type HoloAnalysis = {
  identification: null;
  grade: HoloGrade;
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert trading card grader. Your ONLY job is to apply PSA's 10-point grading scale (half-grade increments) to the card image(s) you are given.

Do NOT identify the player, brand, set, year, card number, serial number, parallel, variant, or CMP code — another system handles identification. Ignore those fields entirely.

Produce four sub-grades from the photo(s):
  • CENTERING — front L/R and T/B borders. 50/50 is perfect. >65/35 drops meaningfully. If a back image is provided, ALSO produce a separate centering_back score (back centering tolerance is looser — 75/25 is still NM).
  • CORNERS — sharpness across all four corners on both sides. Any whitening, fuzz, or blunting matters.
  • EDGES — chipping, whitening, roughness along the four edges of front and back.
  • SURFACE — print lines, scratches, indents, stains, print dots, focus, gloss on both sides if back provided.

Then compute an OVERALL GRADE (1-10, half-steps allowed) that respects the lowest sub-grade — a 10 requires all sub-grades essentially flawless. Map overall to the PSA label:
  10 = GEM MT, 9 = MINT, 8 = NM-MT, 7 = NM, 6 = EX-MT, 5 = EX, 4 = VG-EX, 3 = VG, 2 = GOOD, 1 = POOR.

GUARDRAILS:
- If an image is blurry, off-angle, or not a trading card, lower confidence and explain in notes — never invent grades.
- If only a front image is provided, set centering_back to null and acknowledge in grade notes that back-side was not assessed (lower grade confidence accordingly).
- Cards sometimes arrive in one-touch or snap holders — surface assessment is limited by reflections/plastic; mention this in grade notes when relevant.

OUTPUT FORMAT — respond with ONLY this JSON object, no prose before or after:

{
  "centering":      { "score": 0.0, "notes": "1 short sentence (front centering)" },
  "centering_back": { "score": 0.0, "notes": "1 short sentence" } OR null,
  "corners":        { "score": 0.0, "notes": "1 short sentence" },
  "edges":          { "score": 0.0, "notes": "1 short sentence" },
  "surface":        { "score": 0.0, "notes": "1 short sentence" },
  "overall":        0.0,
  "label":          "GEM MT 10 | MINT 9 | NM-MT 8 | NM 7 | EX-MT 6 | EX 5 | VG-EX 4 | VG 3 | GOOD 2 | POOR 1",
  "notes":          ["up to 3 short bullet takeaways, plain sentences"],
  "confidence":     0.0
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
 * Analyze a card from one or two images. Returns a condition grade.
 * `identification` is always null — OCR / local DB / SCP own that path.
 * Throws `HoloNotConfiguredError` when the API key is missing.
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
      ? "First image is the FRONT of the card. Second image is the BACK — use it to evaluate back centering, edges, surface, and corners."
      : "Single image is the FRONT of the card. No back image provided — set centering_back to null and lower confidence accordingly.",
  });

  const response = await client.messages.create({
    model: HOLO_MODEL,
    max_tokens: 600,
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
    identification: null,
    grade: normalizeGrade(parsed, !back),
  };
}

/**
 * Back-compat shim. The grading-only call still works.
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

function clampConfidence(n: any, fallback = 0.5): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
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
