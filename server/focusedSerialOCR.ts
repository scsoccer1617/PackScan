import sharp from 'sharp';
import { extractTextFromImage } from './googleVisionFetch';
import { detectSerialNumber, SerialNumberResult } from './serialNumberDetector';

/**
 * Run a high-contrast OCR pass over the front-of-card image specifically to
 * recover hand-stamped or foil-printed serial numbers that the regular OCR
 * pass misses because the digits sit on top of busy card art (jersey
 * pinstripes, gradient backgrounds, holo foil, etc.).
 *
 * IMPORTANT: this only feeds the SERIAL NUMBER detector. It does not touch
 * the original image used for visual foil / parallel colour detection — the
 * foil detector still gets the unmodified colour image, so colour-based
 * parallel identification (Blue, Aqua, Gold, etc.) is unaffected.
 *
 * Preprocessing pipeline (chosen for foil-on-pattern legibility, not pretty
 * rendering):
 *   1. Grayscale  — drops the colour channels that confuse OCR when foil
 *                   text sits over a coloured/striped background.
 *   2. Normalize  — stretches the histogram so the brightest and darkest
 *                   pixels span the full 0–255 range, dramatically
 *                   improving low-contrast foil stamps.
 *   3. Linear     — extra contrast boost (slope 1.4, offset −30) that pulls
 *                   light foil characters away from a near-white jersey.
 *   4. Sharpen    — recovers crisp edges on small foil characters that the
 *                   normalize step otherwise blurs.
 *
 * Returns null if anything in the pipeline fails — caller falls back to
 * whatever the original OCR pass produced.
 */
export async function runFocusedSerialOCR(
  base64Image: string
): Promise<SerialNumberResult | null> {
  try {
    const inputBuffer = Buffer.from(base64Image, 'base64');

    const processedBuffer = await sharp(inputBuffer)
      .grayscale()
      .normalize()
      .linear(1.4, -30)
      .sharpen()
      .jpeg({ quality: 95 })
      .toBuffer();

    const processedBase64 = processedBuffer.toString('base64');

    console.log('[FocusedOCR] Running enhanced-contrast OCR pass for serial recovery...');
    const { fullText, textAnnotations } = await extractTextFromImage(processedBase64);
    console.log(`[FocusedOCR] Enhanced OCR returned ${fullText.length} chars`);
    if (fullText) {
      const preview = fullText.replace(/\s+/g, ' ').trim().substring(0, 200);
      console.log(`[FocusedOCR] Preview: "${preview}"`);
    }

    const result = detectSerialNumber(fullText, textAnnotations || []);
    if (result.isNumbered) {
      console.log(`[FocusedOCR] Recovered serial via ${result.detectionMethod}: ${result.serialNumber}`);
    } else {
      console.log('[FocusedOCR] No serial recovered from enhanced-contrast pass');
    }
    return result;
  } catch (err: any) {
    console.error('[FocusedOCR] Pipeline error (non-fatal):', err?.message || err);
    return null;
  }
}
