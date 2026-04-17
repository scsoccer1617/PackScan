import sharp from 'sharp';
import { extractTextFromImage } from './googleVisionFetch';
import { detectSerialNumber, SerialNumberResult } from './serialNumberDetector';

/**
 * Run high-contrast OCR pass(es) over the front-of-card image specifically to
 * recover hand-stamped or foil-printed serial numbers that the regular OCR
 * pass misses because the digits sit on top of busy card art (jersey
 * pinstripes, gradient backgrounds, holo foil, etc.).
 *
 * IMPORTANT: this only feeds the SERIAL NUMBER detector. It does not touch
 * the original image used for visual foil / parallel colour detection — the
 * foil detector still gets the unmodified colour image, so colour-based
 * parallel identification (Blue, Aqua, Gold, etc.) is unaffected.
 *
 * Why two variants?
 *   Foil characters can be either BRIGHT pixels on a darker card area
 *   (e.g. gold foil on a navy jersey) or DARKER reflections on a near-white
 *   area (e.g. silver foil on a white border). A single global contrast
 *   filter can't help both cases — boosting contrast clips one or the other
 *   into the background. We run two cheap variants and take whichever the
 *   detector can read.
 *
 * Variants:
 *   A) "bright-foil"  — grayscale + normalize + sharpen
 *      Best when foil is dark relative to background, or roughly mid-tone.
 *   B) "inverted-foil" — grayscale + normalize + NEGATE + sharpen
 *      Best when foil is brighter than the surrounding card art. After
 *      inversion the foil characters become dark text on a light field,
 *      which Vision reads far more reliably.
 *
 * We pick the result with the most informative serial:
 *   1. Full numerator+denominator ("041/150") beats limit-only ("/150")
 *   2. Limit-only beats nothing
 *   3. If both variants tie, variant A wins (less destructive transform)
 */
export async function runFocusedSerialOCR(
  base64Image: string
): Promise<SerialNumberResult | null> {
  try {
    const inputBuffer = Buffer.from(base64Image, 'base64');

    const variantA = sharp(inputBuffer)
      .grayscale()
      .normalize()
      .sharpen()
      .jpeg({ quality: 95 })
      .toBuffer();

    const variantB = sharp(inputBuffer)
      .grayscale()
      .normalize()
      .negate()
      .sharpen()
      .jpeg({ quality: 95 })
      .toBuffer();

    const [bufA, bufB] = await Promise.all([variantA, variantB]);

    console.log('[FocusedOCR] Running 2 enhanced-contrast OCR passes in parallel (bright-foil + inverted-foil)...');
    const [ocrA, ocrB] = await Promise.all([
      extractTextFromImage(bufA.toString('base64')).catch((e) => {
        console.warn('[FocusedOCR] Variant A OCR failed:', e?.message || e);
        return { fullText: '', textAnnotations: [] as any[] };
      }),
      extractTextFromImage(bufB.toString('base64')).catch((e) => {
        console.warn('[FocusedOCR] Variant B OCR failed:', e?.message || e);
        return { fullText: '', textAnnotations: [] as any[] };
      }),
    ]);

    const resultA = detectSerialNumber(ocrA.fullText, ocrA.textAnnotations || []);
    const resultB = detectSerialNumber(ocrB.fullText, ocrB.textAnnotations || []);

    logVariant('A bright-foil', ocrA.fullText, resultA);
    logVariant('B inverted-foil', ocrB.fullText, resultB);

    return pickBetterSerial(resultA, resultB);
  } catch (err: any) {
    console.error('[FocusedOCR] Pipeline error (non-fatal):', err?.message || err);
    return null;
  }
}

function logVariant(label: string, fullText: string, result: SerialNumberResult) {
  const preview = (fullText || '').replace(/\s+/g, ' ').trim().substring(0, 160);
  console.log(`[FocusedOCR] Variant ${label}: ${fullText.length} chars | preview="${preview}"`);
  if (result.isNumbered) {
    console.log(`[FocusedOCR] Variant ${label} → serial "${result.serialNumber}" via ${result.detectionMethod}`);
  } else {
    console.log(`[FocusedOCR] Variant ${label} → no serial`);
  }
}

function pickBetterSerial(
  a: SerialNumberResult,
  b: SerialNumberResult
): SerialNumberResult | null {
  const aHas = !!a?.isNumbered && !!a.serialNumber;
  const bHas = !!b?.isNumbered && !!b.serialNumber;
  if (!aHas && !bHas) return null;
  if (aHas && !bHas) return a;
  if (!aHas && bHas) return b;
  const aFull = !a.serialNumber.startsWith('/');
  const bFull = !b.serialNumber.startsWith('/');
  if (aFull && !bFull) return a;
  if (!aFull && bFull) return b;
  return a;
}
