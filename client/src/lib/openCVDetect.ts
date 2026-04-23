// Real computer-vision edge detection for trading-card boundaries.
//
// Google-Lens style: we run classical CV (Canny edge + contour finding +
// minAreaRect) directly on the captured photo to find the ACTUAL pixels
// where the card ends and the background begins. This is the fundamental
// fix for the failure modes we hit with LLM-based quad detection in
// PRs #49-52: LLMs return plausible-looking-but-wrong quads (too narrow,
// sheared, too tall) that no amount of post-processing can rescue, because
// the LLM never "saw" the card edge — it guessed.
//
// OpenCV.js is lazy-loaded from the official CDN on first use. It's ~8MB
// WASM, cached by the browser after first load (~500ms first-load overhead,
// ~50ms subsequent). If the load fails (offline, CDN blocked), detection
// returns null and callers fall back to the server/Haiku path.
//
// Pipeline (matches every production receipt/document scanner pattern):
//   1. Downscale to max edge 800px   — fast Canny, enough resolution for edges
//   2. Grayscale                      — cards are color but edges are color-agnostic
//   3. Gaussian blur 5x5              — kills high-freq pattern noise (polka dots!)
//   4. Canny 50/150                   — binary edge map
//   5. Dilate 3x3 once                — close small gaps in the card border
//   6. findContours (external only)   — list of candidate boundaries
//   7. Filter by area (>= 15% of image) and approxPolyDP to 4-sided contours
//   8. Pick the largest 4-sided contour → the card
//   9. Order corners TL/TR/BR/BL      — ready to hand to cropCardFromQuad
//
// If no quad-shaped contour survives filtering (e.g. card is flush against
// a same-colored background), return null and let Haiku try.

import type { NormalizedQuad } from "@/lib/cardQuadCrop";

// Official OpenCV.js distribution. This URL is the one documented on
// docs.opencv.org and is stable across 4.x releases. Browser caches the
// WASM aggressively so the 500ms hit only happens once per session.
const OPENCV_CDN_URL = "https://docs.opencv.org/4.x/opencv.js";

// How long to wait for OpenCV to finish initializing (`cv['onRuntimeInitialized']`
// fires after the WASM is ready). Most devices are well under 3s; bail at 15s
// so we don't hang forever if the CDN is slow.
const OPENCV_READY_TIMEOUT_MS = 15000;

// Max working edge for the detection pass. Canny on a 4K photo is slow AND
// over-detects texture; 800px is plenty to find the card outline and gives
// a ~50ms total pipeline time on mid-range phones.
const DETECT_MAX_EDGE = 800;

// Contour must cover at least this fraction of the image area to be considered
// the card. Prevents picking up small specular reflections or background noise.
const MIN_CONTOUR_AREA_FRACTION = 0.15;

// approxPolyDP epsilon as a fraction of the contour perimeter. 2% is the
// standard OpenCV value for document-like quadrilateral simplification.
const APPROX_EPSILON_FRACTION = 0.02;

// Module-scope singleton so we only request the CDN once per page load.
let cvReadyPromise: Promise<any> | null = null;

declare global {
  interface Window {
    cv?: any;
    Module?: any;
  }
}

/**
 * Returns a promise that resolves to the global `cv` namespace once OpenCV.js
 * has finished initializing. First call triggers the CDN fetch; subsequent
 * calls reuse the same promise.
 */
export function ensureOpenCVReady(): Promise<any> {
  if (cvReadyPromise) return cvReadyPromise;

  cvReadyPromise = new Promise((resolve, reject) => {
    // If a previous bundle already loaded it (HMR, other callers), reuse.
    if (typeof window !== "undefined" && window.cv && window.cv.Mat) {
      resolve(window.cv);
      return;
    }

    const timeout = window.setTimeout(() => {
      reject(new Error("OpenCV.js load timed out"));
    }, OPENCV_READY_TIMEOUT_MS);

    // OpenCV.js looks for window.Module and calls Module.onRuntimeInitialized
    // when the WASM is ready. We install our hook BEFORE injecting the script.
    const existing = window.Module || {};
    window.Module = {
      ...existing,
      onRuntimeInitialized: () => {
        window.clearTimeout(timeout);
        try {
          existing.onRuntimeInitialized?.();
        } catch {
          /* ignore */
        }
        if (window.cv && window.cv.Mat) {
          resolve(window.cv);
        } else {
          reject(new Error("OpenCV.js loaded but cv namespace missing"));
        }
      },
    };

    const script = document.createElement("script");
    script.async = true;
    script.src = OPENCV_CDN_URL;
    script.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("OpenCV.js script failed to load"));
    };
    document.head.appendChild(script);
  }).catch((err) => {
    // Reset singleton so a later attempt (e.g. retry after network recovery)
    // can try again. Otherwise one early failure poisons the whole session.
    cvReadyPromise = null;
    throw err;
  });

  return cvReadyPromise;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Classical-CV card detection. Returns a NormalizedQuad (corners in 0..1)
 * on success, or null if no quad-shaped contour was found.
 *
 * Never throws — errors (OpenCV load failure, unexpected null Mat, etc.)
 * are caught internally and turned into `null`. Callers should fall back
 * to the server-side Haiku detector when null comes back.
 */
export async function detectCardQuadWithCV(
  sourceImage: string,
): Promise<NormalizedQuad | null> {
  let cv: any;
  try {
    cv = await ensureOpenCVReady();
  } catch (err) {
    console.warn("[openCVDetect] OpenCV.js unavailable:", err);
    return null;
  }

  let img: HTMLImageElement;
  try {
    img = await loadImage(sourceImage);
  } catch (err) {
    console.warn("[openCVDetect] source image failed to load:", err);
    return null;
  }

  // Downscale into an offscreen canvas so we feed a consistent size to CV
  // and don't blow memory on a 4K phone photo.
  const origW = img.naturalWidth;
  const origH = img.naturalHeight;
  const longest = Math.max(origW, origH);
  const scale = longest > DETECT_MAX_EDGE ? DETECT_MAX_EDGE / longest : 1;
  const w = Math.max(1, Math.round(origW * scale));
  const h = Math.max(1, Math.round(origH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);

  // --- OpenCV pipeline ---
  // All cv.Mat instances must be .delete()'d or the WASM heap leaks.
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const dilated = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    // 5x5 Gaussian to kill polka-dot / glitter / rainbow-foil high-frequency
    // pattern noise that would otherwise dominate the edge map.
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blurred, edges, 50, 150, 3, false);
    // Single 3x3 dilation closes small gaps in the card border without
    // merging nearby unrelated edges.
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), 1);
    kernel.delete();

    cv.findContours(
      dilated,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );

    const imageArea = w * h;
    let bestQuad: {
      area: number;
      pts: { x: number; y: number }[];
    } | null = null;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour, false);
      if (area < imageArea * MIN_CONTOUR_AREA_FRACTION) {
        contour.delete();
        continue;
      }
      // Simplify the contour to its corner vertices. A well-detected card
      // will collapse to exactly 4 points; wobbly detections might give
      // 5-6, in which case we still take the minAreaRect as a fallback.
      const peri = cv.arcLength(contour, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, APPROX_EPSILON_FRACTION * peri, true);

      let pts: { x: number; y: number }[] | null = null;
      if (approx.rows === 4) {
        pts = [];
        for (let j = 0; j < 4; j++) {
          pts.push({
            x: approx.data32S[j * 2],
            y: approx.data32S[j * 2 + 1],
          });
        }
      } else if (approx.rows >= 4 && approx.rows <= 8) {
        // Near-quad: fall back to the minimum-area rotated rectangle of the
        // original contour. This is exactly what Google Lens does for
        // imperfect contours.
        const rect = cv.minAreaRect(contour);
        const boxMat = new cv.Mat();
        cv.boxPoints(rect, boxMat);
        pts = [];
        for (let j = 0; j < 4; j++) {
          pts.push({
            x: boxMat.data32F[j * 2],
            y: boxMat.data32F[j * 2 + 1],
          });
        }
        boxMat.delete();
      }

      approx.delete();
      contour.delete();

      if (pts && (!bestQuad || area > bestQuad.area)) {
        bestQuad = { area, pts };
      }
    }

    if (!bestQuad) {
      console.log("[openCVDetect] no quad-shaped contour found");
      return null;
    }

    const ordered = orderCorners(bestQuad.pts);
    return {
      topLeft: { x: ordered.tl.x / w, y: ordered.tl.y / h },
      topRight: { x: ordered.tr.x / w, y: ordered.tr.y / h },
      bottomRight: { x: ordered.br.x / w, y: ordered.br.y / h },
      bottomLeft: { x: ordered.bl.x / w, y: ordered.bl.y / h },
    };
  } catch (err) {
    console.warn("[openCVDetect] pipeline error", err);
    return null;
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    dilated.delete();
    contours.delete();
    hierarchy.delete();
  }
}

/**
 * Order 4 points into TL, TR, BR, BL based on their x/y in image space.
 * Uses the standard document-scanner trick: TL has smallest x+y, BR has
 * largest x+y, TR has smallest y-x, BL has largest y-x.
 */
function orderCorners(
  pts: { x: number; y: number }[],
): {
  tl: { x: number; y: number };
  tr: { x: number; y: number };
  br: { x: number; y: number };
  bl: { x: number; y: number };
} {
  let tl = pts[0],
    tr = pts[0],
    br = pts[0],
    bl = pts[0];
  let minSum = Infinity,
    maxSum = -Infinity,
    minDiff = Infinity,
    maxDiff = -Infinity;
  for (const p of pts) {
    const sum = p.x + p.y;
    const diff = p.y - p.x;
    if (sum < minSum) {
      minSum = sum;
      tl = p;
    }
    if (sum > maxSum) {
      maxSum = sum;
      br = p;
    }
    if (diff < minDiff) {
      minDiff = diff;
      tr = p;
    }
    if (diff > maxDiff) {
      maxDiff = diff;
      bl = p;
    }
  }
  return { tl, tr, br, bl };
}
