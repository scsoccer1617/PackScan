// Sharpness scoring for camera frames.
//
// Used by the in-camera burst-and-pick path (CardCameraCapture) and the
// post-capture review banner (Scan.tsx). Lives in `shared/` so the same
// implementation can be exercised by node-side tests via `npx tsx`.
//
// The metric is variance-of-Laplacian on the luminance channel: a sharp
// edge produces large positive/negative values when convolved against the
// 3x3 Laplacian kernel, while a uniform or out-of-focus region produces
// small values. Higher score → sharper.
//
// Threshold tuning notes
// ──────────────────────
// SHARPNESS_BLURRY_THRESHOLD is the "soft warning" cut-off — below this
// the capture surface flags the frame as likely blurry. The number was
// picked against the 480x480 center-cropped luminance pipeline used by
// scoreImageData() / the in-camera burst:
//
//   • A high-contrast 32-px checkerboard (synthetic, perfect focus)
//     scores ~3500-4500 on this pipeline.
//   • A real, well-lit baseball-card scan (sharp text on the back) scores
//     in the 80-300 range — orders of magnitude lower than the synthetic
//     because real edges are anti-aliased and most of the frame is
//     low-frequency. We treat 60 as comfortably sharp.
//   • A Gaussian-blurred (sigma ≈ 2px) version of the same checkerboard
//     drops to ~50-80, and a heavily-blurred (sigma ≈ 4px) version
//     drops further to single digits.
//   • The reproduction blur the user reported on the 1990 Upper Deck
//     Atlanta Braves checklist back lands around 12-25 on this metric.
//
// 30 is intentionally conservative — we'd rather miss flagging a
// borderline-sharp frame than false-positive on a clear scan and train
// users to ignore the banner. The existing in-viewfinder pill uses
// BLUR_SOFT=20 against a 64x64 sample; this number is higher because the
// 480x480 sample preserves more of the high-frequency text detail that's
// the actual signal we care about.
export const SHARPNESS_BLURRY_THRESHOLD = 30;

// Crop size for the center sample used by the burst scoring path. 480 is
// large enough to retain readable text edges from the back of a card
// (which is the usability signal we care about) while still keeping the
// per-frame compute well under 10ms on a mid-tier phone.
export const SHARPNESS_SAMPLE_SIZE = 480;

interface ImageDataLike {
  data: Uint8ClampedArray | Uint8Array | number[];
  width: number;
  height: number;
}

// Variance-of-Laplacian over a 4-neighbor Laplacian kernel
// [[0,1,0],[1,-4,1],[0,1,0]] on the luminance channel
// (ITU-R BT.601: 0.299R + 0.587G + 0.114B). Returns 0 on degenerate input
// (1x1, 2x2 — no interior pixels exist for the kernel) so callers can
// treat it as a non-throwing function.
export function varianceOfLaplacian(imageData: ImageDataLike): number {
  const { data, width, height } = imageData;
  if (width < 3 || height < 3) return 0;
  const gray = new Float32Array(width * height);
  for (let i = 0, j = 0; i + 2 < data.length && j < gray.length; i += 4, j += 1) {
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const lap =
        4 * gray[idx] -
        gray[idx - 1] -
        gray[idx + 1] -
        gray[idx - width] -
        gray[idx + width];
      sum += lap;
      sumSq += lap * lap;
      n += 1;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

// Convenience wrapper that takes either an ImageData-shaped object (from
// canvas.getImageData) or a HTMLCanvasElement and returns the score. When
// given a canvas, it grabs the full pixel buffer; if you want a
// center-crop sample, do that on the canvas first.
export function scoreImageData(input: ImageDataLike): number {
  return varianceOfLaplacian(input);
}

// Pick the index of the frame with the highest sharpness score. Returns
// -1 on empty input. Stable on ties (returns the first matching index).
export function pickSharpest(scores: number[]): number {
  if (scores.length === 0) return -1;
  let best = 0;
  let bestScore = scores[0];
  for (let i = 1; i < scores.length; i += 1) {
    if (scores[i] > bestScore) {
      bestScore = scores[i];
      best = i;
    }
  }
  return best;
}

// True when the score is below the "soft warning" threshold. Wrapped as a
// helper so callers don't need to import the threshold constant directly.
export function isLikelyBlurry(score: number | null | undefined): boolean {
  if (score == null || !Number.isFinite(score)) return false;
  return score < SHARPNESS_BLURRY_THRESHOLD;
}
