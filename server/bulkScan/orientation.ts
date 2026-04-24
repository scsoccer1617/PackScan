// Auto-detect 0° vs 180° rotation for a scanned card image.
//
// The Brother duplex scanner sends every back 180°-rotated on the flatbed
// path the dealer uses (vertical team column reads top-down on the original
// card, which scans upside-down relative to the front). Fronts land right-
// side-up. We can't hard-code "rotate every back 180°" because:
//   • Some dealers will scan right-side-up regardless of side.
//   • An un-paired page whose classifier disagreed with position might end
//     up in a different orientation than its neighbors.
//   • Future scanner models may feed differently.
//
// Instead we probe: OCR the image both as-is and rotated 180°, and pick
// whichever orientation produces richer text. "Richer" is defined as the
// one with the higher OCR word count AND more recognizable stat/bio tokens.
// Vision charges per-image so this costs one extra call per probe; for a
// typical 50-pair batch that's an extra 50 Vision calls beyond the single
// pass — acceptable for the accuracy win.
//
// As an optimization, we only probe when the caller signals ambiguity. The
// processor calls `detectOrientation` on every back (where the 180°-rotated
// case is common) but skips it for fronts (which are overwhelmingly right-
// side-up from the Brother scanner).

import sharp from 'sharp';
import { extractTextFromImage } from '../googleVisionFetch';

export interface OrientationResult {
  /** 0 means the input buffer is correct as-is; 180 means rotate. */
  rotationNeeded: 0 | 180;
  /** 0..1 confidence — gap between the two scores divided by the stronger. */
  confidence: number;
  /** OCR text for the chosen orientation so callers can reuse it. */
  ocrText: string;
  /** Raw per-orientation word counts (debug only). */
  debug: {
    originalWords: number;
    rotatedWords: number;
  };
}

function wordCount(text: string): number {
  return (text || '').split(/\s+/).filter(Boolean).length;
}

/**
 * Probe both 0° and 180° OCR richness and return which orientation reads
 * better. The returned `ocrText` is the reader-friendly orientation's text,
 * so the caller can feed it straight into downstream analyzers without
 * re-running Vision.
 *
 * On any probe failure we fall back to the original buffer with zero
 * rotation and log a warning — a scan never fails because orientation
 * detection misbehaves.
 */
export async function detectOrientation(buffer: Buffer, label: string): Promise<OrientationResult> {
  let originalText = '';
  let rotatedText = '';
  try {
    const originalB64 = buffer.toString('base64');
    const originalPromise = extractTextFromImage(originalB64).then(r => r.fullText || '');

    // Rotate 180° via sharp. `.rotate(180)` is deterministic and does not
    // depend on EXIF — the upstream caller is expected to have already
    // normalized EXIF (normalizeImageOrientation in dualSideOCR.ts).
    const rotatedBuffer = await sharp(buffer).rotate(180).toBuffer();
    const rotatedB64 = rotatedBuffer.toString('base64');
    const rotatedPromise = extractTextFromImage(rotatedB64).then(r => r.fullText || '');

    [originalText, rotatedText] = await Promise.all([originalPromise, rotatedPromise]);
  } catch (err: any) {
    console.warn(`[bulkScan/orientation] ${label}: probe failed, assuming 0° — ${err?.message}`);
    return {
      rotationNeeded: 0,
      confidence: 0,
      ocrText: originalText,
      debug: { originalWords: wordCount(originalText), rotatedWords: 0 },
    };
  }

  const originalWords = wordCount(originalText);
  const rotatedWords = wordCount(rotatedText);

  // Decide: rotate iff the rotated version reads meaningfully better. We
  // require at least 5 more words OR a 1.5× word-count ratio to flip, so
  // symmetry (both orientations read similarly) defaults to 0° (no change).
  const preferRotated =
    rotatedWords > originalWords + 5 ||
    (rotatedWords > 0 && rotatedWords >= originalWords * 1.5 && rotatedWords - originalWords >= 3);

  const rotationNeeded: 0 | 180 = preferRotated ? 180 : 0;
  const chosenWords = preferRotated ? rotatedWords : originalWords;
  const otherWords = preferRotated ? originalWords : rotatedWords;
  const confidence = chosenWords === 0
    ? 0
    : Number(Math.min(1, (chosenWords - otherWords) / Math.max(chosenWords, 1)).toFixed(2));

  console.log(
    `[bulkScan/orientation] ${label}: original=${originalWords}w rotated=${rotatedWords}w ` +
      `→ rotation=${rotationNeeded}° confidence=${confidence}`,
  );

  return {
    rotationNeeded,
    confidence,
    ocrText: preferRotated ? rotatedText : originalText,
    debug: { originalWords, rotatedWords },
  };
}

/**
 * Return a buffer with the orientation correction applied. Pairs with the
 * rotationNeeded from detectOrientation so the caller can one-line:
 *
 *   const orient = await detectOrientation(buf, 'back');
 *   const corrected = await applyRotation(buf, orient.rotationNeeded);
 */
export async function applyRotation(buffer: Buffer, rotation: 0 | 180): Promise<Buffer> {
  if (rotation === 0) return buffer;
  try {
    return await sharp(buffer).rotate(rotation).toBuffer();
  } catch (err: any) {
    console.warn(`[bulkScan/orientation] applyRotation(${rotation}) failed — returning original: ${err?.message}`);
    return buffer;
  }
}
