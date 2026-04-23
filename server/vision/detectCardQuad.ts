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

const SYSTEM_PROMPT = `You are a precise image geometry tool. You will be shown a photograph that may contain a trading card. Your only job is to locate the 4 outer corners of the card's physical rectangle in the image.

Return a single JSON object and nothing else, in this exact shape:
{
  "card_present": boolean,
  "confidence": number,            // 0..1
  "top_left":     {"x": number, "y": number},
  "top_right":    {"x": number, "y": number},
  "bottom_right": {"x": number, "y": number},
  "bottom_left":  {"x": number, "y": number}
}

Rules for locating the corners:
- All x and y values are NORMALIZED to the image: x in [0,1] from left edge, y in [0,1] from top edge.
- The four corners describe the OUTER physical edge of the card — the paper boundary. Modern trading cards often have full-bleed artwork, colored borders, holographic patterns (Sandglitter, Tinsel, Rainbow Foil, polka dots, etc.), or foil backgrounds that extend all the way to the physical edge. The corners are the corners of the card's rectangular paper stock, EVEN WHEN the design pattern goes right up to the edge.
- DO NOT clip at the inner artwork, the player image, the nameplate, or any internal design element. The card's title text, player name, and team logos are usually several millimeters INSIDE the actual edge — your corners should be outside all of those.
- Look for the transition between the card and whatever is behind it (a hand, a table, a surface). That transition is the edge.
- If a corner is uncertain, err on the side of INCLUDING a few pixels of background rather than clipping the card. It is much better to have a slightly loose crop than to chop off part of the card.
- Order matters: top_left / top_right / bottom_right / bottom_left, as the card appears in the image (follow the card's orientation, not the image's — if the card is rotated or tilted, top_left is still the card's own top-left corner).
- A real trading card has an aspect ratio near 2.5:3.5 (≈0.71 width:height when portrait). Use this as a sanity check on your answer: the quad you return should be roughly that shape when un-rotated.
- If no card is visible, or you are not confident you can find all four edges, set card_present=false, confidence<0.5, and return any placeholder corners.
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

  // Aspect-ratio sanity check. Real trading cards are 2.5:3.5 (≈0.714
  // portrait, or ≈1.4 landscape). Use the average of top/bottom edge lengths
  // and left/right edge lengths — robust to mild perspective skew. Reject
  // anything more than ±35% off, which is what bit us on the Sandglitter
  // card that came back clipped (way too narrow to be a real card).
  const TARGET_PORTRAIT = 2.5 / 3.5; // 0.7143
  const dist = (p: QuadPoint, q: QuadPoint) =>
    Math.hypot(p.x - q.x, p.y - q.y);
  const topEdge = dist(tl, tr);
  const bottomEdge = dist(bl, br);
  const leftEdge = dist(tl, bl);
  const rightEdge = dist(tr, br);
  const avgW = (topEdge + bottomEdge) / 2;
  const avgH = (leftEdge + rightEdge) / 2;
  if (avgW > 0 && avgH > 0) {
    const ratio = avgW / avgH;
    const portraitErr = Math.abs(ratio - TARGET_PORTRAIT) / TARGET_PORTRAIT;
    const landscapeErr =
      Math.abs(ratio - 1 / TARGET_PORTRAIT) / (1 / TARGET_PORTRAIT);
    const minErr = Math.min(portraitErr, landscapeErr);
    if (minErr > 0.35) {
      return {
        ok: false,
        reason: "no_card_detected",
        latencyMs: Date.now() - started,
        detail: `aspect ratio ${ratio.toFixed(3)} too far from card shape`,
      };
    }
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
