import { Request, Response } from 'express';
import sharp from 'sharp';
import { CardFormValues } from '@shared/schema';
import { analyzeSportsCardImage, extractAllYearCandidates } from './dynamicCardAnalyzer';
import { lookupCard, lookupCardByPlayer } from './cardDatabaseService';
import { extractProductLine } from './productLineExtractor';
import { batchExtractTextFromImages, clearOcrCache } from './googleVisionFetch';
import type { FoilDetectionResult } from './visualFoilDetector';
import { db } from '@db';
import { cardVariations, cardDatabase } from '@shared/schema';
import { and, eq, sql, inArray } from 'drizzle-orm';

// Internal year-confidence flags attached to per-side and combined OCR
// results so the dual-side combiner and downstream lookup loop can reason
// about how reliable the year is. These are not part of the persisted
// CardFormValues schema — they exist only in-memory between the analyser
// and the catalog lookup. Using a typed alias avoids ad-hoc `as any`
// casts when reading or writing the flags.
interface YearConfidenceFlags {
  _yearFromCopyright?: boolean;
  _yearFromBareFallback?: boolean;
  _yearFromBackOnly?: boolean;
  _yearFromCatalogProbe?: boolean;
  _cardNumberLowConfidence?: boolean;
  _variationAmbiguous?: boolean;
  _variationOptions?: string[];
  _collectionAmbiguous?: boolean;
  _collectionCandidates?: Array<{
    brand: string;
    year: number;
    collection: string;
    set: string | null;
    cardNumber: string;
    playerName: string;
    isRookieCard: boolean;
  }>;
}
type CardFormWithFlags = CardFormValues & YearConfidenceFlags;

/**
 * Normalize an uploaded image buffer by physically applying its EXIF
 * orientation and stripping EXIF metadata. iOS/Android cameras save photos in
 * the sensor's native orientation and attach an EXIF rotation flag; Google
 * Vision's OCR does not honor that flag reliably, so the text comes back
 * sideways/upside-down for raw camera shots while photo-library uploads (which
 * are typically already re-encoded by the browser) read fine. Calling
 * sharp().rotate() with no argument auto-applies the EXIF orientation and
 * removes the tag, producing a buffer where the pixels are in display order.
 *
 * Returns the original buffer unchanged on any failure so a bad input never
 * blocks the scan.
 */
export async function normalizeImageOrientation(buffer: Buffer, label: string): Promise<Buffer> {
  try {
    const before = await sharp(buffer).metadata();
    const orientation = before.orientation ?? 1;
    if (orientation === 1) {
      return buffer;
    }
    const rotated = await sharp(buffer).rotate().toBuffer();
    console.log(`[OrientFix] ${label}: applied EXIF orientation ${orientation} (${before.width}x${before.height} → rotated)`);
    return rotated;
  } catch (err: any) {
    console.warn(`[OrientFix] ${label}: failed to normalize orientation, using original buffer:`, err?.message);
    return buffer;
  }
}

// Words that describe texture/finish but are NOT color identifiers.
// Stripped when extracting the color keyword(s) from a detected foil type name.
const GENERIC_FOIL_WORDS = new Set([
  'foil', 'shimmer', 'sparkle', 'glitter', 'pattern', 'crackle', 'wave',
  'burst', 'prizm', 'refractor', 'holo', 'holographic', 'parallel', 'chrome',
  'ice', 'frost', 'metallic', 'lava', 'flux', 'galaxy', 'scope'
]);

/**
 * Extract the color keyword(s) from a detected foil type string.
 * e.g. "Blue Crackle Foil" → ["blue"]
 *      "Gold Foil"         → ["gold"]
 *      "Rainbow Holographic" → ["rainbow"]
 */
function extractFoilColorKeywords(foilType: string): string[] {
  return foilType
    .split(/\s+/)
    .map(w => w.toLowerCase().replace(/[^a-z]/g, ''))
    .filter(w => w.length > 2 && !GENERIC_FOIL_WORDS.has(w));
}

/**
 * Query the card_variations table for the given brand/year/collection/set.
 * Returns an array of unique variation/parallel names, or [] if none found.
 * Tries collection+set first for precision, falls back to collection-only,
 * then brand+year only.
 */
async function getSetVariationNames(brand: string, year: number, collection?: string, set?: string): Promise<string[]> {
  try {
    const base = [
      sql`lower(${cardVariations.brand}) = lower(${brand})`,
      eq(cardVariations.year, year),
    ];

    const query = async (extra: any[]) => {
      const rows = await db
        .selectDistinct({ name: cardVariations.variationOrParallel })
        .from(cardVariations)
        .where(and(...base, ...extra))
        .limit(200);
      return rows.map(r => r.name?.toLowerCase() ?? '').filter(Boolean);
    };

    // Pass 1: collection + set (most specific)
    if (collection?.trim() && set?.trim()) {
      const result = await query([
        sql`lower(${cardVariations.collection}) = lower(${collection.trim()})`,
        sql`lower(${cardVariations.set}) = lower(${set.trim()})`,
      ]);
      if (result.length > 0) return result;
    }

    // Pass 2: collection only
    if (collection?.trim()) {
      const result = await query([
        sql`lower(${cardVariations.collection}) = lower(${collection.trim()})`,
      ]);
      if (result.length > 0) return result;
    }

    // Pass 3: set only
    if (set?.trim()) {
      const result = await query([
        sql`lower(${cardVariations.set}) = lower(${set.trim()})`,
      ]);
      if (result.length > 0) return result;
    }

    // Pass 4: brand+year only
    return await query([]);
  } catch {
    return [];
  }
}

// Define a standalone MulterFile interface that doesn't conflict with built-in types
interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  destination?: string;
  filename?: string;
  path?: string;
  buffer: Buffer;
}

// Create a type rather than an interface to avoid conflicts with Express's Request type
type MulterRequest = Request & {
  file?: MulterFile;
  files?: { [fieldname: string]: MulterFile[] };
}

// ── Front-only analyzer (shared between preliminary + dual handlers) ─────────
// Runs Google Vision OCR + the dynamic card analyzer on a single (front) image
// and returns both the raw OCR text and the partial CardFormValues result.
// Callers are responsible for normalizing EXIF orientation beforehand so this
// helper can be used on already-normalized buffers without re-rotating.
export async function runFrontSideAnalyzer(
  frontBuffer: Buffer,
): Promise<{ result: Partial<CardFormValues>; ocrText: string }> {
  const { batchExtractTextFromImages } = await import('./googleVisionFetch');
  const { extractTextFromImage } = await import('./googleVisionFetch');

  // Prime the per-request OCR cache with a batch call. This is equivalent to
  // what handleDualSideCardAnalysis does at the top of each scan, but scoped
  // to a single image — so a subsequent analyzeSportsCardImage() call hits
  // the cache for free.
  const base64 = frontBuffer.toString('base64');
  try {
    await batchExtractTextFromImages([{ base64, label: 'front' }]);
  } catch (batchErr: any) {
    console.warn('[preliminary] Batch Vision call failed, falling back to direct extract:', batchErr?.message);
  }

  const ocrText = (await extractTextFromImage(base64)).fullText || '';
  console.log(`[preliminary] Front text detection: ${ocrText.substring(0, 200)}`);

  // Match the 30 s timeout used by the main dual-handler so the preliminary
  // call can never hang a server slot indefinitely.
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Preliminary front analysis timed out after 30 seconds')), 30000);
  });

  const result = await Promise.race([
    analyzeSportsCardImage(base64, 'front'),
    timeout,
  ]);
  return { result, ocrText };
}

/**
 * Handle OCR analysis for both front and back card images
 * This handler combines data from both sides for more accurate results
 */
export async function handleDualSideCardAnalysis(req: MulterRequest, res: Response) {
  console.log('=== DUAL SIDE OCR HANDLER CALLED ===');
  console.time('dual-card-analysis-total');
  try {
    // Check if we have at least one image
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ 
        success: false,
        message: 'No images provided',
        error: 'missing_files'
      });
    }

    // Get front and back images if available
    const frontImage = req.files['frontImage']?.[0];
    const backImage = req.files['backImage']?.[0];

    // ── F-3a: pull preliminary front-side result (if any) ────────────────
    // The client generates a scanId when the user starts capturing and fires
    // POST /api/scan/preliminary on front shutter. By the time the back shutter
    // fires and the dual upload arrives, the preliminary OCR + front analyzer
    // usually has already finished — in which case we short-circuit the front
    // leg of this handler. If the preliminary is still in-flight we wait up to
    // 2 s; if it never appears, we fall back to running front OCR + analyzer
    // inline exactly like today (zero functional regression).
    const scanId: string | undefined = typeof (req.body as any)?.scanId === 'string'
      ? (req.body as any).scanId
      : undefined;
    let preliminaryEntry: import('./scanSession').PendingScanEntry | null = null;
    if (scanId) {
      const { waitForPendingScan } = await import('./scanSession');
      console.time('preliminary-wait');
      preliminaryEntry = await waitForPendingScan(scanId, 2000);
      console.timeEnd('preliminary-wait');
      if (preliminaryEntry) {
        console.log(`[scanSession] hit scanId=${scanId} — skipping front OCR + analyzer`);
        // Replace the uploaded front buffer with the already-normalized
        // preliminary buffer so any downstream consumer (visual foil detector,
        // crop routines, etc.) operates on the exact same bytes that produced
        // the cached OCR text and analyzer result.
        // Voice speculative entries don't carry a front image buffer, so
        // only substitute when the cached entry actually has one (i.e. the
        // preliminary fired from the image scan path).
        if (frontImage && preliminaryEntry.frontImageBuffer) {
          frontImage.buffer = preliminaryEntry.frontImageBuffer;
          frontImage.size = preliminaryEntry.frontImageBuffer.length;
        }
      } else {
        console.log(`[scanSession] miss scanId=${scanId} — falling back to inline front analysis`);
      }
    }

    if (!frontImage && !backImage) {
      return res.status(400).json({
        success: false,
        message: 'No front or back image provided',
        error: 'missing_required_images'
      });
    }

    // Check image file sizes (max 20MB each)
    if ((frontImage && frontImage.size > 20 * 1024 * 1024) || 
        (backImage && backImage.size > 20 * 1024 * 1024)) {
      return res.status(400).json({
        success: false,
        message: 'Image file is too large. Maximum size is 20MB per image.',
        error: 'file_too_large'
      });
    }

    // Check file types
    if ((frontImage && !frontImage.mimetype.startsWith('image/')) || 
        (backImage && !backImage.mimetype.startsWith('image/'))) {
      return res.status(400).json({
        success: false,
        message: 'Uploaded file is not an image.',
        error: 'invalid_file_type'
      });
    }

    console.log(
      'Received image files:',
      frontImage ? `Front: ${frontImage.originalname} (${frontImage.size} bytes)` : 'No front image',
      backImage ? `Back: ${backImage.originalname} (${backImage.size} bytes)` : 'No back image'
    );

    // ── EXIF orientation normalization ────────────────────────────────────────
    // Phone cameras save photos in sensor orientation with an EXIF rotation
    // flag. Google Vision OCR doesn't honor that flag, so raw camera shots
    // arrive sideways/upside-down at the analyzer (which is why photo-library
    // uploads — already rotated by the browser — produce better results than
    // direct camera captures). Apply the rotation to the pixels once here so
    // every downstream consumer (batch Vision call, per-side analyzer, foil
    // detector) sees correctly-oriented data.
    await Promise.all([
      // Preliminary front buffer is already orientation-normalized — skip the
      // redundant sharp.rotate() pass.
      frontImage && !preliminaryEntry
        ? normalizeImageOrientation(frontImage.buffer, 'front').then(b => { frontImage.buffer = b; frontImage.size = b.length; })
        : Promise.resolve(),
      backImage
        ? normalizeImageOrientation(backImage.buffer, 'back').then(b => { backImage.buffer = b; backImage.size = b.length; })
        : Promise.resolve(),
    ]);

    console.log('[Engine] ocr-first START');

    // ── Batch Vision API call ─────────────────────────────────────────────────
    // Send both images to Vision in a SINGLE batchAnnotateImages request.
    // Results are stored in the per-request OCR cache so that all subsequent
    // calls to extractTextFromImage() within this scan are free cache hits.
    // This reduces Vision API round-trips from 4 (2 per image) down to 1.
    clearOcrCache();
    try {
      const batchImages: { base64: string; label: string }[] = [];
      // Skip front when we already have a cached preliminary OCR result — no
      // need to re-run Vision on an image whose text we already have.
      if (frontImage && !preliminaryEntry) batchImages.push({ base64: frontImage.buffer.toString('base64'), label: 'front' });
      if (backImage)  batchImages.push({ base64: backImage.buffer.toString('base64'),  label: 'back'  });
      if (batchImages.length > 0) {
        console.time('vision-batch');
        await batchExtractTextFromImages(batchImages);
        console.timeEnd('vision-batch');
      }
    } catch (batchErr: any) {
      // Non-fatal: downstream calls will fall back to individual Vision requests
      console.warn('Batch Vision call failed, will fall back to individual calls:', batchErr.message);
    }

    // Create a timeout promise that rejects after 30 seconds
    const createTimeout = () => new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Image analysis timed out after 30 seconds')), 30000);
    });

    // Initialize result objects
    let frontResult: Partial<CardFormValues> = {};
    let backResult: Partial<CardFormValues> = {};

    // Store raw OCR text for foil detection
    let frontOCRText = '';
    let backOCRText = '';

    // Run front + back analyzers in parallel. Each analyzer reads from the
    // per-request OCR cache populated by batchExtractTextFromImages() above,
    // so neither side performs its own Vision API call — the work inside
    // analyzeSportsCardImage is pure text + DB lookups that don't share
    // mutable state across sides. Running them sequentially added ~1–2s to
    // every scan for no benefit.
    //
    // The brand-detection text is the same fullText the analyzer itself
    // extracts internally, so we re-use the OCR cache rather than calling
    // extractTextForBrandDetection() (which re-awaited the cached result
    // and dynamic-imported on every scan).
    console.time('dual-analyzers');
    const { extractTextFromImage } = await import('./googleVisionFetch');
    const analyzeSide = async (
      side: 'front' | 'back',
      image: MulterFile | undefined,
    ): Promise<{ result: Partial<CardFormValues>; ocrText: string }> => {
      if (!image) return { result: {}, ocrText: '' };
      try {
        const base64 = image.buffer.toString('base64');
        // Pull OCR text directly (cache hit after the batch call above)
        const ocrText = (await extractTextFromImage(base64)).fullText || '';
        console.log(`${side === 'front' ? 'Front' : 'Back'} text detection: ${ocrText.substring(0, 200)}`);
        console.log(`Using dynamic analyzer for ${side} image`);
        const result = await Promise.race([
          analyzeSportsCardImage(base64, side),
          createTimeout(),
        ]);
        console.log(`${side === 'front' ? 'Front' : 'Back'} image analysis returned:`, result);
        console.log(`${side === 'front' ? 'Front' : 'Back'} image analysis complete`);
        return { result, ocrText };
      } catch (error: any) {
        console.error(`Error analyzing ${side} image:`, error);
        const errMsg = error && typeof error === 'object' && 'message' in error ? (error as any).message : String(error);
        console.error(`${side === 'front' ? 'Front' : 'Back'} image analysis error details:`, errMsg);
        return { result: {}, ocrText: '' };
      }
    };

    // Reuse the preliminary front result when present; otherwise run the front
    // analyzer inline alongside the back analyzer (original behaviour).
    const frontAnalysisPromise: Promise<{ result: Partial<CardFormValues>; ocrText: string }> =
      preliminaryEntry
        ? Promise.resolve({ result: preliminaryEntry.frontResult, ocrText: preliminaryEntry.frontOCRText })
        : analyzeSide('front', frontImage);

    const [frontSide, backSide] = await Promise.all([
      frontAnalysisPromise,
      analyzeSide('back', backImage),
    ]);
    frontResult = frontSide.result;
    frontOCRText = frontSide.ocrText;
    backResult = backSide.result;
    backOCRText = backSide.ocrText;
    console.timeEnd('dual-analyzers');

    // Combine the results with priority to front image for player name, number, and rookie status
    // and priority to back image for copyright year, stats, and detailed information
    let combinedResult;
    
    console.log('=== BEFORE COMBINE FUNCTION ===');
    console.log('frontResult exists:', !!frontResult);
    console.log('backResult exists:', !!backResult);
    console.log('frontOCRText length:', frontOCRText?.length || 0);
    console.log('backOCRText length:', backOCRText?.length || 0);
    
    try {
      console.log('About to call combineCardResults...');
      console.log('Front result before combine:', JSON.stringify(frontResult, null, 2));
      console.log('Back result before combine:', JSON.stringify(backResult, null, 2));
      console.time('combine-card-results');
      // F-3c: pass the preliminary visual-foil hint through so the combine
      // step can skip its own `detectFoilFromImage` Vision call when the
      // preliminary endpoint already computed one.
      combinedResult = await combineCardResults(
        frontResult,
        backResult,
        frontOCRText,
        backOCRText,
        frontImage?.buffer,
        backImage?.buffer,
        preliminaryEntry?.visualFoilPrelim ?? null,
      );
      console.timeEnd('combine-card-results');
      console.log('combineCardResults completed. Result:', JSON.stringify(combinedResult, null, 2));
    } catch (error) {
      console.error('Error in combineCardResults:', error);
      console.error('Error details:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Error combining card analysis results'
      });
    }


    // Make sure we have all required fields with defaults if needed
    combinedResult._engine = combinedResult._engine ?? 'ocr';
    const finalResult = ensureRequiredFields(combinedResult);

    console.log(
      `[Engine] ocr-first END — brand=${finalResult.brand} year=${finalResult.year} #${finalResult.cardNumber} player="${finalResult.playerFirstName ?? ''} ${finalResult.playerLastName ?? ''}" foil=${finalResult.foilType || 'none'}`
    );
    console.log('Combined card analysis result:', JSON.stringify(finalResult, null, 2));
    console.timeEnd('dual-card-analysis-total');

    return res.json({
      success: true,
      data: finalResult
    });
    
  } catch (error: any) {
    console.error('Error in dual side card analysis:', error);
    console.timeEnd('dual-card-analysis-total');
    
    return res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred during image analysis',
      error: 'analysis_failed',
      data: {
        condition: 'PSA 8',
        sport: 'Not detected',
        brand: 'Unknown',
        year: new Date().getFullYear(),
        errorMessage: 'Failed to analyze the card images'
      }
    });
  }
}

/**
 * Quick extraction of text just to detect the card brand
 */
async function extractTextForBrandDetection(base64Image: string): Promise<string> {
  try {
    // Import dynamically to avoid circular dependencies
    const { extractTextFromImage } = await import('./googleVisionFetch');
    const result = await extractTextFromImage(base64Image);
    return result.fullText || '';
  } catch (error) {
    console.error('Error extracting text for brand detection:', error);
    return '';
  }
}

/**
 * Combine results from front and back card analysis
 */
async function combineCardResults(
  frontResult: Partial<CardFormValues>, 
  backResult: Partial<CardFormValues>,
  frontOCRText: string = '',
  backOCRText: string = '',
  frontImageBuffer?: Buffer,
  backImageBuffer?: Buffer,
  // F-3c: Optional preloaded visual-foil detection result from the
  // preliminary endpoint. When provided, the expensive `detectFoilFromImage`
  // Vision call below is skipped and this hint is used as the authoritative
  // visual-detection output. FoilDB validation / rejection logic downstream
  // still runs against it.
  preloadedVisualFoil?: FoilDetectionResult | null,
): Promise<Partial<CardFormValues>> {
  console.log('=== COMBINE CARD RESULTS STARTED ===');
  console.log('COMBINE FUNCTION IS DEFINITELY BEING CALLED!');
  console.log('Front result foilType:', frontResult.foilType);
  console.log('Back result foilType:', backResult.foilType);
  console.log('Front result keys:', Object.keys(frontResult));
  console.log('Back result keys:', Object.keys(backResult));
  console.log('Front OCR text length:', frontOCRText.length);
  console.log('Back OCR text length:', backOCRText.length);
  console.log('=== COMBINING CARD RESULTS ===');
  console.log('Front result sport:', frontResult.sport);
  console.log('Back result sport:', backResult.sport);
  
  // Start with an empty object
  const combined: Partial<CardFormValues> = {};
  
  // Fields where front image has priority
  const frontPriorityFields: (keyof CardFormValues)[] = [
    'playerFirstName', 'playerLastName',
    'isRookieCard', 'brand', 'collection', 'variant'
  ];
  
  // Fields where back image has priority (CMP codes, etc. are most reliably found on the back).
  // NOTE: `year` used to live here but is now handled separately below — see the
  // "year combination" block. The Leaf/Donruss publisher imprint on backs of
  // 1981–1993 cards prints a copyright year that can be off by ±1 from the
  // actual card year, so we need the front year to win in that specific case.
  const backPriorityFields: (keyof CardFormValues)[] = [
    'sport', 'serialNumber', 'cmpNumber'
  ];

  // Card number is EXCLUSIVELY from the back — never use front
  const backOnlyFields: (keyof CardFormValues)[] = ['cardNumber'];
  
  // Helper: check if a field value is meaningfully set (not empty, null, undefined, or 0 for numeric fields)
  const hasValue = (val: any): boolean => {
    if (val === undefined || val === null || val === '') return false;
    if (typeof val === 'number' && val === 0) return false;
    return true;
  };

  // Copy front priority fields first
  frontPriorityFields.forEach(field => {
    if (hasValue(frontResult[field])) {
      combined[field] = frontResult[field];
    } else if (hasValue(backResult[field])) {
      combined[field] = backResult[field];
    }
  });
  
  // Then copy back priority fields (back preferred, front as fallback)
  backPriorityFields.forEach(field => {
    if (hasValue(backResult[field])) {
      combined[field] = backResult[field];
    } else if (hasValue(frontResult[field])) {
      combined[field] = frontResult[field];
    }
  });

  // Back-only fields — NEVER use front values
  backOnlyFields.forEach(field => {
    if (hasValue(backResult[field])) {
      combined[field] = backResult[field];
    }
  });

  // Year combination — per the user-confirmed rule, the FRONT of the card
  // determines the year. The back is unreliable for year because:
  //   • The copyright line frequently pre-dates the card (Leaf/Donruss
  //     publisher imprint, late-year prints, etc.).
  //   • Stat tables on vintage card backs span multiple seasons, so a
  //     "year+team" pattern like "1986 METS" can pick a stat-line year
  //     instead of the production year.
  // So: prefer the front year. Only fall back to the back year if the front
  // has none — and in that case mark it back-derived so the DB lookup can
  // search neighboring years more aggressively.
  const frontYearFromCopyright = !!(frontResult as any)._yearFromCopyright;
  const backYearFromCopyright  = !!(backResult  as any)._yearFromCopyright;
  const frontYearFromBareFallback = !!(frontResult as any)._yearFromBareFallback;
  const frontHasYear = hasValue(frontResult.year);
  const backHasYear  = hasValue(backResult.year);

  // When the front year came from the bare-year fallback (i.e. just a 4-digit
  // year buried in prose like "TRIPLE CROWN-1967") AND it disagrees with the
  // back year by more than 2 years, the back year is more reliable. This
  // handles commemorative/tribute cards where the front mentions a historical
  // event year but the actual production year only appears on the back.
  if (frontHasYear && backHasYear &&
      frontYearFromBareFallback &&
      Math.abs(Number(frontResult.year) - Number(backResult.year)) > 2) {
    combined.year = backResult.year;
    (combined as any)._yearFromCopyright = backYearFromCopyright;
    console.log(`[Year] Back year ${backResult.year} preferred over front year ${frontResult.year} (front year was a bare-prose fallback and disagrees with back by >2 years — back is more authoritative for commemorative/tribute cards).`);
  } else if (frontHasYear) {
    combined.year = frontResult.year;
    (combined as any)._yearFromCopyright = frontYearFromCopyright;
    if (backHasYear && backResult.year !== frontResult.year) {
      console.log(`[Year] Front year ${frontResult.year} preferred over back year ${backResult.year} (front is the authoritative source; back stats and copyright lines are unreliable for year).`);
    }
  } else if (backHasYear) {
    combined.year = backResult.year;
    // Mark as low-confidence — front had no year, so this came entirely from
    // the back (stats / copyright / publisher imprint). DB lookup should
    // search neighboring years.
    (combined as any)._yearFromBackOnly = true;
    (combined as any)._yearFromCopyright = backYearFromCopyright;
    console.log(`[Year] Using back year ${backResult.year} as fallback (front had no year). Marked low-confidence — DB lookup will widen the year search window.`);
  }

  // Log when back has no card number
  if (!hasValue(backResult.cardNumber)) {
    if (hasValue(frontResult.cardNumber)) {
      console.log(`[CardNum] Back has no card number; front had "${frontResult.cardNumber}" but front values are ignored for card numbers (likely jersey number)`);
    } else {
      console.log(`[CardNum] Neither front nor back detected a card number`);
    }
  }

  // When collection came only from the back (front had no collection), verify it's not just a trademark mention.
  // If the front OCR text doesn't contain the collection name, it's likely from legal text on the back.
  if (!hasValue(frontResult.collection) && hasValue(backResult.collection) && hasValue(combined.collection)) {
    const collectionName = String(combined.collection);
    const frontTextUpper = frontOCRText.toUpperCase();
    const collectionWords = collectionName.toUpperCase().split(/\s+/);
    const frontHasCollection = collectionWords.every(w => frontTextUpper.includes(w));
    if (!frontHasCollection) {
      const backTextUpper = backOCRText.toUpperCase();
      const legalContextPattern = /REGISTERED\s+TRADEMARK|ALL\s+RIGHTS\s+RESERVED|©|\(C\)|OFFICIALLY\s+LICENSED/i;
      const backLines = backOCRText.split(/\r?\n/);
      const collectionInLegalLine = backLines.some(line => {
        const lineUpper = line.toUpperCase();
        return collectionWords.every(w => lineUpper.includes(w)) && legalContextPattern.test(line);
      });
      if (collectionInLegalLine) {
        console.log(`Clearing collection "${collectionName}" - only found in legal/trademark text on back, not visible on front card`);
        combined.collection = '';
      }
    }
  }
  
  // Special case for collection/variant: when front has a generic collection (e.g., "Chrome")
  // but back has a more specific collection + variant matching front's collection, prefer back's data
  if (hasValue(combined.collection) && hasValue(backResult.collection) && hasValue(backResult.variant)) {
    const frontCollection = String(combined.collection).toLowerCase();
    const backVariant = String(backResult.variant).toLowerCase();
    if (frontCollection === backVariant && combined.collection !== backResult.collection) {
      console.log(`Collection override: front="${combined.collection}" matches back variant="${backResult.variant}", using back collection="${backResult.collection}"`);
      combined.collection = backResult.collection;
      combined.variant = backResult.variant;
    }
  }
  
  // Special case for rookie card - if either side detected it, mark it as true
  if (frontResult.isRookieCard === true || backResult.isRookieCard === true) {
    combined.isRookieCard = true;
  }
  
  // Special case for serial numbers - if either side detected it, use it
  if (frontResult.serialNumber || backResult.serialNumber) {
    combined.serialNumber = frontResult.serialNumber || backResult.serialNumber;
    combined.isNumbered = true;
  }
  
  const bogusNameWords = new Set([
    'TOPPS', 'LOPPS', 'OPPS', 'CHROME', 'BOWMAN', 'FLEER', 'DONRUSS', 'PANINI', 'SCORE', 'LEAF',
    'SERIES', 'PHILLIE', 'PHILLIES', 'YANKEES', 'DODGERS', 'METS', 'CUBS', 'BRAVES',
    'ASTROS', 'RANGERS', 'PADRES', 'GIANTS', 'CARDINALS', 'NATIONALS', 'ORIOLES', 'GUARDIANS',
    'TWINS', 'RAYS', 'MARLINS', 'PIRATES', 'REDS', 'BREWERS', 'TIGERS', 'ROYALS', 'ATHLETICS',
    'MARINERS', 'ANGELS', 'ROCKIES', 'DIAMONDBACKS', 'SOX',
    'OUTFIELDER', 'INFIELDER', 'PITCHER', 'CATCHER', 'LEFT', 'RIGHT', 'THROWS', 'BATS',
    'MAJOR', 'LEAGUE', 'BATTING', 'RECORD', 'STADIUM', 'CLUB', 'COLLECTION',
    'OPENING', 'DAY', 'HERITAGE', 'PRIZM', 'SELECT', 'MOSAIC',
    'BASEBALL', 'CARD', 'ROOKIE', 'STARS', 'MLB',
    'GAME-USED', 'MEMORABILIA', 'RELIC', 'AUTOGRAPH', 'AUTOGRAPHED', 'SWATCH',
    'PATCH', 'JERSEY', 'UNIFORM', 'EQUIPMENT', 'GAME', 'USED', 'WORN',
    'INSERT', 'PARALLEL', 'REFRACTOR', 'CONNECT', 'CITY',
    'DRAFTED', 'BORN', 'FREE', 'AGENT',
    'ANNIV', 'ANNIVERSARY', 'ERSARY', 'COMPLETE',
    'AVG', 'SLG', 'OBP', 'ERA', 'RBI', 'HR', 'BB', 'SO', 'AB',
    'TOTALS', 'MAJ', 'LEA', 'THIRD', 'FIRST', 'SECOND', 'BASE',
    'OUTFIELD', 'HOUSTON', 'MILWAUKEE', 'PHILADELPHIA', 'CHICAGO',
    'EPPS', 'STROS', 'OXY', 'LAPPS', 'MLBPLAYERS', 'MLBPA',
    'LOP', 'PPS', 'TANKY', 'LOPPS',
    'KC', 'TB', 'LA', 'NY', 'SF', 'SD', 'STL', 'CLE', 'DET', 'MIN', 'CHC', 'CHW', 'CWS',
    'MIL', 'PIT', 'CIN', 'ATL', 'MIA', 'PHI', 'NYM', 'NYY', 'BOS', 'BAL', 'TOR',
    'HOU', 'TEX', 'SEA', 'OAK', 'LAA', 'LAD', 'ARI', 'COL',
    'SS', 'DH', 'SP', 'RP', 'CF', 'LF', 'RF', 'OF',
    'QB', 'WR', 'RB', 'TE', 'LB', 'CB', 'DE', 'DT',
    'SLG', 'OPS', 'AVG', 'WHIP', 'IP', 'AB',
    // Legal/licensing/manufacturing text fragments commonly OCR'd off the
    // bottom of vintage card backs. Added because the per-side analyser
    // sometimes promotes phrases like "OFFICIAL LICENSEL" (a garbled
    // "OFFICIALLY LICENSED") to the player-name field.
    'OFFICIAL', 'OFFICIALLY', 'LICENSE', 'LICENSED', 'LICENSEL', 'LICENSEE',
    'AUTHORIZED', 'COPYRIGHT', 'TRADEMARK', 'RESERVED', 'RIGHTS',
    'INSIGNIA', 'PANOGRAPHIC', 'PANOGRAPHICS', 'XOGRAPH', 'XOGRAPHO',
    'KELLOGG', 'KELLOGGS', 'VISUAL',
    'NFLPA', 'NBAPA', 'NHLPA', 'PLAYERS', 'ASSN', 'ASS',
    // Generic set/marketing descriptors that frequently appear on the
    // front of a card as the SET NAME (not the player). Added because
    // TCMA / Topps / Panini etc. ship retrospective sets with names
    // like "Baseball's Greatest Pitchers", "All-Time Stars", "Legends
    // of the Game", "Hall of Fame Heroes" — when those banner phrases
    // get OCR'd into playerFirstName/playerLastName the per-side
    // analyser otherwise treats them as a real name. None of these are
    // real human names, so dropping them is safe and sport-agnostic.
    'GREATEST', 'GREAT', 'GREATS', 'BEST', 'STAR', 'LEGEND', 'LEGENDS',
    'CLASSIC', 'CLASSICS', 'ESSENTIAL', 'ULTIMATE', 'MASTER', 'MASTERS',
    'ALL-TIME', 'ALLTIME', 'HEROES', 'HALL', 'FAME',
    'PITCHERS', 'CATCHERS', 'SLUGGERS', 'HITTERS',
  ]);

  // Strip trademark suffixes AND possessive 's so words like
  // "BASEBALL'S" match the bogus word "BASEBALL". Order matters: strip
  // trademark/period suffixes first, then strip a trailing possessive.
  const stripTrademarkSuffix = (w: string): string =>
    w.replace(/(?:TM|™|®|\.+)$/gi, '')
     .replace(/['’\u2019]S$/i, '');
  
  const isBogusFn = (firstName?: string, lastName?: string): boolean => {
    if (!firstName || !lastName) return true;
    const fullName = `${firstName} ${lastName}`.toUpperCase();
    const words = fullName.split(/\s+/);
    const isBogusWord = (w: string): boolean => {
      const cleaned = stripTrademarkSuffix(w);
      if (bogusNameWords.has(cleaned)) return true;
      if (cleaned.includes('-')) {
        return cleaned.split('-').every(part => bogusNameWords.has(part));
      }
      return false;
    };
    if (words.some(w => isBogusWord(w)) || words.length > 4) return true;
    if (words.some(w => w.length <= 1)) return true;
    if (words.some(w => /^\d/.test(w))) return true;
    if (words.length === 2 && words.every(w => w.length <= 3)) return true;
    const uniqueWords = new Set(words);
    if (uniqueWords.size === 1 && words.length > 1) return true;
    if (words.every(w => w.length <= 3)) return true;
    return false;
  };
  
  let frontNameBogus = isBogusFn(combined.playerFirstName, combined.playerLastName);
  const backNameBogus = isBogusFn(backResult.playerFirstName, backResult.playerLastName);

  // Collection-name overlap check: when every token of the front-detected
  // player name appears in the collection name (after singular/plural
  // normalisation), the OCR latched onto the collection banner instead of
  // a real player. Example: collection="Diamond Kings", front-detected
  // name="Diamond King" → bogus, fall back to back-side name. Fully
  // dynamic — driven by the OCR'd collection field, no hardcoded names.
  if (!frontNameBogus && combined.playerFirstName && combined.playerLastName && combined.collection) {
    const stripPlural = (s: string) => s.toLowerCase().replace(/s$/i, '');
    const collTokens = new Set(
      combined.collection.split(/\s+/).map(stripPlural).filter(t => t.length >= 3),
    );
    const nameTokens = `${combined.playerFirstName} ${combined.playerLastName}`
      .split(/\s+/)
      .map(stripPlural)
      .filter(t => t.length >= 3);
    if (nameTokens.length > 0 && collTokens.size > 0 && nameTokens.every(t => collTokens.has(t))) {
      console.log(`Front player name "${combined.playerFirstName} ${combined.playerLastName}" matches collection "${combined.collection}" — treating as bogus (collection text was misread as the player)`);
      frontNameBogus = true;
    }
  }

  // Catalog-driven bogus check: if the front-detected "first last" string
  // appears verbatim as a known parallel/insert/variation name in the
  // card_variations catalog for the same brand+year (e.g. "End Zone" is a
  // 2025 Panini parallel name, not a player), treat the front name as bogus
  // so we fall back to the back-side player name. This is fully dynamic —
  // it relies only on the imported catalog, no hardcoded names.
  if (!frontNameBogus && combined.playerFirstName && combined.playerLastName && combined.brand && combined.year) {
    try {
      const candidate = `${combined.playerFirstName} ${combined.playerLastName}`.trim().toLowerCase();
      const rows = await db
        .select({ name: cardVariations.variationOrParallel })
        .from(cardVariations)
        .where(and(
          sql`LOWER(${cardVariations.brand}) = ${String(combined.brand).toLowerCase()}`,
          eq(cardVariations.year, combined.year as number),
          sql`LOWER(${cardVariations.variationOrParallel}) = ${candidate}`
        ))
        .limit(1);
      if (rows.length > 0) {
        console.log(`Front player name "${combined.playerFirstName} ${combined.playerLastName}" matches a known parallel name in card_variations for ${combined.brand} ${combined.year} — treating as bogus`);
        frontNameBogus = true;
      }
    } catch (err) {
      console.error('Catalog-based player name validation failed:', err);
    }
  }

  // Catalog-driven player check: when the front name doesn't appear in
  // card_database for this brand+year but the back name does, the back is
  // the real player and the front is OCR garbage (e.g. "Jent Im" picked up
  // from the jersey-number area). Driven entirely by the player_name catalog
  // — no hardcoded names. Front-side wins all ties; we only override when
  // the catalog clearly confirms the back name and disconfirms the front.
  if (!frontNameBogus && !backNameBogus &&
      combined.brand && combined.year &&
      backResult.playerFirstName && backResult.playerLastName &&
      combined.playerFirstName && combined.playerLastName &&
      (combined.playerFirstName.toLowerCase() !== backResult.playerFirstName.toLowerCase() ||
       combined.playerLastName.toLowerCase() !== backResult.playerLastName.toLowerCase())) {
    try {
      const frontFull = `${combined.playerFirstName} ${combined.playerLastName}`.trim().toLowerCase();
      const backFull = `${backResult.playerFirstName} ${backResult.playerLastName}`.trim().toLowerCase();
      const brandLower = String(combined.brand).toLowerCase();
      const yearVal = combined.year as number;
      // Pull just the LAST word of each detected last-name field so the
      // catalog lookup tolerates middle names (back OCR may yield the
      // player's full legal name, e.g. "Howard Bruce Sutter", while the
      // catalog stores the common name "Bruce Sutter"). Last-name match
      // alone is a strong signal — there is virtually never a case where
      // two different real players with the same exact last name appear
      // in the same brand+year and OCR would confuse them.
      const lastWord = (s: string) => {
        const tokens = s.trim().toLowerCase().split(/\s+/).filter(Boolean);
        return tokens.length > 0 ? tokens[tokens.length - 1] : '';
      };
      const frontLast = lastWord(combined.playerLastName);
      const backLast = lastWord(backResult.playerLastName);
      const [frontExact, backExact, frontLastHits, backLastHits] = await Promise.all([
        db.select({ id: cardDatabase.id }).from(cardDatabase).where(and(
          sql`LOWER(${cardDatabase.brand}) = ${brandLower}`,
          eq(cardDatabase.year, yearVal),
          sql`LOWER(${cardDatabase.playerName}) = ${frontFull}`
        )).limit(1),
        db.select({ id: cardDatabase.id }).from(cardDatabase).where(and(
          sql`LOWER(${cardDatabase.brand}) = ${brandLower}`,
          eq(cardDatabase.year, yearVal),
          sql`LOWER(${cardDatabase.playerName}) = ${backFull}`
        )).limit(1),
        // Last-name LIKE fallback — only fires when the exact full-name
        // match misses (e.g. middle-name mismatch). Require >=3 chars to
        // avoid spurious matches on initials/very short surnames.
        frontLast.length >= 3
          ? db.select({ id: cardDatabase.id }).from(cardDatabase).where(and(
              sql`LOWER(${cardDatabase.brand}) = ${brandLower}`,
              eq(cardDatabase.year, yearVal),
              sql`LOWER(${cardDatabase.playerName}) LIKE ${'%' + frontLast + '%'}`
            )).limit(1)
          : Promise.resolve([] as { id: number }[]),
        backLast.length >= 3
          ? db.select({ id: cardDatabase.id }).from(cardDatabase).where(and(
              sql`LOWER(${cardDatabase.brand}) = ${brandLower}`,
              eq(cardDatabase.year, yearVal),
              sql`LOWER(${cardDatabase.playerName}) LIKE ${'%' + backLast + '%'}`
            )).limit(1)
          : Promise.resolve([] as { id: number }[]),
      ]);
      const frontInCatalog = frontExact.length > 0 || frontLastHits.length > 0;
      const backInCatalog = backExact.length > 0 || backLastHits.length > 0;
      if (backInCatalog && !frontInCatalog) {
        const matchKind = backExact.length > 0 ? 'full-name' : `last-name "${backLast}"`;
        console.log(`Catalog player check: back name "${backResult.playerFirstName} ${backResult.playerLastName}" found in card_database for ${combined.brand} ${combined.year} via ${matchKind}; front name "${combined.playerFirstName} ${combined.playerLastName}" not found — preferring back`);
        frontNameBogus = true;
      }
    } catch (err) {
      console.error('Catalog-based player name lookup failed:', err);
    }
  }

  if (frontNameBogus && !backNameBogus && backResult.playerFirstName && backResult.playerLastName) {
    console.log(`Front player name "${combined.playerFirstName} ${combined.playerLastName}" is bogus, using back: "${backResult.playerFirstName} ${backResult.playerLastName}"`);
    combined.playerFirstName = backResult.playerFirstName;
    combined.playerLastName = backResult.playerLastName;
  } else if (!frontNameBogus) {
    console.log(`Front player name "${combined.playerFirstName} ${combined.playerLastName}" looks valid — keeping it (front is authoritative for player name)`);
  }
  
  if (!frontNameBogus && !backNameBogus &&
      combined.playerLastName && backResult.playerLastName &&
      combined.playerLastName.toUpperCase() === backResult.playerLastName.toUpperCase() &&
      combined.playerFirstName && backResult.playerFirstName &&
      combined.playerFirstName.toUpperCase() !== backResult.playerFirstName.toUpperCase()) {
    const frontFirst = combined.playerFirstName!;
    const backFirst = backResult.playerFirstName!;
    console.log(`Player first name mismatch: front="${frontFirst}" vs back="${backFirst}" — keeping front name (preferred for eBay search, back often has birth/legal name on older cards)`);
  }
  
  if (frontNameBogus && backNameBogus) {
    const allText = (frontOCRText + '\n' + backOCRText).toUpperCase();
    let nameRecovered = false;

    // Reject candidate name lines that are clearly biographical labels,
    // legal/lenticular text, or obvious OCR garble. Without these guards
    // the recovery loop on vintage Kellogg's 3-D backs was grabbing things
    // like "POSITION CENTER FIELD" → "Position Center", "HOBBIES HUNTING
    // FISHING" → "Hunting Fishing", or lenticular garble like "MAKING
    // LIGLASE" / "ORLIGION LIGENSEL".
    const bioLabelStarts = new Set([
      'POSITION', 'POSITIONS', 'HOBBIES', 'HOBBY', 'BORN', 'BIRTHDATE',
      'BATS', 'THROWS', 'HEIGHT', 'WEIGHT', 'MAJOR', 'LEAGUE', 'RECORD',
      'TOTALS', 'CAREER', 'ACQUIRED', 'DRAFTED', 'SIGNED', 'ATTENDED',
      'COLLEGE', 'HOMETOWN', 'BIRTHPLACE', 'NICKNAME', 'STATS',
    ]);
    const looksLikeNameToken = (w: string): boolean => {
      // Real names virtually always contain a vowel and have a typical
      // consonant/vowel mix. OCR garble like "LIGLASE", "LIGENSEL" tends to
      // have abnormal letter patterns — long consonant runs, no real vowel
      // sequence. Use a permissive heuristic: require >=1 vowel and not
      // more than 4 consecutive consonants.
      if (!/[AEIOUY]/.test(w)) return false;
      if (/[BCDFGHJKLMNPQRSTVWXZ]{5,}/.test(w)) return false;
      return true;
    };

    const lines = allText.split('\n');

    // Find the first line that looks like legal / lenticular / copyright /
    // manufacturer text. Player names virtually always appear ABOVE this
    // marker on a card back; everything below it is bio stats, licensing,
    // or 3-D/lenticular print garble. Anchoring to this boundary
    // explicitly rejects garbled lines (LIGLASE / LIGENSEL / ORLIGION
    // LIGENSEL / etc.) that would otherwise sneak past per-token checks.
    const legalLineMarkers = [
      'XOGRAPH', 'PANOGRAPH', 'VISUAL PANOGRAPHIC', 'LENTICULAR',
      'OFFICIALLY LICENSED', 'OFFICIALLY AUTHORIZED', 'OFFICIAL LICENSE',
      'MLBPA', 'NFLPA', 'NBAPA', 'NHLPA', "PLAYERS ASS", 'PLAYERS ASSN',
      'MADE IN', 'LITHO IN', 'PRINTED IN', 'ALL RIGHTS RESERVED',
      'COPYRIGHT', '©', 'MFG', 'MANUFACTURED', 'KELLOGG',
      "COLLECTOR'S CARD", 'TRADING CARD',
      'CARD NO.', 'CARD NO ', 'NO.', 'STK',
    ];
    let legalBoundary = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const u = lines[i].toUpperCase();
      if (legalLineMarkers.some(m => u.includes(m))) { legalBoundary = i; break; }
    }

    // Strip surrounding non-letter chars from a token so nickname
    // wrappers — parens, single/double/curly quotes, asterisks — don't
    // disqualify the line. Examples:
    //   '"CATFISH"' → 'CATFISH'
    //   '(CATFISH)' → 'CATFISH'
    //   '*CATFISH*' → 'CATFISH'
    const stripWrappers = (w: string): string =>
      w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');

    for (let i = 0; i < lines.length; i++) {
      // Skip everything from the legal-text boundary downward.
      if (i >= legalBoundary) break;

      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;

      let nameCandidate = trimmed;
      const firstWord = trimmed.split(/\s+/)[0];
      if (/^[A-Z0-9]+-\d+$/.test(firstWord) || /^\d+[A-Z]\d*-\d+$/.test(firstWord)) {
        nameCandidate = trimmed.substring(firstWord.length).trim();
      }

      // Tokenise then strip wrappers from each token; drop any tokens
      // that are entirely non-alphabetic after stripping (orphan
      // punctuation, lone digits, etc).
      const rawWords = nameCandidate.split(/\s+/).filter(w => w.length > 0);
      const words = rawWords.map(stripWrappers).filter(w => w.length > 0);

      // Allow 2-4 tokens. 4 tokens covers vintage nameplates that print
      // a quoted nickname between first and last (e.g. JIM "CATFISH"
      // HUNTER → 3 tokens after stripping; JAMES AUGUSTUS "CATFISH"
      // HUNTER → 4 tokens after stripping). When >2 tokens we take the
      // first as playerFirstName and the LAST as playerLastName,
      // dropping the middle nickname/middle-name tokens — the catalog
      // stores players under their primary first+last, and the
      // downstream front-surname catalog search will still see the
      // dropped nickname token via extractFrontSurnames.
      if (words.length >= 2 && words.length <= 4) {
        const allAlpha = words.every(w => /^[A-Z]{2,}$/.test(w));
        const noBogus = words.every(w => !bogusNameWords.has(w));
        const noNumbers = words.every(w => !/\d/.test(w));
        // Reject lines that begin with a biographical label or contain a
        // colon-separated label anywhere ("BATS: RIGHT", "POSITION: 3B").
        const startsWithBioLabel = bioLabelStarts.has(words[0].replace(/[:.,]+$/, ''));
        const hasColonLabel = /[A-Z]+:/.test(trimmed);
        const allLookLikeNames = words.every(w => looksLikeNameToken(w));
        // Reject overlong tokens — real first/last name tokens on cards
        // are almost always 3-12 letters. Lenticular-print garble from
        // 3-D card backs frequently produces 13+ letter pseudo-words.
        const reasonableLength = words.every(w => w.length >= 2 && w.length <= 12);

        if (allAlpha && noBogus && noNumbers && !startsWithBioLabel && !hasColonLabel && allLookLikeNames && reasonableLength) {
          const firstTok = words[0];
          const lastTok = words[words.length - 1];
          combined.playerFirstName = firstTok.charAt(0) + firstTok.slice(1).toLowerCase();
          combined.playerLastName = lastTok.charAt(0) + lastTok.slice(1).toLowerCase();
          if (words.length > 2) {
            console.log(`Recovered player name from OCR text: ${combined.playerFirstName} ${combined.playerLastName} (from line: "${trimmed}", dropped middle/nickname tokens: ${words.slice(1, -1).join(', ')})`);
          } else {
            console.log(`Recovered player name from OCR text: ${combined.playerFirstName} ${combined.playerLastName} (from line: "${trimmed}")`);
          }
          nameRecovered = true;
          break;
        }
      }
    }
    
    if (!nameRecovered) {
      // Apply the same legal-boundary + bio-label + garble guards as the
      // primary recovery loop above. Without them this fallback can
      // re-introduce known-bad lines like "POSITION CENTER FIELD" or
      // lenticular garble from below the legal-text boundary.
      const candidateLines = lines.slice(0, legalBoundary).join('\n');
      // Allow nickname wrappers between/around tokens: "JIM "CATFISH" HUNTER",
      // "JIM (CATFISH) HUNTER", etc. Tokens may carry surrounding non-letter
      // chars; we strip them after matching.
      const nameLineMatch = candidateLines.match(
        /^[^A-Za-z\n]*([A-Z][A-Z]+)(?:[^A-Za-z\n]+([A-Z][A-Z]+)){1,3}[^A-Za-z\n]*$/m,
      );
      if (nameLineMatch) {
        const rawWords = nameLineMatch[0].trim().split(/\s+/);
        const words = rawWords
          .map(w => w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, ''))
          .filter(w => w.length > 0);
        const noBogusFn = words.every(w => !bogusNameWords.has(w));
        const startsWithBioLabel = bioLabelStarts.has(words[0].replace(/[:.,]+$/, ''));
        const hasColonLabel = /[A-Z]+:/.test(nameLineMatch[0]);
        const allLookLikeNames = words.every(w => looksLikeNameToken(w));
        const reasonableLength = words.every(w => w.length >= 2 && w.length <= 12);

        if (noBogusFn && words.length >= 2 && words.length <= 4 && !startsWithBioLabel && !hasColonLabel && allLookLikeNames && reasonableLength) {
          const firstTok = words[0];
          const lastTok = words[words.length - 1];
          combined.playerFirstName = firstTok.charAt(0) + firstTok.slice(1).toLowerCase();
          combined.playerLastName = lastTok.charAt(0) + lastTok.slice(1).toLowerCase();
          console.log(`Recovered player name from OCR text (fallback): ${combined.playerFirstName} ${combined.playerLastName}${words.length > 2 ? ` (dropped middle/nickname tokens: ${words.slice(1, -1).join(', ')})` : ''}`);
        }
      }
    }
  }
  
  if (!combined.collection) {
    const allText = (frontOCRText + ' ' + backOCRText).toUpperCase();
    
    if (/ANNIV.*ERSARY|35TH\s*ANNIVERSARY/i.test(allText) || 
        (allText.includes('ANNIV') && allText.includes('ERSARY')) ||
        (allText.includes('35') && (allText.includes('ANNIV') || allText.includes('ANNIVERSARY')))) {
      combined.collection = '35th Anniversary';
      console.log('Detected collection from fragmented OCR text: 35th Anniversary');
    }
  }

  // ── Product-line extractor ────────────────────────────────────────────
  // Authoritative source for cardData.set. Reads the back-of-card
  // copyright line ("2020 PANINI - ORIGINS FOOTBALL") and the front
  // wordmark against a whitelist of current Panini/Topps/Bowman/UD
  // product lines. This fires BEFORE the DB lookup so the DB gets a
  // correctly-scoped brand+set when possible, and fires regardless of
  // whether OCR/Holo already guessed a set — if the back copyright line
  // resolves, it overrides, because that line is the most reliable
  // on-card identifier.
  {
    const productLine = extractProductLine(frontOCRText, backOCRText, combined.brand);
    if (productLine) {
      const isBackCopyright = productLine.source === 'back-copyright';
      const oldSet = combined.set;
      const oldBrand = combined.brand;
      // Back copyright line overrides; front/back wordmark only fills when empty.
      if (isBackCopyright || !combined.set) {
        combined.set = productLine.productLine;
      }
      // Brand: only fill when empty — OCR's brand read is usually fine.
      if (!combined.brand) {
        combined.brand = productLine.brand;
      }
      console.log(`[ProductLine] ${productLine.source} → brand="${productLine.brand}" product="${productLine.productLine}" (evidence: "${productLine.evidence}")`);
      if (oldSet && oldSet !== combined.set) {
        console.log(`[ProductLine] Overrode prior set "${oldSet}" → "${combined.set}" (back copyright line is authoritative).`);
      }
      if (oldBrand !== combined.brand) {
        console.log(`[ProductLine] Filled brand "${oldBrand || '(empty)'}" → "${combined.brand}".`);
      }
    } else {
      console.log('[ProductLine] No match from back copyright line, front wordmark, or back wordmark scan.');
    }
  }

  // ─── H-4: Set/collection dedupe ─────────────────────────────────────────
  // When the product-line extractor wrote the set (e.g. "Series One") AND the
  // earlier OCR/wordmark pass wrote the same string as the collection, the
  // two fields duplicate and both show up in the UI. The set is the
  // authoritative product line; collection should come from the catalog
  // ("Rookie Debut", "1989 All-Stars", etc.) — not repeat the set name. Clear
  // it here and let the upcoming CardDB lookup fill it authoritatively.
  if (
    combined.set &&
    combined.collection &&
    combined.set.trim().toLowerCase() === combined.collection.trim().toLowerCase()
  ) {
    console.log(`[ProductLine] Clearing duplicate collection "${combined.collection}" — same as set "${combined.set}". CardDB will fill collection if applicable.`);
    combined.collection = '';
  }

  // Handle other fields with no specific priority
  const otherFields: (keyof CardFormValues)[] = [
    'condition', 'estimatedValue', 'isAutographed', 'isNumbered', 'notes'
  ];
  
  otherFields.forEach(field => {
    if (frontResult[field] !== undefined && frontResult[field] !== null) {
      combined[field] = frontResult[field];
    } else if (backResult[field] !== undefined && backResult[field] !== null) {
      combined[field] = backResult[field];
    }
  });
  
  console.log('Combined result sport:', combined.sport);
  
  if (combined.serialNumber && /\d+\/\d+/.test(combined.serialNumber) && !combined.isNumbered) {
    combined.isNumbered = true;
    console.log(`Set isNumbered=true based on serial number: ${combined.serialNumber}`);
  }

  // ─── Card Database Lookup ───────────────────────────────────────────────────
  // Use authoritative DB data when OCR successfully detected brand + year + card number.
  // DB provides: player name, team, rookie flag, collection, variation.
  // OCR foil/serial/condition data is preserved and not overwritten.
  // dbVariation is stashed here and applied AFTER visual/text foil detection as a fallback.
  let dbVariation: string | null = null;
  // Set to true when the catalog confirmed a card hit but no parallel
  // variation row matched the serial-number rule (no detected serial → no
  // NULL-serial row; serial detected → no matching limit row). Per the rule,
  // the catalog is authoritative: any foilType assigned by visual / text /
  // regional detectors should be cleared at the end of the pipeline.
  let dbConfirmsNoParallel = false;

  const applyDbResult = (dbResult: any, label: string): boolean => {
    console.log(`[CardDB] ${label} — ${dbResult.playerFirstName} ${dbResult.playerLastName}, team: ${dbResult.team}, collection: ${dbResult.collection}, cardNumber: ${dbResult.cardNumber}`);
    const ocrName = `${combined.playerFirstName || ''} ${combined.playerLastName || ''}`.trim();
    const dbName  = `${dbResult.playerFirstName || ''} ${dbResult.playerLastName || ''}`.trim();
    if (ocrName.toLowerCase() !== dbName.toLowerCase()) {
      // Reject DB hit when OCR clearly read a *different* last name. The most common
      // cause is a mis-read card number on the back — for example John Franco's 1990
      // Leaf back was OCR'd with cardNumber=322 (the actual Franco is #356), and the
      // DB legitimately has Rob Deer at Leaf 1990 #322. Trusting the DB in that
      // situation overwrites correctly-read OCR fields with a totally different
      // player. We allow partial overlap (substrings, e.g. OCR "Mike Trout Jr" vs
      // DB "Mike Trout") so legitimate name-cleanup still works.
      const ocrLast = (combined.playerLastName || '').trim().toLowerCase();
      const ocrFirst = (combined.playerFirstName || '').trim().toLowerCase();
      const dbLast  = (dbResult.playerLastName || '').trim().toLowerCase();
      const lastNamesOverlap = !!ocrLast && !!dbLast && (
        ocrLast === dbLast ||
        ocrLast.includes(dbLast) ||
        dbLast.includes(ocrLast)
      );
      const ocrHasNoName = !ocrLast;
      // Treat OCR names made entirely of common English stopwords as bogus
      // (e.g. "Is No" pulled from "JERSEY NUMBER IS NO. 00" on a Mr. Met
      // card back). When the OCR "name" is junk like this, trust the DB
      // match instead of rejecting it. Real player names virtually never
      // consist of nothing but common short English words.
      const englishStopwordNameParts = new Set([
        'is', 'no', 'in', 'on', 'at', 'to', 'by', 'it', 'he', 'as', 'or', 'an',
        'if', 'so', 'up', 'us', 'we', 'my', 'me', 'am', 'go', 'do', 'be', 'his',
        'her', 'has', 'had', 'but', 'who', 'why', 'how', 'our', 'out', 'not',
        'yes', 'yet', 'all', 'any', 'now', 'too', 'was', 'are', 'when', 'where',
        'what', 'been', 'have', 'will', 'the', 'and', 'for', 'with', 'from',
        'that', 'this',
        // Legal/licensing/manufacturing words and team-name fragments —
        // when these appear as the OCR'd "player name" the OCR clearly
        // latched onto the bottom-of-card legal text or the team banner,
        // so the DB hit on (brand+year+cardNumber) should be trusted
        // rather than rejected.
        'official', 'officially', 'license', 'licensed', 'licensel', 'licensee',
        'authorized', 'copyright', 'trademark', 'reserved', 'rights',
        'insignia', 'panographic', 'panographics', 'xograph', 'xographo',
        'kellogg', 'kelloggs', 'visual', 'mlbpa', 'nflpa', 'nbapa', 'nhlpa',
        'players', 'assn', 'san', 'francisco', 'giants', 'yankees', 'dodgers',
        'mets', 'cubs', 'braves', 'astros', 'rangers', 'padres', 'cardinals',
        'nationals', 'orioles', 'guardians', 'twins', 'rays', 'marlins',
        'pirates', 'reds', 'brewers', 'tigers', 'royals', 'athletics',
        'mariners', 'angels', 'rockies', 'diamondbacks', 'phillies', 'sox',
        'red', 'white', 'blue', 'jays',
      ]);
      const isBogusOcrWord = (w: string) => !w || englishStopwordNameParts.has(w);
      // ocrNameLooksBogus is true when EITHER name token is a known
      // bogus word OR is too short to be a real name token (≤ 2 chars
      // catches stat-line fragments like "Nl" pulled from "1977 SAN
      // DIEGO NL"). Real player full-name pairs virtually never have a
      // 1-2 char surname.
      const ocrNameLooksBogus = !!ocrLast && !!ocrFirst &&
        (isBogusOcrWord(ocrFirst) || isBogusOcrWord(ocrLast) ||
         ocrFirst.length <= 2 || ocrLast.length <= 2);
      // When the catalog probe already validated the exact
      // (brand, year, cardNumber) triple exists in card_database, the
      // DB hit on that same triple IS the correct card — the OCR name
      // disagreement is irrelevant because the card number was
      // catalog-confirmed, not jersey-numbered.
      const catalogValidated = !!(combined as CardFormWithFlags)._yearFromCatalogProbe;
      if (catalogValidated) {
        console.log(`[CardDB] Catalog-probe validated (brand+year+cardNumber); trusting DB match "${dbResult.playerFirstName} ${dbResult.playerLastName}" over OCR "${combined.playerFirstName} ${combined.playerLastName}".`);
      } else if (ocrNameLooksBogus) {
        console.log(`[CardDB] OCR name "${combined.playerFirstName} ${combined.playerLastName}" looks like English prose, not a real name — trusting DB match "${dbResult.playerFirstName} ${dbResult.playerLastName}".`);
      } else if (!lastNamesOverlap && !ocrHasNoName) {
        console.log(`[CardDB] DB row REJECTED — OCR last name "${combined.playerLastName}" disagrees with DB "${dbResult.playerLastName}". OCR card number is likely wrong; falling back to OCR-only data to avoid corrupting player identity.`);
        return false;
      }
      console.log(`[CardDB] OCR name "${ocrName}" differs from DB "${dbName}" — trusting DB (last names overlap or OCR had no name)`);
    }
    if (dbResult.playerFirstName) combined.playerFirstName = dbResult.playerFirstName;
    if (dbResult.playerLastName)  combined.playerLastName  = dbResult.playerLastName;
    if (dbResult.team && !combined.notes) combined.notes = `Team: ${dbResult.team}`;
    if (dbResult.collection) combined.collection = dbResult.collection;
    if (dbResult.cardNumber) combined.cardNumber = dbResult.cardNumber;
    if (dbResult.cmpNumber) combined.cmpNumber = dbResult.cmpNumber;
    if (dbResult.set) combined.set = dbResult.set;
    if (dbResult.isRookieCard) combined.isRookieCard = true;
    if (dbResult.year) combined.year = dbResult.year;
    if (dbResult.serialNumber && !combined.serialNumber) {
      combined.serialNumber = dbResult.serialNumber;
      if (/\/\d+/.test(dbResult.serialNumber)) combined.isNumbered = true;
    }
    if (dbResult.variation) {
      dbVariation = dbResult.variation;
      console.log(`[CardDB] Stashed DB variation for foil fallback: "${dbResult.variation}"`);
    }
    if (dbResult.variationAmbiguous && dbResult.variationOptions?.length) {
      (combined as CardFormWithFlags)._variationAmbiguous = true;
      (combined as CardFormWithFlags)._variationOptions = dbResult.variationOptions;
      console.log(`[CardDB] Variation ambiguous (${dbResult.variationOptions.length} options) — needs user confirmation: ${dbResult.variationOptions.join(' | ')}`);
    } else if (!dbResult.variation) {
      // Catalog confirmed the card but had no parallel matching the serial-number rule.
      // Mark so the post-detection pipeline clears any visual/text-detected foilType.
      dbConfirmsNoParallel = true;
      console.log('[CardDB] Catalog confirms no parallel for this card — will clear any detector-assigned foilType.');
    }
    if (dbResult.collectionAmbiguous && dbResult.collectionCandidates?.length) {
      (combined as CardFormWithFlags)._collectionAmbiguous = true;
      (combined as CardFormWithFlags)._collectionCandidates = dbResult.collectionCandidates;
      console.log(`[CardDB] Collection ambiguous (${dbResult.collectionCandidates.length} candidates) — needs user pick`);
    }
    // Signal success so callers (e.g. the year-widening fallback loop) stop
    // trying additional years. Without this the function falls through to
    // `undefined` which tryLookup treats as failure, causing the loop to keep
    // overwriting `combined` with later-year matches.
    return true;
  };

  const ocrPlayerFirst = (combined.playerFirstName || '').trim().toLowerCase();
  const ocrPlayerLast  = (combined.playerLastName  || '').trim().toLowerCase();

  // Concatenate front + back OCR text for the generic vocabulary tiebreaker
  // in lookupCard. Any DB collection/set name printed on the card (subset
  // banners like "FUTURE STARS", "CHROME UPDATE", etc.) will be picked up
  // here without needing to be hand-coded into the OCR pattern list.
  const combinedOcrText = [frontOCRText, backOCRText].filter(Boolean).join(' \n ');

  const tryLookup = async (brand: any, year: any, cardNumber: any, collection: any, opts?: { requireNameMatch?: boolean }): Promise<boolean> => {
    const result = await lookupCard({
      brand, year, cardNumber, collection,
      serialNumber: combined.serialNumber,
      playerLastName: combined.playerLastName,
      ocrText: combinedOcrText,
    });
    if (result.found) {
      if (opts?.requireNameMatch) {
        const dbFirst = (result.playerFirstName || '').trim().toLowerCase();
        const dbLast  = (result.playerLastName  || '').trim().toLowerCase();
        const lastMatch = ocrPlayerLast && dbLast && (
          ocrPlayerLast === dbLast ||
          ocrPlayerLast.startsWith(dbLast) ||
          dbLast.startsWith(ocrPlayerLast)
        );
        if (!lastMatch) {
          console.log(`[CardDB] Fallback match rejected — DB player "${result.playerFirstName} ${result.playerLastName}" doesn't match OCR "${combined.playerFirstName} ${combined.playerLastName}" (fallback card number may be jersey number)`);
          return false;
        }
      }
      // applyDbResult returns false if it rejects the row (e.g. last name disagrees
      // with OCR). Propagate that so the caller can try fallback lookups.
      return applyDbResult(result, `DB hit`);
    }
    return false;
  };

  // ─── Catalog-validated year selection ──────────────────────────────────
  // Vintage card backs frequently print multiple © markers — a publisher
  // line (e.g. "©1981 VISUAL PANOGRAPHICS, INC.") plus a licensing-org
  // line (e.g. "©1968 MLBPA ASS'N.", often OCR-misread as ©1988). The
  // per-side year detection picks Math.max of those © years and lands on
  // the wrong year, which then breaks the catalog lookup.
  //
  // Strategy: extract every plausible year-near-copyright candidate from
  // both sides of the OCR text, then probe card_database with
  // (brand, cardNumber, year). The year that the catalog actually has a
  // row for is the production year — regardless of which © the Math.max
  // picker chose. If no candidate year produces a hit, leave combined.year
  // alone so the existing ±1/±5 widening fallback in tryLookup runs.
  // Extract clean surname candidates from the FRONT OCR text. The
  // front of a card almost always shows the player's name in large
  // type, often repeated (logo + nameplate). Even when the back-side
  // OCR latches onto bottom-of-card legal text or stat-line prose,
  // the front gives us a high-signal surname we can use to validate
  // — or override — the catalog probe. Pure heuristic, no hardcoded
  // names: take all-caps tokens of length ≥ 4 from the front, drop
  // anything in our bogus-word set, dedupe, prefer tokens that
  // appear ≥ 2 times.
  const extractFrontSurnames = (frontText: string): string[] => {
    const tokens = (frontText.toUpperCase().match(/[A-Z]{4,}/g) || [])
      .map(t => t.replace(/(?:TM|™|®)$/g, ''));
    const counts = new Map<string, number>();
    for (const t of tokens) {
      if (bogusNameWords.has(t)) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    // Prefer repeated tokens (player name on front nameplate +
    // banner). If nothing repeats, take all single-occurrence
    // tokens too — the front may print the name only once.
    const repeated = Array.from(counts.entries()).filter(([, c]) => c >= 2).map(([t]) => t);
    if (repeated.length > 0) return repeated;
    return Array.from(counts.keys());
  };
  const frontSurnames = extractFrontSurnames(frontOCRText);

  // Tracks whether the brand+year+cardNumber catalog probe below
  // produced ANY catalog row. When it did not, the OCR-derived
  // (brand, year, cardNumber) tuple is wrong and the downstream
  // front-surname catalog search should run as a salvage pass even
  // if the back-side surname looked usable.
  let yearProbeFoundCatalogHit = false;

  if (combined.brand && combined.cardNumber) {
    try {
      const allOcrText = `${frontOCRText}\n${backOCRText}`;
      const ocrCandidates = extractAllYearCandidates(allOcrText);
      const candidateSet = new Set<number>(ocrCandidates);
      if (combined.year && Number(combined.year) > 0) candidateSet.add(Number(combined.year));
      // When the chosen year is low-confidence (came from a copyright line on
      // the back, or only the back side had a year at all), seed the
      // candidate set with year±1. Modern card backs frequently print the
      // prior-year copyright on cards sold the following year — the most
      // common manifestation is "© 2003" appearing on a 2004 product.
      // Without this, the catalog probe below sees a single OCR-derived
      // year and skips the surname-vs-catalog disambiguation entirely;
      // the lookup then locks onto a wrong-player row at the printed year
      // and the downstream rejection-+-±1-fallback can also miss when the
      // wrong-year row has the same OCR-vocab signal (e.g. "ULTRA") as the
      // right-year row. Adding ±1 here lets the surname disambiguator below
      // pick the year whose row actually matches the OCR player.
      const yearLooksLowConfidence =
        !!(combined as any)._yearFromCopyright || !!(combined as any)._yearFromBackOnly;
      const seedYear = Number(combined.year || 0);
      if (yearLooksLowConfidence && seedYear > 0) {
        candidateSet.add(seedYear + 1);
        candidateSet.add(seedYear - 1);
      }
      const uniqueCandidates = Array.from(candidateSet).filter(y => y > 0);
      // Always probe whatever single candidate year we have so we know
      // whether (brand, year, cardNumber) actually exists in the
      // catalog. If it doesn't, the surname-search salvage pass below
      // will fire even when only one year was in play.
      //
      // The flag is gated on PLAYER-NAME agreement, not just row
      // presence: a probe that returns a different player at the same
      // (brand, year, cardNumber) means the OCR cardNumber is wrong,
      // and we still want the salvage pass to fire and search the
      // catalog by surname. Sport-/player-agnostic — surname comes
      // from OCR only.
      if (uniqueCandidates.length === 1) {
        const brandLower = String(combined.brand).toLowerCase();
        const cardNumLower = String(combined.cardNumber).toLowerCase();
        const probeRows = await db
          .select({ name: cardDatabase.playerName })
          .from(cardDatabase)
          .where(and(
            sql`lower(${cardDatabase.brand}) = ${brandLower}`,
            eq(cardDatabase.year, uniqueCandidates[0]),
            sql`lower(${cardDatabase.cardNumberRaw}) = ${cardNumLower}`,
          ))
          .limit(5);
        const ocrSurnames: string[] = [];
        const backLast = (combined.playerLastName || '').trim().toLowerCase().split(/\s+/).pop() || '';
        if (backLast.length >= 4 && !bogusNameWords.has(backLast.toUpperCase())) ocrSurnames.push(backLast);
        for (const fs of frontSurnames) {
          const fl = fs.toLowerCase();
          if (fl.length >= 4 && !ocrSurnames.includes(fl)) ocrSurnames.push(fl);
        }
        const nameAgrees = probeRows.some(r =>
          ocrSurnames.some(sn => (r.name || '').toLowerCase().includes(sn))
        );
        yearProbeFoundCatalogHit = probeRows.length > 0 && (ocrSurnames.length === 0 || nameAgrees);
        if (probeRows.length > 0 && ocrSurnames.length > 0 && !nameAgrees) {
          console.log(`[Year] Single-year probe found ${probeRows.length} row(s) at (${combined.brand}, ${uniqueCandidates[0]}, #${cardNumLower}) but none matched OCR surname [${ocrSurnames.join('|')}] (DB names: ${probeRows.map(r => r.name).join(', ')}) — keeping salvage open.`);
        }
      }
      if (uniqueCandidates.length >= 2) {
        const brandLower = String(combined.brand).toLowerCase();
        const cardNumLower = String(combined.cardNumber).toLowerCase();
        // Use front-side surname when the back-side OCR didn't yield
        // a usable last name (or yielded bogus legal/stat text).
        const backSurname = (combined.playerLastName || '').trim().toLowerCase();
        const backSurnameUsable = backSurname.length >= 3 &&
          !bogusNameWords.has(backSurname.toUpperCase());
        const surname = backSurnameUsable
          ? backSurname
          : (frontSurnames[0] || '').toLowerCase();
        if (!backSurnameUsable && surname) {
          console.log(`[Year] Using front-side surname "${surname}" for catalog probe disambiguation (back-side surname "${combined.playerLastName || '(none)'}" was bogus or missing).`);
        }
        const probes = await Promise.all(uniqueCandidates.map(async (y) => {
          const rows = await db
            .select({ name: cardDatabase.playerName })
            .from(cardDatabase)
            .where(and(
              sql`lower(${cardDatabase.brand}) = ${brandLower}`,
              eq(cardDatabase.year, y),
              sql`lower(${cardDatabase.cardNumberRaw}) = ${cardNumLower}`,
            ))
            .limit(5);
          return { year: y, rows };
        }));
        const hits = probes.filter(p => p.rows.length > 0);
        const probeSummary = probes.map(p => `${p.year}=${p.rows.length}`).join(' ');
        if (hits.length > 0) yearProbeFoundCatalogHit = true;

        // Non-catalog defensive fallback: if NO candidate year produces a
        // catalog hit, we still have multiple © years on the card and the
        // existing picker just took Math.max. Prefer the year that is
        // adjacent to a publisher imprint (Topps/Bowman/Fleer/Donruss/
        // Score/Upper Deck/Panini/Visual Panographics/Xograph/Kellogg/Leaf)
        // over one adjacent only to a licensing organisation
        // (MLBPA/NFLPA/NBAPA/NHLPA/players association). This is a
        // deterministic, sport-agnostic heuristic — no hardcoded card or
        // player rules.
        if (hits.length === 0 && uniqueCandidates.length >= 2) {
          const publisherRe = /(TOPPS|LEAF|BOWMAN|FLEER|DONRUSS|SCORE|UPPER\s+DECK|PANINI|VISUAL\s+PANOGRAPHIC|XOGRAPH|KELLOGG)/i;
          const licensingRe = /(MLBPA|NFLPA|NBAPA|NHLPA|PLAYERS\s+ASS)/i;
          const score = (y: number): { pub: boolean; lic: boolean } => {
            // Look at a small window of characters around each occurrence
            // of the year in the OCR text and check what brand-ish words
            // appear nearby.
            let pub = false, lic = false;
            const re = new RegExp(`\\b${y}\\b`, 'g');
            let m: RegExpExecArray | null;
            while ((m = re.exec(allOcrText)) !== null) {
              const start = Math.max(0, m.index - 40);
              const end = Math.min(allOcrText.length, m.index + 4 + 40);
              const window = allOcrText.slice(start, end);
              if (publisherRe.test(window)) pub = true;
              if (licensingRe.test(window)) lic = true;
            }
            return { pub, lic };
          };
          const scored = uniqueCandidates.map(y => ({ year: y, ...score(y) }));
          const publisherOnly = scored.filter(s => s.pub && !s.lic);
          if (publisherOnly.length > 0) {
            const best = publisherOnly.reduce((a, b) => (b.year > a.year ? b : a));
            const existing = Number(combined.year || 0);
            if (best.year !== existing) {
              console.log(`[Year] Publisher-adjacency override (no catalog hit): ${existing || '(none)'} → ${best.year}. Scored: ${scored.map(s => `${s.year}{pub:${s.pub},lic:${s.lic}}`).join(' ')}`);
              combined.year = best.year;
              const flagged = combined as CardFormWithFlags;
              flagged._yearFromCopyright = true;
              flagged._yearFromBareFallback = false;
            }
          }
        }

        if (hits.length > 0) {
          let chosen = hits[0];
          let reason = '';
          if (hits.length === 1) {
            reason = `only catalog-confirmed candidate of [${uniqueCandidates.join(', ')}]`;
          } else {
            const surnameHits = surname.length >= 3
              ? hits.filter(h => h.rows.some(r => r.name.toLowerCase().includes(surname)))
              : [];
            if (surnameHits.length === 1) {
              chosen = surnameHits[0];
              reason = `surname "${surname}" matched only ${chosen.year} among ${hits.length} catalog-confirmed candidates`;
            } else {
              // Catalog-vocabulary surname salvage: when the OCR-extracted
              // surname is empty/bogus (e.g. picked from "YEAR TEAM" stat-
              // table headers) or matches multiple years, scan the FULL
              // OCR text (front + back) for each candidate row's surname.
              // The DB itself is the vocabulary — no hardcoded names. If
              // exactly one year has a row whose surname appears verbatim
              // in the OCR text, that year is the right one.
              const allOcrLower = allOcrText.toLowerCase();
              const splitSurname = (full: string): string => {
                // "Ken Griffey, Jr." → "griffey"; "Eric Chavez" → "chavez";
                // "Barry Larkin / Ken Griffey Jr." → take first half's surname.
                const head = full.split('/')[0];
                const cleaned = head.replace(/[,.]/g, '').trim();
                const parts = cleaned.split(/\s+/).filter(p => p.length > 0);
                // Strip trailing suffixes (Jr/Sr/II/III/IV) so we land on the actual surname.
                const suffixes = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
                while (parts.length > 1 && suffixes.has(parts[parts.length - 1].toLowerCase())) {
                  parts.pop();
                }
                return parts.length > 0 ? parts[parts.length - 1].toLowerCase() : '';
              };
              const ocrTextHits = hits.filter(h =>
                h.rows.some(r => {
                  const sn = splitSurname(r.name);
                  if (sn.length < 4) return false; // avoid 2-3 letter false positives
                  return new RegExp(`\\b${sn.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`).test(allOcrLower);
                })
              );
              if (ocrTextHits.length === 1) {
                chosen = ocrTextHits[0];
                const matchedRow = chosen.rows.find(r => {
                  const sn = splitSurname(r.name);
                  return sn.length >= 4 && new RegExp(`\\b${sn}\\b`).test(allOcrLower);
                });
                reason = `catalog-vocab surname "${matchedRow ? splitSurname(matchedRow.name) : '?'}" found in OCR text — only ${chosen.year} among ${hits.length} catalog-confirmed candidates has a matching row`;
                if (chosen.year !== Number(combined.year)) {
                  console.log(`[Year] Catalog-vocab surname salvage: OCR text contains "${matchedRow?.name}" → year ${chosen.year}.`);
                }
              } else {
              // Surname doesn't disambiguate (or matches none). Prefer
              // years extracted directly from the OCR text (via
              // copyright/publisher proximity in
              // extractAllYearCandidates) over the per-side picker's
              // guess — the per-side picker sometimes lands on a year
              // that doesn't appear on the card at all. Within that
              // preferred set choose the EARLIEST year (vintage
              // copyright lag almost always means the production year
              // is the lowest © stamped on the card).
              const existing = Number(combined.year || 0);
              const ocrGroundedHits = hits.filter(h => ocrCandidates.includes(h.year));
              if (ocrGroundedHits.length > 0) {
                chosen = ocrGroundedHits.reduce((a, b) => (b.year < a.year ? b : a));
                reason = `earliest OCR-grounded year among ${hits.length} catalog-confirmed candidates (per-side picker guess ${existing} ${ocrCandidates.includes(existing) ? 'is' : 'is NOT'} OCR-grounded)`;
              } else {
                chosen = hits.find(h => h.year === existing) ?? hits.reduce((a, b) => (b.year > a.year ? b : a));
                reason = `latest among ${hits.length} catalog-confirmed candidates (no OCR-grounded year hit)`;
              }
              }
            }
          }
          if (chosen.year !== Number(combined.year)) {
            console.log(`[Year] Catalog-validated year override: ${combined.year || '(none)'} → ${chosen.year} (${reason}). Probes: ${probeSummary}`);
            combined.year = chosen.year;
            // Catalog probe is the strongest year signal we have — clear
            // any low-confidence flags so downstream year-widening doesn't
            // wander off-year.
            const flagged = combined as CardFormWithFlags;
            flagged._yearFromCatalogProbe = true;
            flagged._yearFromBackOnly = false;
            flagged._yearFromCopyright = false;
            flagged._yearFromBareFallback = false;
          } else {
            console.log(`[Year] Catalog-validated year confirms existing pick ${combined.year}. Probes: ${probeSummary}`);
          }
        }
      }
    } catch (err) {
      console.error('[Year] Catalog-validated year resolution failed (non-fatal):', err);
    }
  }

  // ─── Front-surname-driven catalog search ──────────────────────────────────
  // The back-side card-number extractor sometimes latches onto prose
  // numbers (e.g. "A FORMER NO. 1 DRAFT CHOICE OF THE OAKLAND A'S"
  // → cardNumber="1") when the real card number is buried in trailing
  // publisher text ("SERIES OF 66 - NO. 35"). When the front clearly
  // shows the player's surname, we can search the catalog for that
  // surname directly within candidate brand/year combos and recover
  // the correct cardNumber. This is sport-/player-agnostic — it's a
  // pure DB lookup using the front-OCR surname as the constraint.
  //
  // Only run when:
  //   - we extracted a clean front surname (≥ 4 chars, not bogus)
  //   - the back-side surname (combined.playerLastName) was bogus or
  //     missing (otherwise we'd already have a strong DB match path)
  //   - we have a brand and at least one candidate year
  if (combined.brand) {
    try {
      const backSurnameRaw = (combined.playerLastName || '').trim();
      // Use the LAST token of playerLastName (handles "Jack Schmidt"
      // → "schmidt"; the catalog stores "Mike Schmidt" / "Michael
      // Jack Schmidt" so a LIKE %schmidt% query catches all).
      const backSurnameLastToken = (backSurnameRaw.split(/\s+/).pop() || '').toLowerCase();
      const backSurnameUsable = backSurnameLastToken.length >= 4 &&
        !bogusNameWords.has(backSurnameLastToken.toUpperCase());

      // Surname candidates to try, in priority order. Prefer
      // back-side surname (more reliable when present and clean)
      // then fall back to front-side tokens.
      const surnameCandidates: string[] = [];
      if (backSurnameUsable) surnameCandidates.push(backSurnameLastToken);
      for (const fs of frontSurnames) {
        const fsLower = fs.toLowerCase();
        if (!surnameCandidates.includes(fsLower)) surnameCandidates.push(fsLower);
      }

      // Run this pass when ANY of:
      //   (a) cardNumber is missing — we need to recover it from the catalog
      //   (b) back-side surname was bogus — we need front-surname to find
      //       the right card
      //   (c) we have brand+year+cardNumber but the catalog has NO row for
      //       that tuple — the OCR-derived tuple is wrong (Catfish Hunter
      //       case: brand=TCMA, year=2012, #25 is unknown, but searching
      //       by surname=catfish/hunter would salvage the correct row)
      const cardNumberMissing = !combined.cardNumber || String(combined.cardNumber).trim().length === 0;
      const tupleMissedCatalog = !!combined.brand && !!combined.cardNumber && !yearProbeFoundCatalogHit;
      const shouldRun = surnameCandidates.length > 0 && (cardNumberMissing || !backSurnameUsable || tupleMissedCatalog);

      if (shouldRun) {
        const allOcrText = `${frontOCRText}\n${backOCRText}`;
        const yearCandidates = extractAllYearCandidates(allOcrText);
        if (combined.year && Number(combined.year) > 0) yearCandidates.push(Number(combined.year));
        const uniqueYears = Array.from(new Set(yearCandidates)).filter(y => y > 0);
        const brandLower = String(combined.brand).toLowerCase();

        // When the (brand, year, cardNumber) tuple missed the catalog
        // entirely, the OCR year is unreliable — drop the year filter
        // and search brand+surname across the whole catalog. If a row
        // matches the OCR-derived cardNumber we trust it; otherwise we
        // fall back to the unique-row case.
        if (tupleMissedCatalog && combined.cardNumber) {
          const cardNumLower = String(combined.cardNumber).toLowerCase();
          for (const fs of surnameCandidates) {
            const rows = await db
              .select({
                year: cardDatabase.year,
                cardNumber: cardDatabase.cardNumberRaw,
                playerName: cardDatabase.playerName,
              })
              .from(cardDatabase)
              .where(and(
                sql`lower(${cardDatabase.brand}) = ${brandLower}`,
                sql`lower(${cardDatabase.playerName}) LIKE ${'%' + fs + '%'}`,
              ))
              .limit(50);
            if (rows.length === 0) continue;
            // Prefer rows whose cardNumber matches the OCR-derived one.
            const cardNumMatches = rows.filter(r => String(r.cardNumber).toLowerCase() === cardNumLower);
            const flagged = combined as CardFormWithFlags;
            const oldYear = combined.year;
            const oldCardNum = combined.cardNumber;
            if (cardNumMatches.length === 1) {
              const row = cardNumMatches[0];
              combined.year = row.year;
              combined.cardNumber = String(row.cardNumber);
              flagged._yearFromCatalogProbe = true;
              flagged._yearFromBackOnly = false;
              flagged._yearFromCopyright = false;
              flagged._yearFromBareFallback = false;
              console.log(`[CardDB] Surname salvage (year-agnostic): "${fs}" + cardNumber #${cardNumLower} uniquely matched ${row.playerName} (${combined.brand} ${row.year} #${row.cardNumber}). Overriding year ${oldYear || '(none)'} → ${row.year}.`);
              break;
            }
            if (cardNumMatches.length > 1) {
              // Multiple years share this brand+surname+cardNumber.
              // The OCR year is known to be wrong here (the tuple
              // missed the catalog), so don't trust proximity to it.
              // Prefer a year that actually appears in the OCR text;
              // otherwise fall back to the EARLIEST year (vintage
              // copyright-lag heuristic — same convention used in
              // the year-validation block above).
              const ocrYears = new Set(extractAllYearCandidates(allOcrText));
              const ocrGrounded = cardNumMatches.filter(r => ocrYears.has(r.year));
              const pool = ocrGrounded.length > 0 ? ocrGrounded : cardNumMatches;
              const chosen = pool.reduce((a, b) => (b.year < a.year ? b : a));
              combined.year = chosen.year;
              flagged._yearFromCatalogProbe = true;
              flagged._yearFromBackOnly = false;
              flagged._yearFromCopyright = false;
              flagged._yearFromBareFallback = false;
              console.log(`[CardDB] Surname salvage (year-agnostic): "${fs}" + cardNumber #${cardNumLower} matched ${cardNumMatches.length} rows across years [${cardNumMatches.map(r => r.year).join(', ')}]. Picked ${chosen.year} (closest to OCR year ${ocrYr}).`);
              break;
            }
            // No cardNumber match — but if all rows share a single
            // cardNumber, recover it.
            if (rows.length === 1) {
              const row = rows[0];
              combined.year = row.year;
              combined.cardNumber = String(row.cardNumber);
              flagged._yearFromCatalogProbe = true;
              flagged._yearFromBackOnly = false;
              flagged._yearFromCopyright = false;
              flagged._yearFromBareFallback = false;
              console.log(`[CardDB] Surname salvage (year-agnostic): "${fs}" uniquely matched ${row.playerName} (${combined.brand} ${row.year} #${row.cardNumber}). OCR cardNumber ${oldCardNum} did not match any catalog row — overriding to #${row.cardNumber}.`);
              break;
            }
            // Year-only correction: when surname matches multiple catalog
            // rows but none have the OCR cardNumber, the OCR cardNumber is
            // bad (likely a print code from the bottom of the card, or a
            // subset card not in the base catalog). We can't recover the
            // cardNumber, but we CAN at least correct the year by picking
            // the year closest to the OCR year that has a row for this
            // brand+surname. Vintage Donruss/Leaf imprints lag the
            // production year by 1, so a +1 tie wins over -1.
            if (combined.year && Number(combined.year) > 0 && (
              !!(combined as CardFormWithFlags)._yearFromCopyright ||
              !!(combined as CardFormWithFlags)._yearFromBackOnly
            )) {
              const ocrYr = Number(combined.year);
              const yearsAvail = Array.from(new Set(rows.map(r => r.year))).filter(y => y > 0);
              if (yearsAvail.length > 0) {
                const dist = (y: number) => Math.abs(y - ocrYr);
                yearsAvail.sort((a, b) => {
                  const d = dist(a) - dist(b);
                  if (d !== 0) return d;
                  // Tiebreak: prefer year > ocrYr (publisher imprint lag).
                  return (b - ocrYr) - (a - ocrYr);
                });
                const newYr = yearsAvail[0];
                if (newYr !== ocrYr) {
                  combined.year = newYr;
                  flagged._yearFromCatalogProbe = true;
                  flagged._yearFromBackOnly = false;
                  flagged._yearFromCopyright = false;
                  flagged._yearFromBareFallback = false;
                  flagged._cardNumberLowConfidence = true;
                  console.log(`[CardDB] Surname salvage (year-only): "${fs}" matched ${rows.length} catalog rows across years [${yearsAvail.join(', ')}] but none had OCR cardNumber #${cardNumLower}. Shifting low-confidence year ${ocrYr} → ${newYr} (closest catalog year, +1 publisher-imprint-lag preference). Leaving cardNumber in place — flagged low-confidence so the UI can prompt the user.`);
                  break;
                }
              }
            }
            console.log(`[CardDB] Surname salvage (year-agnostic): "${fs}" matched ${rows.length} catalog rows but none matched OCR cardNumber #${cardNumLower} — leaving in place.`);
          }
          // If salvage succeeded, skip the year-restricted loop below.
          if ((combined as CardFormWithFlags)._yearFromCatalogProbe && combined.year !== Number(combined.year)) {
            // marker only; structured break via the loop above already exited
          }
        }

        if (uniqueYears.length > 0) {
          for (const fs of surnameCandidates) {
            const rows = await db
              .select({
                year: cardDatabase.year,
                cardNumber: cardDatabase.cardNumberRaw,
                playerName: cardDatabase.playerName,
                team: cardDatabase.team,
              })
              .from(cardDatabase)
              .where(and(
                sql`lower(${cardDatabase.brand}) = ${brandLower}`,
                inArray(cardDatabase.year, uniqueYears),
                sql`lower(${cardDatabase.playerName}) LIKE ${'%' + fs + '%'}`,
              ))
              .limit(10);

              const flagged = combined as CardFormWithFlags;
              const oldYear = combined.year;
              const oldCardNum = combined.cardNumber;

            if (rows.length === 1) {
              // Unique match — override both year AND cardNumber.
              const row = rows[0];
              combined.year = row.year;
              combined.cardNumber = String(row.cardNumber);
              flagged._yearFromCatalogProbe = true;
              flagged._yearFromBackOnly = false;
              flagged._yearFromCopyright = false;
              flagged._yearFromBareFallback = false;
              console.log(`[CardDB] Surname catalog search: "${fs}" uniquely matched ${row.playerName} (${combined.brand} ${row.year} #${row.cardNumber}). Overriding year ${oldYear || '(none)'} → ${row.year} and cardNumber ${oldCardNum || '(none)'} → ${row.cardNumber}.`);
              break;
            } else if (rows.length > 1) {
              // Multiple matches. If they all share the same
              // cardNumber, we can at least recover the cardNumber
              // and let the downstream year-probe disambiguate the
              // year via OCR-grounded tiebreakers.
              const cardNums = Array.from(new Set(rows.map(r => String(r.cardNumber))));
              const years = Array.from(new Set(rows.map(r => r.year)));
              if (cardNums.length === 1 && cardNumberMissing) {
                combined.cardNumber = cardNums[0];
                console.log(`[CardDB] Surname catalog search: "${fs}" matched ${rows.length} rows across years [${years.join(', ')}] but all share cardNumber #${cardNums[0]}. Recovered cardNumber → ${cardNums[0]}.`);
                // If all matches also share the same year, lock that in too.
                if (years.length === 1) {
                  combined.year = years[0];
                  flagged._yearFromCatalogProbe = true;
                  flagged._yearFromBackOnly = false;
                  flagged._yearFromCopyright = false;
                  flagged._yearFromBareFallback = false;
                  console.log(`[CardDB] Surname catalog search: also locking year → ${years[0]} (single year across matches).`);
                } else {
                  // Re-run the year probe now that cardNumber is known.
                  // Pick the earliest OCR-grounded year (vintage
                  // copyright lag heuristic) — same logic as the
                  // year-validation block uses when surname doesn't
                  // disambiguate.
                  const ocrGroundedYears = years.filter(y => extractAllYearCandidates(allOcrText).includes(y));
                  const chosenYear = (ocrGroundedYears.length > 0 ? ocrGroundedYears : years)
                    .reduce((a, b) => (b < a ? b : a));
                  combined.year = chosenYear;
                  flagged._yearFromCatalogProbe = true;
                  flagged._yearFromBackOnly = false;
                  flagged._yearFromCopyright = false;
                  flagged._yearFromBareFallback = false;
                  console.log(`[CardDB] Surname catalog search: locking year → ${chosenYear} (earliest ${ocrGroundedYears.length > 0 ? 'OCR-grounded ' : ''}year among matched rows).`);
                }
                break;
              } else {
                console.log(`[CardDB] Surname "${fs}" matched ${rows.length} catalog rows across years [${years.join(', ')}] / cardNumbers [${cardNums.join(', ')}] — ambiguous, not overriding.`);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[CardDB] Surname catalog search failed (non-fatal):', err);
    }
  }

  if (combined.brand && combined.year && combined.cardNumber) {
    // If the OCR text contains the literal "<year>-<cardNumber>"
    // compound (vintage convention printed in the © legal block,
    // e.g. "© TCMA LTD. 1982-17"), then BOTH year and cardNumber
    // were extracted from the same on-card identifier — this is
    // even stronger validation than a separate catalog probe.
    // Mark the catalog-probe trust flag so the rejection guard
    // below trusts the DB hit even when the OCR player name is
    // wrong (e.g. when the front-of-card "set name" got picked up
    // as the player name).
    {
      const yr = String(combined.year).trim();
      const num = String(combined.cardNumber).trim();
      if (yr && num) {
        const compoundRe = new RegExp(`\\b${yr}\\s*[-–—]\\s*${num.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`);
        const allOcrText = `${frontOCRText}\n${backOCRText}`;
        if (compoundRe.test(allOcrText)) {
          const flagged = combined as CardFormWithFlags;
          if (!flagged._yearFromCatalogProbe) {
            flagged._yearFromCatalogProbe = true;
            console.log(`[CardDB] On-card year-cardNumber compound "${yr}-${num}" detected in OCR — marking catalog-probe trust flag (DB hit will be trusted over OCR name).`);
          }
        }
      }
    }
    console.log(`[CardDB] Attempting lookup: brand="${combined.brand}" year=${combined.year} cardNumber="${combined.cardNumber}" collection="${combined.collection}"`);
    try {
      const backNum = String(combined.cardNumber || '').trim();
      let found = await tryLookup(combined.brand, combined.year, backNum, combined.collection);

      // Fallback: try ±1 year (OCR often gets copyright year wrong by one)
      // Only uses the back card number — front numbers are unreliable (jersey numbers etc.)
      // requireNameMatch=true: a ±1-year hit on the same brand+cardNumber is
      // a different release entirely if the player names disagree. Without
      // this guard, scanning a Topps 2022 Opening Day Mascots Mr. Met (#M-14)
      // — which isn't in the DB — would land on Topps 2023 Big League
      // Mascots "Card 14" (also #M-14, but a totally different card and
      // collection), corrupting the year, set, collection, AND player name.
      if (!found && backNum) {
        const yr = combined.year as number;
        // Autograph parallel-code card numbers (letters-dash-letters with no
        // digits, e.g. "EZA-JHT") sit immediately next to the copyright/year
        // on the back of the card, so the year reading is reliable even when
        // _yearFromBackOnly is set. Skip year-widening for these — otherwise
        // the player-fallback succeeds at every nearby year and the loop
        // wanders to whichever year happens to have the most candidates.
        const isAutographCode = /^[A-Z]+(?:-[A-Z]+)+$/i.test(backNum);
        // Default ±1 window. Widen to ±5 when the year came entirely from the
        // back of the card (no front year), because back stat tables can pick
        // a stat-line year (e.g. "1986 METS") that is years off from the
        // production year. The name-match guard prevents widening from
        // landing on the wrong player at the same brand/#.
        const yearLowConfidence = !isAutographCode && (!!(combined as any)._yearFromBackOnly || !!(combined as any)._yearFromCopyright);
        const window = yearLowConfidence ? 5 : (isAutographCode ? 0 : 1);
        const deltas: number[] = [];
        for (let d = 1; d <= window; d++) { deltas.push(d, -d); }
        if (yearLowConfidence) {
          console.log(`[CardDB] Year ${yr} is back-derived/low-confidence — widening fallback search to ±${window} years.`);
        }
        for (const delta of deltas) {
          console.log(`[CardDB] Retrying with year=${yr + delta} cardNumber="${backNum}"`);
          found = await tryLookup(combined.brand, yr + delta, backNum, combined.collection, { requireNameMatch: true });
          if (found) break;
        }
      }

      // ─── H-3: Player-anchored fallback ──────────────────────────────────
      // If the (brand, year, cardNumber) lookup and all ±year windows rejected
      // the card number, the card number is almost certainly what OCR got
      // wrong (stat-row digit, jersey number, sticker number, etc.). Drop the
      // card number entirely and search by (brand, year, playerLastName). If
      // exactly one row matches in this set, auto-correct the card number.
      if (!found && combined.brand && combined.year && combined.playerLastName) {
        console.log(`[CardDB] Player-anchored fallback — searching by (brand="${combined.brand}", year=${combined.year}, lastName="${combined.playerLastName}")`);
        try {
          const pResult = await lookupCardByPlayer({
            brand: combined.brand,
            year: combined.year as number,
            playerLastName: combined.playerLastName,
            playerFirstName: combined.playerFirstName || undefined,
            collection: combined.collection || undefined,
            cardNumberHint: combined.cardNumber || undefined,
          });
          if (pResult.found) {
            found = applyDbResult(pResult, 'player-anchored fallback');
          }
        } catch (err: any) {
          console.error('[CardDB] Player-anchored fallback failed (non-fatal):', err.message);
        }
      }

      if (!found) {
        console.log('[CardDB] No DB match after all fallbacks — proceeding with OCR-only results');
      }
    } catch (err: any) {
      console.error('[CardDB] Lookup failed (non-fatal):', err.message);
    }
  } else {
    console.log(`[CardDB] Skipping lookup — insufficient OCR fields: brand="${combined.brand}" year=${combined.year} cardNumber="${combined.cardNumber}"`);
  }
  // ───────────────────────────────────────────────────────────────────────────

  // Visual foil detection pass - analyze the actual card images for foil characteristics
  console.log('=== VISUAL FOIL DETECTION PASS ===');
  console.log('Current foil type before visual detection:', combined.foilType);
  console.log('Front image buffer available:', !!frontImageBuffer, frontImageBuffer ? `(${frontImageBuffer.length} bytes)` : '');
  console.log('Back image buffer available:', !!backImageBuffer, backImageBuffer ? `(${backImageBuffer.length} bytes)` : '');
  
  try {
    const { detectFoilFromImage } = await import('./visualFoilDetector');
    
    // Use front image primarily for visual foil detection (that's where foil effects are most visible)
    let visualFoilResult: FoilDetectionResult | null = null;

    // F-3c: prefer the preloaded hint from /api/scan/preliminary when the
    // client started a scan session. The preliminary endpoint ran this
    // exact detector on the exact same normalized front buffer, so reusing
    // its result saves a Vision API round trip on the critical scan path.
    //
    // Correctness guard: the preliminary ran with `isNumbered: false` (we
    // didn't have the back-side serial yet). The only downstream branch
    // that actually consumes `isNumbered` is a leniency path that *adds*
    // a foil-detection signal for numbered cards with modest tint coverage
    // (see visualFoilDetector.ts `hasNumberedCardEvidence`). So if the
    // back-side OCR determined this IS a numbered card AND the preloaded
    // hint said not-foil, re-run the pass with `isNumbered: true` to give
    // that leniency path a chance. If the preloaded hint already said
    // isFoil=true, the flag wouldn't change the answer, so reuse it.
    if (preloadedVisualFoil !== undefined && preloadedVisualFoil !== null) {
      const mustRerunForNumberedLeniency =
        !!combined.isNumbered &&
        !preloadedVisualFoil.isFoil &&
        !!frontImageBuffer;
      if (mustRerunForNumberedLeniency && frontImageBuffer) {
        console.log('[F-3c] Preloaded visual-foil hint said not-foil but card is numbered — re-running detector with isNumbered=true for leniency');
        visualFoilResult = await detectFoilFromImage(frontImageBuffer.toString('base64'), {
          isNumbered: true,
          imageBuffer: frontImageBuffer,
        });
        console.log('[F-3c] Re-run visual detection result:', visualFoilResult);
      } else {
        console.log('[F-3c] Reusing preloaded visual-foil hint from preliminary endpoint');
        visualFoilResult = preloadedVisualFoil;
      }
    } else if (frontImageBuffer) {
      console.log('Running visual foil detection on front image buffer...');
      const frontBase64 = frontImageBuffer.toString('base64');
      console.log('Base64 conversion successful, calling visual detector...');
      visualFoilResult = await detectFoilFromImage(frontBase64, {
        isNumbered: !!combined.isNumbered,
        imageBuffer: frontImageBuffer,
      });
      console.log('Visual detection result from front image:', visualFoilResult);
    } else {
      console.log('No front image buffer available for visual detection');
    }
    
    // Foil detection only uses the front image - back images have colored backgrounds
    // (e.g., red Topps backs) that cause false positives
    if (!frontImageBuffer) {
      console.log('No front image available - skipping back image foil detection (back colors cause false positives)');
    }
    
    if (visualFoilResult?.isFoil && visualFoilResult.foilType) {
      // Crackle texture detection is the most unreliable pattern — Chrome card surfaces and
      // jersey colors produce scattered-color signatures that the detector mistakes for Crackle.
      // Require 0.80 confidence for any Crackle-type foilType, regardless of DB validation.
      const isCrackleType = /crackle/i.test(visualFoilResult.foilType);
      // Also guard Chrome-variant cards: if the card is already identified as Chrome and the
      // visual detector says something other than Chrome itself, require very high confidence.
      const isChromVariantCard = (combined.variant || '').toLowerCase() === 'chrome';
      // Default crackle threshold is strict (0.80) to filter out chrome/jersey false
      // positives. Lower it to 0.55 when the detector reports BOTH corroborating
      // signals: a uniform border tint AND a multi-hue center rainbow. Jersey-color
      // and chrome-surface false positives lack consistent 4-strip border agreement,
      // so requiring both signals keeps the guard tight while letting genuine
      // confetti/polka-dot parallels through (e.g. 2026 Topps Confetti Foil with
      // pink+green dots produces borderTint on all 4 strips + centerRainbow).
      const indicatorsBlob = (visualFoilResult.indicators || []).join(' | ');
      const hasBorderTintEvidence = /borderTint qualifies as foil evidence/i.test(indicatorsBlob);
      const hasCenterRainbowEvidence = /center rainbow qualifies as reflective evidence/i.test(indicatorsBlob);
      const hasStrongCrackleCorroboration = hasBorderTintEvidence && hasCenterRainbowEvidence;
      const CRACKLE_CONFIDENCE_THRESHOLD = hasStrongCrackleCorroboration ? 0.55 : 0.80;
      if (isCrackleType && visualFoilResult.confidence < CRACKLE_CONFIDENCE_THRESHOLD) {
        combined.foilType = null;
        combined.isFoil = false;
        console.log(`[FoilDB] Crackle foil "${visualFoilResult.foilType}" rejected — confidence ${visualFoilResult.confidence.toFixed(2)} < ${CRACKLE_CONFIDENCE_THRESHOLD} (crackle threshold)`);
      } else if (isChromVariantCard && !/chrome/i.test(visualFoilResult.foilType) && visualFoilResult.confidence < CRACKLE_CONFIDENCE_THRESHOLD) {
        combined.foilType = null;
        combined.isFoil = false;
        console.log(`[FoilDB] Chrome-variant card: non-Chrome foil "${visualFoilResult.foilType}" rejected — confidence ${visualFoilResult.confidence.toFixed(2)} < ${CRACKLE_CONFIDENCE_THRESHOLD}`);
      } else {
      // Cross-check the detected foil color against known variations for this set.
      // If the set HAS variations in the DB but none reference the detected color,
      // it's almost certainly a false positive (e.g. blue jersey detected as Blue Foil).
      const brand = combined.brand || '';
      const year  = combined.year  || 0;
      const collection = combined.collection || '';
      const set = combined.set || '';

      if (brand && year) {
        const setVariations = await getSetVariationNames(brand, year, collection, set);
        if (setVariations.length > 0) {
          // DB has known parallels for this set — validate the detected color against them
          const colorKeywords = extractFoilColorKeywords(visualFoilResult.foilType);
          const colorMatchFound = colorKeywords.length > 0 && setVariations.some(varName =>
            colorKeywords.some(kw => varName.includes(kw))
          );
          const hasStrongIndicators = visualFoilResult.indicators?.some((ind: string) =>
            /strongFoil=true|reflective=true/i.test(ind)
          ) ?? false;
          const satMatch = visualFoilResult.indicators?.find((ind: string) =>
            /Same-color avg saturation:\s*(\d+)/i.test(ind)
          );
          const avgSaturation = satMatch
            ? parseInt(satMatch.match(/Same-color avg saturation:\s*(\d+)/i)?.[1] || '0', 10)
            : 0;
          const isVividFoilColor = avgSaturation >= 90;

          // Numbered/colored DB parallels (e.g. "Red /5", "Blue /150") almost
          // always have their serial number stamped on the card. If we can
          // visually see a colour AND the DB lists that colour as a parallel
          // BUT we never detected a serial number on either side AND the
          // parallel name doesn't appear in the OCR text either, we're almost
          // certainly looking at a base card whose design just happens to
          // include that colour (e.g. Yankees red borders → "Red /5"
          // false-positive on a base Aaron Judge). Require corroborating
          // evidence — a serial number, OR the colour name appearing in the
          // OCR text — before claiming the visual colour is the parallel.
          // Word-boundary match — `ocrTextLower.includes('red')` would
          // false-positive on common card-back boilerplate like
          // "REGISTERED TRADEMARK" (contains "red" inside "REGISTERED"),
          // "CREDIT", "PREDICTED", etc. Require the color keyword to
          // appear as a standalone word.
          const ocrTextLower = (combinedOcrText || '').toLowerCase();
          const colorNameAppearsInOcr = colorKeywords.length > 0 &&
            colorKeywords.some(kw => {
              const safe = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              return new RegExp(`\\b${safe}\\b`, 'i').test(ocrTextLower);
            });
          const hasCorroboratingEvidence = !!combined.isNumbered || colorNameAppearsInOcr;

          if (colorMatchFound && (hasStrongIndicators || isVividFoilColor) && hasCorroboratingEvidence) {
            combined.foilType = visualFoilResult.foilType;
            combined.isFoil = true;
            console.log(`[FoilDB] Visual foil "${visualFoilResult.foilType}" validated against set variations (keywords: ${colorKeywords.join(', ')}, confidence: ${visualFoilResult.confidence.toFixed(2)}, avgSat: ${avgSaturation}, corroboration: isNumbered=${!!combined.isNumbered}, colorInOcr=${colorNameAppearsInOcr})`);
          } else if (colorMatchFound && (hasStrongIndicators || isVividFoilColor)) {
            combined.foilType = null;
            combined.isFoil = false;
            // Visual detector saw a genuine foil signal that maps to a known
            // parallel colour for this set, but we can't pin down which one
            // without corroboration. Surface a "suspected parallel" hint so
            // the UI prompts the user to choose from the catalog instead of
            // silently treating the card as base. Preserve the Vision colour
            // as `suggestedColor` so the picker can narrow SCP's parallel
            // list to just the detected-colour family (e.g. Pink → the two
            // Pink parallels for this set) instead of dumping all 52 options.
            (combined as any).parallelSuspected = true;
            (combined as any).suggestedColor = visualFoilResult.foilType;
            console.log(`[FoilDB] Visual foil "${visualFoilResult.foilType}" rejected — color exists in DB but no corroborating evidence (no serial detected and color name not in OCR text). Flagging parallelSuspected + suggestedColor="${visualFoilResult.foilType}" so UI can show a colour-filtered picker.`);
          } else if (colorMatchFound) {
            combined.foilType = null;
            combined.isFoil = false;
            // Not vivid + no strong indicators → don't auto-apply the detected
            // colour as the parallel, but the detector DID see enough to name a
            // colour that maps to a known parallel for this set. That's too
            // much signal to silently discard — surface a colour-filtered
            // picker so the user can confirm or override, same as the
            // no-corroboration branch above. (PR F-2b: Petersen scan surfaced
            // as "no parallel" even though the detector returned Purple Foil
            // at 0.60 confidence because this branch dropped the hint.)
            if (visualFoilResult.confidence >= 0.55) {
              (combined as any).parallelSuspected = true;
              (combined as any).suggestedColor = visualFoilResult.foilType;
              console.log(`[FoilDB] Visual foil "${visualFoilResult.foilType}" color exists in DB but not vivid enough (avgSat=${avgSaturation} < 90, strongIndicators=${hasStrongIndicators}) — not auto-applying, but flagging parallelSuspected + suggestedColor="${visualFoilResult.foilType}" (confidence ${visualFoilResult.confidence.toFixed(2)} ≥ 0.55) so UI can show a colour-filtered picker.`);
            } else {
              console.log(`[FoilDB] Visual foil "${visualFoilResult.foilType}" color exists in DB but not vivid enough (avgSat=${avgSaturation} < 90, strongIndicators=${hasStrongIndicators}) — rejecting as false positive`);
            }
          } else {
            combined.foilType = null;
            combined.isFoil = false;
            // Detector named a colour that doesn't appear anywhere in the DB
            // parallel list for this set, but it still saw foil-like signal.
            // The colour name is wrong, not the foil-ness — let the user
            // pick the right parallel from the catalog.
            if (visualFoilResult.confidence >= 0.55) {
              (combined as any).parallelSuspected = true;
              // Even though the colour name doesn't match any known DB
              // variation for this set, SCP's catalog may well have it —
              // keep the Vision colour as a suggestion so the picker can
              // ask SCP to filter on it rather than dumping every parallel.
              (combined as any).suggestedColor = visualFoilResult.foilType;
              console.log(`[FoilDB] Visual foil "${visualFoilResult.foilType}" rejected — color keywords [${colorKeywords.join(', ')}] not found in ${setVariations.length} known variations for ${brand} ${year} "${collection}". Flagging parallelSuspected + suggestedColor="${visualFoilResult.foilType}" (visual confidence ${visualFoilResult.confidence.toFixed(2)} ≥ 0.55).`);
            } else {
              console.log(`[FoilDB] Visual foil "${visualFoilResult.foilType}" rejected — color keywords [${colorKeywords.join(', ')}] not found in ${setVariations.length} known variations for ${brand} ${year} "${collection}"`);
            }
          }
        } else {
          // No variations in DB for this set — require higher confidence before accepting,
          // to avoid false positives from jersey colors or card design colors (e.g. Angels red
          // being misread as "Red Crackle Foil" on a base Chrome Stars of MLB card).
          const HIGH_CONFIDENCE_THRESHOLD = 0.65;
          if (visualFoilResult.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
            combined.foilType = visualFoilResult.foilType;
            combined.isFoil = true;
            console.log(`[FoilDB] No DB variations for ${brand} ${year} "${collection}" — accepting visual foil (confidence ${visualFoilResult.confidence.toFixed(2)} ≥ ${HIGH_CONFIDENCE_THRESHOLD}): ${visualFoilResult.foilType}`);
          } else {
            combined.foilType = null;
            combined.isFoil = false;
            // Even without auto-applying, a mid-confidence colour call is
            // worth surfacing so the user can pick from SCP's catalog filtered
            // to that colour family. (PR F-2b: same rationale as the
            // colorMatchFound-but-not-vivid branch above.)
            if (visualFoilResult.confidence >= 0.55) {
              (combined as any).parallelSuspected = true;
              (combined as any).suggestedColor = visualFoilResult.foilType;
              console.log(`[FoilDB] No DB variations for ${brand} ${year} "${collection}" — not auto-applying visual foil (confidence ${visualFoilResult.confidence.toFixed(2)} < ${HIGH_CONFIDENCE_THRESHOLD}), but flagging parallelSuspected + suggestedColor="${visualFoilResult.foilType}" (≥ 0.55) so UI can show a colour-filtered picker.`);
            } else {
              console.log(`[FoilDB] No DB variations for ${brand} ${year} "${collection}" — rejecting visual foil (confidence ${visualFoilResult.confidence.toFixed(2)} < ${HIGH_CONFIDENCE_THRESHOLD}): ${visualFoilResult.foilType}`);
            }
          }
        }
      } else {
        // No brand/year to query — accept as-is
        combined.foilType = visualFoilResult.foilType;
        combined.isFoil = true;
        console.log(`Visual foil detection successful: ${visualFoilResult.foilType} (confidence: ${visualFoilResult.confidence})`);
      }
      } // end of crackle/chrome guard else block
      console.log(`Visual indicators: ${visualFoilResult.indicators.join('; ')}`);
    } else if (visualFoilResult && !visualFoilResult.indicators.some(indicator => indicator.includes('Error in visual analysis'))) {
      // Visual detection ran but did not find foil — trust it and clear any foil state.
      // EXCEPTION: If the back image explicitly prints the variant name prominently near the top
      // (e.g. "REFRACTOR" on Bowman Chrome autos), that printed label is authoritative.
      // Check the first 3 non-empty lines of the back OCR text for explicit variant keywords.
      // This is deliberately robust to OCR noise (punctuation, extra chars) by using
      // word-boundary matching rather than exact equality.
      const backTopLines = (backOCRText || '')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .slice(0, 3)
        .join(' ')
        .toUpperCase();
      const explicitVariantLabelPatterns: Array<{ pattern: RegExp; label: string }> = [
        { pattern: /\bGOLD REFRACTOR\b/, label: 'Gold Refractor' },
        { pattern: /\bBLUE REFRACTOR\b/, label: 'Blue Refractor' },
        { pattern: /\bPURPLE REFRACTOR\b/, label: 'Purple Refractor' },
        { pattern: /\bATOMIC REFRACTOR\b/, label: 'Atomic Refractor' },
        { pattern: /\bSPECKLE REFRACTOR\b/, label: 'Speckle Refractor' },
        { pattern: /\bREFRACTOR\b/, label: 'Refractor' },
        { pattern: /\bCRACKED ICE\b/, label: 'Cracked Ice' },
        { pattern: /\bSUPERFRACTOR\b/, label: 'Superfractor' },
      ];
      const backLabelMatch = explicitVariantLabelPatterns.find(({ pattern }) => pattern.test(backTopLines));
      if (backLabelMatch) {
        combined.foilType = backLabelMatch.label;
        combined.isFoil = true;
        console.log(`[FoilLabel] Explicit variant label "${backLabelMatch.label}" found in back OCR top lines — overriding visual rejection`);
      } else {
        // Serial number alone is not enough evidence; the DB variation lookup already handles
        // mapping serial numbers to parallel names (e.g. /499 → Sky Blue).
        combined.foilType = null;
        combined.isFoil = false;
        console.log('Visual foil detection rejected foil characteristics — clearing foil state');
        console.log(`Visual rejection reason: ${visualFoilResult.indicators.join('; ')}`);
      }
    } else {
      // Visual detection couldn't run, fall back to text-based detection for explicit mentions
      console.log('Visual detection unavailable, falling back to text-based foil detection...');
      
      const { detectFoilVariant } = await import('./foilVariantDetector');
      const combinedOCRText = frontOCRText + ' ' + backOCRText;
      const textFoilResult = detectFoilVariant(combinedOCRText);
      
      if (textFoilResult.isFoil && textFoilResult.foilType) {
        combined.foilType = textFoilResult.foilType;
        combined.isFoil = true;
        console.log(`Text-based foil detection successful: ${textFoilResult.foilType}`);
      } else {
        combined.foilType = null;
        combined.isFoil = false;
        console.log('No foil variant detected by any method');
      }
    }
  } catch (error) {
    console.error('Error in foil detection:', error);
    combined.foilType = null;
    combined.isFoil = false;
  }
  
  // Note: variant is NOT set from foilType. The variant field is reserved for
  // printed card variations (short print, image variation, etc.), not foil colors.
  // foilType carries the foil/parallel color information separately.

  // ─── DB Variation Fallback ──────────────────────────────────────────────────
  // If visual/text foil detection found nothing, use the DB-resolved parallel name.
  // This handles cases like "Aqua" (/399) where the foil color isn't visually obvious
  // or not present in the card's OCR text, but the serial number uniquely identifies it.
  if (dbVariation) {
    // Catalog rows whose name contains "Variation"/"Variations" (e.g. "Image
    // Variation", "Photo Variation") feed the Variant field instead of the
    // Parallel/foilType field. The two UI dropdowns are populated from
    // disjoint subsets of the same catalog column.
    if (/\bvariations?\b/i.test(dbVariation)) {
      if (!combined.variant) {
        combined.variant = dbVariation;
        console.log(`[CardDB] Applied DB variation as variant fallback: "${dbVariation}"`);
      }
    } else if (!combined.foilType) {
      combined.foilType = dbVariation;
      combined.isFoil = true;
      console.log(`[CardDB] Applied DB variation as foilType fallback: "${dbVariation}"`);
    }
  }

  // ─── Catalog Authority: clear detector-assigned parallels with no DB backing ─
  // The card_variations table is the source of truth. If the catalog confirmed
  // the card and had no matching variation row (no NULL-serial row when no
  // serial was detected, or no matching limit row when one was), any foilType
  // assigned by the visual / text / regional detectors is unverified and must
  // be cleared. The user's rule: default to "None detected" in that case.
  if (dbConfirmsNoParallel && combined.foilType) {
    console.log(`[CardDB] Clearing detector-assigned foilType "${combined.foilType}" — catalog has no parallel for this card.`);
    combined.foilType = null;
    combined.isFoil = false;
  }

  // ─── Catalog Authority (ambiguous case): apply the parallel-hint rule late ──
  // When the catalog returned multiple NULL-serial parallel candidates, the
  // lookup deferred picking one (no positive parallel hint at lookup time).
  // Now that visual / text foil detection has run, treat its foilType as the
  // late parallel hint: keep it only if it shares a token with one of the
  // catalog options; otherwise clear and default to base. The user's rule:
  // un-numbered parallels need positive evidence to apply.
  {
    const flagged = combined as CardFormWithFlags;
    if (flagged._variationAmbiguous && flagged._variationOptions?.length && combined.foilType) {
      const tok = (s: string) =>
        new Set(
          s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t.length >= 3),
        );
      const hintTokens = tok(combined.foilType);
      const matchedOption = flagged._variationOptions.find(opt => {
        const ct = tok(opt);
        for (const t of hintTokens) if (ct.has(t)) return true;
        return false;
      });
      if (matchedOption) {
        console.log(`[CardDB] Late parallel-hint match: detector "${combined.foilType}" matched catalog option "${matchedOption}" — keeping and clearing ambiguity flag.`);
        combined.foilType = matchedOption;
        combined.isFoil = true;
        flagged._variationAmbiguous = false;
        flagged._variationOptions = undefined;
      } else {
        console.log(`[CardDB] No catalog option matched detector foilType "${combined.foilType}" — clearing (defaulting to base). Options were: ${flagged._variationOptions.join(' | ')}`);
        combined.foilType = null;
        combined.isFoil = false;
      }
    }
  }

  // Final card-number confidence check: if no card # was extracted at all,
  // flag low-confidence so the UI can prompt the user to enter it. This
  // complements the salvage-path flag set when the catalog rejects the OCR
  // cardNumber.
  {
    const flagged = combined as CardFormWithFlags;
    const cn = combined.cardNumber == null ? '' : String(combined.cardNumber).trim();
    if (cn.length === 0) {
      flagged._cardNumberLowConfidence = true;
      console.log('[CardNum] No card number extracted — flagging low-confidence so UI prompts user.');
    }
  }

  console.log('=== COMBINATION COMPLETE ===');
  
  return combined;
}

/**
 * Ensure all required fields have values
 */
// Strip trailing jersey/uniform numbers from a player name.
// e.g. "Buttó 6" → "Buttó", "Trout (6)" → "Trout", "Ortiz #34" → "Ortiz"
function stripTrailingNumberFromName(name: string): string {
  return name
    .replace(/\s*\(#?\d+\)\s*$/, '') // "(6)" or "(#6)"
    .replace(/\s+#?\d+\s*$/, '')      // " 6" or " #6"
    .trim();
}

function ensureRequiredFields(result: Partial<CardFormValues>): Partial<CardFormValues> {
  // Clean any trailing jersey/uniform numbers that slipped into player name fields
  if (result.playerFirstName) result.playerFirstName = stripTrailingNumberFromName(result.playerFirstName);
  if (result.playerLastName)  result.playerLastName  = stripTrailingNumberFromName(result.playerLastName);

  const defaultsIfMissing = {
    condition: 'PSA 8',
    sport: 'Not detected',
    brand: result.brand || 'Unknown',
    year: result.year || new Date().getFullYear(),
    playerFirstName: result.playerFirstName || 'Unknown',
    playerLastName: result.playerLastName || 'Player',
    collection: result.collection || '',
    cardNumber: result.cardNumber || '',
    variant: result.variant || '',
    serialNumber: result.serialNumber || '',
    estimatedValue: result.estimatedValue || 0,
    isRookieCard: !!result.isRookieCard,
    isAutographed: !!result.isAutographed,
    isNumbered: !!result.isNumbered,
    notes: result.notes || ''
  };
  
  // Make sure required fields exist
  Object.entries(defaultsIfMissing).forEach(([key, value]) => {
    if (result[key as keyof CardFormValues] === undefined || 
        result[key as keyof CardFormValues] === null) {
      result[key as keyof CardFormValues] = value as any;
    }
  });
  
  return result;
}