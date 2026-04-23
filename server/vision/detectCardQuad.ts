// Card quadrilateral detection via Anthropic Haiku.
//
// Given a (possibly cluttered) photo of a trading card, asks Haiku to return
// the 4 corner points of the card in the image, normalized to the 0..1 range.
// The client then uses those corners to perspective-warp the photo to a clean
// 2.5:3.5 rectangle before running it through the real analyze pipeline.
//
// Keep the prompt short — we want a cheap ~500-800ms call, not a reasoning
// pass. We only need 8 numbers back.

import Anthropic from "@anthropic-ai/sdk";

export type QuadPoint = { x: number; y: number };

export type CardQuad = {
  topLeft: QuadPoint;
  topRight: QuadPoint;
  bottomRight: QuadPoint;
  bottomLeft: QuadPoint;
};

export type DetectCardQuadResult =
  | { ok: true; quad: CardQuad; confidence: number; model: string; latencyMs: number }
  | { ok: false; reason: "not_configured" | "no_card_detected" | "parse_error" | "api_error"; latencyMs: number; detail?: string };

const MODEL = process.env.QUAD_MODEL ?? "claude-haiku-4-5";

const SYSTEM_PROMPT = `You are a precise image geometry tool. You will be shown a photograph that may contain a trading card. Your only job is to locate the 4 corners of the card in the image.

Return a single JSON object and nothing else, in this exact shape:
{
  "card_present": boolean,
  "confidence": number,            // 0..1
  "top_left":     {"x": number, "y": number},
  "top_right":    {"x": number, "y": number},
  "bottom_right": {"x": number, "y": number},
  "bottom_left":  {"x": number, "y": number}
}

Rules:
- All x and y values are NORMALIZED to the image: x in [0,1] from left edge, y in [0,1] from top edge.
- The four corners must describe the outer edge of the card itself — not the artwork inside, not a slab holder window, not the border of a photo frame. For raw (non-slab) cards, this is the card's physical edge.
- Order matters: top_left / top_right / bottom_right / bottom_left, as the card appears in the image (follow the card's orientation, not the image's — if the card is rotated, top_left is still the card's top-left corner).
- If no card is visible, set card_present=false, confidence=0, and return any placeholder corners.
- Output RAW JSON only. No prose, no markdown, no code fences.`;

// Parse a permissive JSON-looking string — strips code fences if Haiku ever
// adds them despite the system prompt.
function safeParse(text: string): any | null {
  const trimmed = text.trim();
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // Last-ditch: pull the first {...} block
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function coerceNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clampPoint(p: unknown): QuadPoint | null {
  if (!p || typeof p !== "object") return null;
  const x = coerceNum((p as any).x);
  const y = coerceNum((p as any).y);
  if (x === null || y === null) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

export async function detectCardQuad(
  base64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
): Promise<DetectCardQuadResult> {
  const started = Date.now();

  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, reason: "not_configured", latencyMs: Date.now() - started };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let raw: string;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
            },
            {
              type: "text",
              text: "Locate the trading card's 4 corners. Return JSON only.",
            },
          ],
        },
      ],
    });
    const block = response.content.find((c: any) => c.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    raw = block?.text ?? "";
  } catch (err: any) {
    return {
      ok: false,
      reason: "api_error",
      latencyMs: Date.now() - started,
      detail: err?.message ?? String(err),
    };
  }

  const parsed = safeParse(raw);
  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      reason: "parse_error",
      latencyMs: Date.now() - started,
      detail: raw.slice(0, 200),
    };
  }

  if (parsed.card_present === false) {
    return { ok: false, reason: "no_card_detected", latencyMs: Date.now() - started };
  }

  const tl = clampPoint(parsed.top_left);
  const tr = clampPoint(parsed.top_right);
  const br = clampPoint(parsed.bottom_right);
  const bl = clampPoint(parsed.bottom_left);

  if (!tl || !tr || !br || !bl) {
    return {
      ok: false,
      reason: "parse_error",
      latencyMs: Date.now() - started,
      detail: "missing corner",
    };
  }

  // Sanity check — corners should form a convex-ish quad that covers
  // some real area. Reject degenerate quads (< 5% of image area).
  const area =
    Math.abs(
      (tr.x - tl.x) * (bl.y - tl.y) - (bl.x - tl.x) * (tr.y - tl.y),
    ) +
    Math.abs(
      (br.x - tr.x) * (bl.y - tr.y) - (bl.x - tr.x) * (br.y - tr.y),
    );
  if (area < 0.05) {
    return { ok: false, reason: "no_card_detected", latencyMs: Date.now() - started };
  }

  const confidence = coerceNum(parsed.confidence) ?? 0.7;

  return {
    ok: true,
    quad: { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl },
    confidence,
    model: MODEL,
    latencyMs: Date.now() - started,
  };
}
