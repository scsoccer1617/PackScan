// Client-side perspective-warp crop (Google-Lens style: aspect-preserving).
//
// Given a source image (data URL or blob URL) and 4 normalized corner points
// (0..1) describing the trading card inside that image, produces a cropped
// JPEG data URL by sampling the source quadrilateral onto a rectangular
// canvas.
//
// Design choices (PR #51):
// - Output dimensions are DERIVED FROM THE DETECTED QUAD, not forced to 2.5:3.5.
//   Warping a slightly-narrow quad onto a forced-wide canvas stretches pixels
//   horizontally and clips content on patterned cards (Sandglitter, Tinsel,
//   etc.). We now preserve whatever aspect ratio Haiku returned so pixels are
//   never resampled to a different shape than they came in.
// - Before warping, every corner is pushed 8% OUTWARD from the quad centroid.
//   This trades a slightly looser crop for a guarantee we never clip the
//   physical card edge even when Haiku's quad falls a few pixels inside the
//   real border. Matches Lens's generous bracket behavior.
// - The server's aspect-ratio guard now rejects quads more than ±18% off,
//   so anything wildly wrong falls back to the uncropped original instead of
//   producing a stretched crop.
//
// Uses an inverse bilinear mapping: for each output pixel (u,v) in [0,1]^2,
// sample the source image at
//   P(u,v) = (1-u)(1-v)*TL + u(1-v)*TR + uv*BR + (1-u)v*BL
// This isn't a true projective warp, but for cards photographed roughly
// head-on (which is the overwhelming dealer use case) it's visually
// indistinguishable from one and runs in pure JS on the main thread with no
// dependencies.

export type NormalizedQuad = {
  topLeft: { x: number; y: number };
  topRight: { x: number; y: number };
  bottomRight: { x: number; y: number };
  bottomLeft: { x: number; y: number };
};

// Fraction of the quad's half-diagonal that each corner is pushed outward
// from the centroid before warping. 8% is enough to absorb small Haiku
// mis-estimates of the card edge without pulling in a distracting amount of
// background.
const QUAD_OUTWARD_PAD = 0.08;

// Cap the longest output edge so huge source photos don't yield 3000px crops.
// ~1400px on the long side is plenty of resolution for downstream Vision/Holo
// calls and keeps the output JPEG small.
const MAX_OUTPUT_EDGE = 1400;

// Kept as legacy exports (other modules still reference these symbols). They
// no longer define the output size — see derivation below.
export const CARD_OUTPUT_WIDTH = 900;
export const CARD_OUTPUT_HEIGHT = 1260;

type Point = { x: number; y: number };

function padQuadOutward(
  quad: { TL: Point; TR: Point; BR: Point; BL: Point },
  padFraction: number,
): { TL: Point; TR: Point; BR: Point; BL: Point } {
  const cx = (quad.TL.x + quad.TR.x + quad.BR.x + quad.BL.x) / 4;
  const cy = (quad.TL.y + quad.TR.y + quad.BR.y + quad.BL.y) / 4;
  const push = (p: Point): Point => ({
    x: p.x + (p.x - cx) * padFraction,
    y: p.y + (p.y - cy) * padFraction,
  });
  return {
    TL: push(quad.TL),
    TR: push(quad.TR),
    BR: push(quad.BR),
    BL: push(quad.BL),
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

/**
 * Warp the region of `sourceImage` described by `quad` into a clean
 * CARD_OUTPUT_WIDTH x CARD_OUTPUT_HEIGHT rectangle and return a JPEG data URL.
 *
 * If the quad is so close to axis-aligned that a plain crop looks identical,
 * we take the fast path (single drawImage) and skip per-pixel sampling.
 */
export async function cropCardFromQuad(
  sourceImage: string,
  quad: NormalizedQuad,
  opts: { quality?: number } = {},
): Promise<string> {
  const quality = opts.quality ?? 0.92;
  const img = await loadImage(sourceImage);
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;

  // Pixel-space corners from Haiku's normalized quad.
  const rawCorners = {
    TL: { x: quad.topLeft.x * sw, y: quad.topLeft.y * sh },
    TR: { x: quad.topRight.x * sw, y: quad.topRight.y * sh },
    BR: { x: quad.bottomRight.x * sw, y: quad.bottomRight.y * sh },
    BL: { x: quad.bottomLeft.x * sw, y: quad.bottomLeft.y * sh },
  };

  // Push each corner 8% outward from the centroid so we never clip the true
  // card edge when Haiku's estimate is slightly tight. Then clamp back inside
  // the source image bounds so we don't try to sample off-image pixels.
  const padded = padQuadOutward(rawCorners, QUAD_OUTWARD_PAD);
  const clamp = (p: Point): Point => ({
    x: Math.max(0, Math.min(sw - 1, p.x)),
    y: Math.max(0, Math.min(sh - 1, p.y)),
  });
  const TL = clamp(padded.TL);
  const TR = clamp(padded.TR);
  const BR = clamp(padded.BR);
  const BL = clamp(padded.BL);

  // Derive OUTPUT dimensions from the padded quad's actual edge lengths.
  // Do NOT force 2.5:3.5 — that's what produced the stretched crops. We use
  // the average of the top/bottom edge (width) and the average of the
  // left/right edge (height) to get a robust size even under mild perspective
  // skew. Then scale down to fit within MAX_OUTPUT_EDGE.
  const topEdgeLen = Math.hypot(TR.x - TL.x, TR.y - TL.y);
  const bottomEdgeLen = Math.hypot(BR.x - BL.x, BR.y - BL.y);
  const leftEdgeLen = Math.hypot(BL.x - TL.x, BL.y - TL.y);
  const rightEdgeLen = Math.hypot(BR.x - TR.x, BR.y - TR.y);
  const avgW = Math.max(8, (topEdgeLen + bottomEdgeLen) / 2);
  const avgH = Math.max(8, (leftEdgeLen + rightEdgeLen) / 2);

  let outW = Math.round(avgW);
  let outH = Math.round(avgH);
  const longest = Math.max(outW, outH);
  if (longest > MAX_OUTPUT_EDGE) {
    const scale = MAX_OUTPUT_EDGE / longest;
    outW = Math.max(8, Math.round(outW * scale));
    outH = Math.max(8, Math.round(outH * scale));
  }

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // Fast path: if the quad is almost a rectangle (edges nearly axis-aligned),
  // skip the bilinear sampler and use a single drawImage call. Because output
  // size now matches input quad size, drawImage does no stretching.
  const maxSkew = Math.max(
    Math.abs(TL.y - TR.y) / sh,
    Math.abs(BL.y - BR.y) / sh,
    Math.abs(TL.x - BL.x) / sw,
    Math.abs(TR.x - BR.x) / sw,
  );
  if (maxSkew < 0.01) {
    const minX = Math.min(TL.x, BL.x);
    const maxX = Math.max(TR.x, BR.x);
    const minY = Math.min(TL.y, TR.y);
    const maxY = Math.max(BL.y, BR.y);
    const rw = Math.max(1, maxX - minX);
    const rh = Math.max(1, maxY - minY);
    ctx.drawImage(img, minX, minY, rw, rh, 0, 0, out.width, out.height);
    return out.toDataURL("image/jpeg", quality);
  }

  // Bilinear sampling path. Draw the source image to an offscreen canvas first
  // so we can read its pixel data, then walk output pixels.
  const src = document.createElement("canvas");
  src.width = sw;
  src.height = sh;
  const sctx = src.getContext("2d");
  if (!sctx) throw new Error("Canvas 2D context unavailable");
  sctx.drawImage(img, 0, 0);
  const srcData = sctx.getImageData(0, 0, sw, sh);
  const srcPix = srcData.data;

  const outImg = ctx.createImageData(out.width, out.height);
  const outPix = outImg.data;

  // Per-row loop, computing the row's left/right edge points once via
  // linear interpolation, then walking u across them.
  for (let j = 0; j < outH; j++) {
    const v = j / (outH - 1);
    const leftX = TL.x + (BL.x - TL.x) * v;
    const leftY = TL.y + (BL.y - TL.y) * v;
    const rightX = TR.x + (BR.x - TR.x) * v;
    const rightY = TR.y + (BR.y - TR.y) * v;

    for (let i = 0; i < outW; i++) {
      const u = i / (outW - 1);
      const sx = leftX + (rightX - leftX) * u;
      const sy = leftY + (rightY - leftY) * u;

      // Bilinear sample of the source pixel.
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;

      if (x0 < 0 || y0 < 0 || x0 >= sw || y0 >= sh) continue;

      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const outIdx = (j * outW + i) * 4;
      outPix[outIdx] =
        srcPix[i00] * w00 +
        srcPix[i10] * w10 +
        srcPix[i01] * w01 +
        srcPix[i11] * w11;
      outPix[outIdx + 1] =
        srcPix[i00 + 1] * w00 +
        srcPix[i10 + 1] * w10 +
        srcPix[i01 + 1] * w01 +
        srcPix[i11 + 1] * w11;
      outPix[outIdx + 2] =
        srcPix[i00 + 2] * w00 +
        srcPix[i10 + 2] * w10 +
        srcPix[i01 + 2] * w01 +
        srcPix[i11 + 2] * w11;
      outPix[outIdx + 3] = 255;
    }
  }

  ctx.putImageData(outImg, 0, 0);
  return out.toDataURL("image/jpeg", quality);
}

export type DetectResult =
  | { ok: true; quad: NormalizedQuad; confidence: number; latencyMs: number }
  | { ok: false; reason: string; latencyMs?: number; detail?: string };

/**
 * Send a data URL to the quad-detection endpoint. Returns the detected quad
 * + confidence on success, or a structured failure reason. Callers should
 * fall back to the original image on failure.
 */
export async function detectCardQuad(
  sourceImage: string,
  opts: { maxEdge?: number; signal?: AbortSignal } = {},
): Promise<DetectResult> {
  const maxEdge = opts.maxEdge ?? 1280;

  // Downscale before POSTing so the VLM call is cheap and the upload is fast.
  // The detection only needs to see the overall composition, not fine print.
  const downscaled = await downscaleToJpegBlob(sourceImage, maxEdge, 0.85);

  const form = new FormData();
  form.append("image", downscaled, "quad.jpg");

  let resp: Response;
  try {
    resp = await fetch("/api/vision/detect-card-quad", {
      method: "POST",
      body: form,
      signal: opts.signal,
    });
  } catch (err) {
    console.warn("[cardQuadCrop] detect request failed", err);
    return { ok: false, reason: "network_error" };
  }
  if (!resp.ok) {
    console.warn("[cardQuadCrop] detect endpoint HTTP error", resp.status);
    return { ok: false, reason: `http_${resp.status}` };
  }
  const json = (await resp.json().catch(() => null)) as
    | { ok: true; quad: NormalizedQuad; confidence?: number; latencyMs?: number }
    | { ok: false; reason: string; latencyMs?: number; detail?: string }
    | null;
  if (!json) {
    return { ok: false, reason: "invalid_response" };
  }
  if (!json.ok) {
    console.log("[cardQuadCrop] no card detected", json);
    return json;
  }
  console.log("[cardQuadCrop] quad detected", {
    confidence: json.confidence,
    latencyMs: json.latencyMs,
    quad: json.quad,
  });
  return {
    ok: true,
    quad: json.quad,
    confidence: json.confidence ?? 0.7,
    latencyMs: json.latencyMs ?? 0,
  };
}

/**
 * Render a debug view: the raw image with the detected quad outlined on top.
 * Used by the dev overlay to eyeball what Haiku returned when a crop looks
 * wrong.
 */
export async function renderQuadDebugOverlay(
  sourceImage: string,
  quad: NormalizedQuad,
): Promise<string> {
  const img = await loadImage(sourceImage);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(img, 0, 0);

  const pts = [
    { x: quad.topLeft.x * canvas.width, y: quad.topLeft.y * canvas.height, label: "TL" },
    { x: quad.topRight.x * canvas.width, y: quad.topRight.y * canvas.height, label: "TR" },
    { x: quad.bottomRight.x * canvas.width, y: quad.bottomRight.y * canvas.height, label: "BR" },
    { x: quad.bottomLeft.x * canvas.width, y: quad.bottomLeft.y * canvas.height, label: "BL" },
  ];

  // Thick green outline of the detected quad.
  ctx.strokeStyle = "#00ff88";
  ctx.lineWidth = Math.max(6, canvas.width * 0.006);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();

  // Dots + labels at each corner.
  const dotR = Math.max(10, canvas.width * 0.012);
  ctx.font = `bold ${Math.max(28, canvas.width * 0.028)}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  for (const p of pts) {
    ctx.fillStyle = "#00ff88";
    ctx.beginPath();
    ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.fillText(p.label, p.x + dotR + 6, p.y);
  }

  return canvas.toDataURL("image/jpeg", 0.88);
}

async function downscaleToJpegBlob(
  src: string,
  maxEdge: number,
  quality: number,
): Promise<Blob> {
  const img = await loadImage(src);
  let { naturalWidth: w, naturalHeight: h } = img;
  const longest = Math.max(w, h);
  if (longest > maxEdge) {
    const scale = maxEdge / longest;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      quality,
    );
  });
}
