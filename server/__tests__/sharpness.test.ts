/**
 * Standalone assert-based tests for shared/sharpness.ts.
 * Run via:
 *
 *   npx tsx server/__tests__/sharpness.test.ts
 *
 * Covers the variance-of-Laplacian metric across:
 *   • a high-contrast synthetic checkerboard (sharp baseline)
 *   • a uniform gray field (zero-edge baseline)
 *   • a programmatically Gaussian-blurred checkerboard (the failure mode
 *     the in-camera warning is meant to catch)
 *   • non-square + small-edge inputs to guard against off-by-one
 *     regressions in the convolution loop
 */

import assert from 'node:assert/strict';
import {
  varianceOfLaplacian,
  scoreImageData,
  pickSharpest,
  isLikelyBlurry,
  SHARPNESS_BLURRY_THRESHOLD,
} from '../../shared/sharpness';

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err: any) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(err?.message || err);
  }
}

type FakeImageData = { data: Uint8ClampedArray; width: number; height: number };

function makeImageData(width: number, height: number): FakeImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { data, width, height };
}

function setPixel(img: FakeImageData, x: number, y: number, v: number) {
  const idx = (y * img.width + x) * 4;
  img.data[idx] = v;
  img.data[idx + 1] = v;
  img.data[idx + 2] = v;
}

function getLum(img: FakeImageData, x: number, y: number): number {
  const idx = (y * img.width + x) * 4;
  return 0.299 * img.data[idx] + 0.587 * img.data[idx + 1] + 0.114 * img.data[idx + 2];
}

function checkerboard(width: number, height: number, cell: number): FakeImageData {
  const img = makeImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dark = ((x / cell) | 0) + ((y / cell) | 0);
      setPixel(img, x, y, dark % 2 === 0 ? 0 : 255);
    }
  }
  return img;
}

function uniform(width: number, height: number, value: number): FakeImageData {
  const img = makeImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) setPixel(img, x, y, value);
  }
  return img;
}

// 1D Gaussian kernel of given sigma, radius rounded to ceil(3*sigma).
function gaussianKernel(sigma: number): number[] {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const k: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  return k.map((v) => v / sum);
}

// Apply separable Gaussian blur to a grayscale-RGBA image. Operates on
// the RGB channels in place (alpha preserved).
function gaussianBlur(src: FakeImageData, sigma: number): FakeImageData {
  const { width, height } = src;
  const k = gaussianKernel(sigma);
  const radius = (k.length - 1) / 2;
  const tmp = new Float32Array(width * height);
  const out = makeImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let acc = 0;
      for (let i = -radius; i <= radius; i += 1) {
        const sx = Math.min(width - 1, Math.max(0, x + i));
        acc += getLum(src, sx, y) * k[i + radius];
      }
      tmp[y * width + x] = acc;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let acc = 0;
      for (let j = -radius; j <= radius; j += 1) {
        const sy = Math.min(height - 1, Math.max(0, y + j));
        acc += tmp[sy * width + x] * k[j + radius];
      }
      const v = Math.max(0, Math.min(255, acc));
      setPixel(out, x, y, v);
    }
  }
  return out;
}

// ── tests ────────────────────────────────────────────────────────────────

check('uniform gray returns near-zero variance', () => {
  const img = uniform(64, 64, 128);
  const v = varianceOfLaplacian(img);
  assert.ok(v < 1, `expected variance < 1, got ${v}`);
});

check('uniform black returns zero variance', () => {
  const img = uniform(64, 64, 0);
  const v = varianceOfLaplacian(img);
  assert.equal(v, 0);
});

check('sharp checkerboard scores well above blurry threshold', () => {
  const img = checkerboard(64, 64, 4);
  const v = varianceOfLaplacian(img);
  assert.ok(
    v > SHARPNESS_BLURRY_THRESHOLD * 10,
    `expected variance >> threshold (${SHARPNESS_BLURRY_THRESHOLD}), got ${v}`,
  );
});

check('heavily Gaussian-blurred checkerboard drops below threshold', () => {
  const sharp = checkerboard(64, 64, 4);
  const blurred = gaussianBlur(sharp, 4.0);
  const sharpScore = varianceOfLaplacian(sharp);
  const blurredScore = varianceOfLaplacian(blurred);
  assert.ok(
    blurredScore < sharpScore,
    `blur should reduce variance, got sharp=${sharpScore} blurred=${blurredScore}`,
  );
  assert.ok(
    blurredScore < SHARPNESS_BLURRY_THRESHOLD,
    `expected blurred variance < ${SHARPNESS_BLURRY_THRESHOLD}, got ${blurredScore}`,
  );
});

check('non-square input does not crash and is order-independent', () => {
  const wide = checkerboard(96, 32, 4);
  const tall = checkerboard(32, 96, 4);
  const wideScore = varianceOfLaplacian(wide);
  const tallScore = varianceOfLaplacian(tall);
  assert.ok(wideScore > 0 && tallScore > 0);
  assert.ok(Math.abs(wideScore - tallScore) / wideScore < 0.05);
});

check('1x1 input returns 0 instead of crashing', () => {
  const tiny = makeImageData(1, 1);
  const v = varianceOfLaplacian(tiny);
  assert.equal(v, 0);
});

check('2x2 input returns 0 (no interior pixels)', () => {
  const tiny = makeImageData(2, 2);
  setPixel(tiny, 0, 0, 255);
  setPixel(tiny, 1, 1, 255);
  const v = varianceOfLaplacian(tiny);
  assert.equal(v, 0);
});

check('alpha channel is ignored', () => {
  const a = checkerboard(32, 32, 4);
  const b = checkerboard(32, 32, 4);
  for (let i = 3; i < b.data.length; i += 4) b.data[i] = 17;
  const va = varianceOfLaplacian(a);
  const vb = varianceOfLaplacian(b);
  assert.equal(va, vb);
});

check('scoreImageData matches varianceOfLaplacian', () => {
  const img = checkerboard(48, 48, 6);
  assert.equal(scoreImageData(img), varianceOfLaplacian(img));
});

check('pickSharpest returns highest-scoring index', () => {
  assert.equal(pickSharpest([1, 5, 3]), 1);
  assert.equal(pickSharpest([5, 5, 3]), 0);
  assert.equal(pickSharpest([0]), 0);
  assert.equal(pickSharpest([]), -1);
});

check('isLikelyBlurry guards against null + non-finite', () => {
  assert.equal(isLikelyBlurry(null), false);
  assert.equal(isLikelyBlurry(undefined), false);
  assert.equal(isLikelyBlurry(Number.NaN), false);
  assert.equal(isLikelyBlurry(SHARPNESS_BLURRY_THRESHOLD - 1), true);
  assert.equal(isLikelyBlurry(SHARPNESS_BLURRY_THRESHOLD), false);
  assert.equal(isLikelyBlurry(SHARPNESS_BLURRY_THRESHOLD + 100), false);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nALL OK');
}
