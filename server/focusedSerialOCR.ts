import sharp from 'sharp';
import { extractTextFromImage } from './googleVisionFetch';
import { detectSerialNumber, SerialNumberResult } from './serialNumberDetector';

/**
 * Run high-resolution channel-isolated OCR pass(es) over the front-of-card
 * image specifically to recover hand-stamped or foil-printed serial numbers
 * that the regular OCR pass misses.
 *
 * IMPORTANT: this only feeds the SERIAL NUMBER detector. It does not touch
 * the original image used for visual foil / parallel colour detection — the
 * foil detector still gets the unmodified colour image, so colour-based
 * parallel identification (Blue, Aqua, Gold, etc.) is unaffected.
 *
 * Why these specific transforms?
 *   Vision's OCR struggles with foil serials for two reasons:
 *     (a) the characters are small (a 5–6 mm stamp at scan resolution is
 *         only ~25–35 px tall), and
 *     (b) grayscale conversion averages R/G/B equally, which kills foil
 *         contrast — gold foil on a navy jersey looks similar in luminance
 *         to the jersey shadows once you collapse colour information.
 *
 *   The pipeline addresses both:
 *     1. Upscale 2.5× with the Lanczos kernel — gives Vision genuinely
 *        larger characters to detect, not just a stretched copy. This is
 *        the single most effective change.
 *     2. Extract a single colour channel instead of grayscale:
 *          - RED channel  → gold/red foil pops, jersey shadows recede
 *          - BLUE channel → silver/cool foil pops; warm card art recedes
 *        Two cheap variants cover virtually every foil colour.
 *     3. Normalize per channel to stretch the now-relevant tones across
 *        the full 0–255 range.
 *     4. Sharpen to recover crisp character edges after the resize.
 *     5. Output as PNG (lossless) so JPEG compression noise doesn't eat
 *        the small features we just enlarged.
 *
 * Variant selection:
 *   We pick the result with the most informative serial:
 *     1. Full numerator+denominator ("041/150") beats limit-only ("/150")
 *     2. Limit-only beats nothing
 *     3. If both variants tie, the RED-channel result wins (it covers the
 *        more common gold/copper/red foil case).
 */
export async function runFocusedSerialOCR(
  base64Image: string
): Promise<SerialNumberResult | null> {
  try {
    const inputBuffer = Buffer.from(base64Image, 'base64');

    // Determine target width for 2.5× upscale, capped to keep payload sane.
    // Vision API accepts up to 20 MB and 75 MP, so a 2.5× upscale of a
    // typical phone photo (~1500–3000 px wide) is well within limits.
    const meta = await sharp(inputBuffer).metadata();
    const baseWidth = meta.width || 1500;
    const targetWidth = Math.min(Math.round(baseWidth * 2.5), 5000);

    const buildVariant = (channel: 'red' | 'blue') =>
      sharp(inputBuffer)
        .resize({ width: targetWidth, kernel: sharp.kernel.lanczos3 })
        .extractChannel(channel)
        .normalize()
        .sharpen({ sigma: 1.2 })
        .png()
        .toBuffer();

    const [bufRed, bufBlue] = await Promise.all([
      buildVariant('red'),
      buildVariant('blue'),
    ]);

    console.log(
      `[FocusedOCR] Running 2 channel-isolated OCR passes in parallel ` +
      `(red-channel + blue-channel, upscaled ${baseWidth}→${targetWidth}px)...`
    );
    const [ocrRed, ocrBlue] = await Promise.all([
      extractTextFromImage(bufRed.toString('base64')).catch((e) => {
        console.warn('[FocusedOCR] Red-channel OCR failed:', e?.message || e);
        return { fullText: '', textAnnotations: [] as any[] };
      }),
      extractTextFromImage(bufBlue.toString('base64')).catch((e) => {
        console.warn('[FocusedOCR] Blue-channel OCR failed:', e?.message || e);
        return { fullText: '', textAnnotations: [] as any[] };
      }),
    ]);

    const resultRed = detectSerialNumber(ocrRed.fullText, ocrRed.textAnnotations || []);
    const resultBlue = detectSerialNumber(ocrBlue.fullText, ocrBlue.textAnnotations || []);

    logVariant('RED', ocrRed.fullText, resultRed);
    logVariant('BLUE', ocrBlue.fullText, resultBlue);

    return pickBetterSerial(resultRed, resultBlue);
  } catch (err: any) {
    console.error('[FocusedOCR] Pipeline error (non-fatal):', err?.message || err);
    return null;
  }
}

function logVariant(label: string, fullText: string, result: SerialNumberResult) {
  const preview = (fullText || '').replace(/\s+/g, ' ').trim().substring(0, 240);
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
