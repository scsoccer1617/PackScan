import { Request, Response } from 'express';
import sharp from 'sharp';
import { CardFormValues } from '@shared/schema';
import { analyzeSportsCardImage } from './dynamicCardAnalyzer';
import { detectFoilVariant } from './foilVariantDetector';
import { lookupCard } from './cardDatabaseService';
import { batchExtractTextFromImages, clearOcrCache } from './googleVisionFetch';
import { db } from '@db';
import { cardVariations } from '@shared/schema';
import { and, eq, sql } from 'drizzle-orm';

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
async function normalizeImageOrientation(buffer: Buffer, label: string): Promise<Buffer> {
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
      frontImage
        ? normalizeImageOrientation(frontImage.buffer, 'front').then(b => { frontImage.buffer = b; frontImage.size = b.length; })
        : Promise.resolve(),
      backImage
        ? normalizeImageOrientation(backImage.buffer, 'back').then(b => { backImage.buffer = b; backImage.size = b.length; })
        : Promise.resolve(),
    ]);

    // ── Batch Vision API call ─────────────────────────────────────────────────
    // Send both images to Vision in a SINGLE batchAnnotateImages request.
    // Results are stored in the per-request OCR cache so that all subsequent
    // calls to extractTextFromImage() within this scan are free cache hits.
    // This reduces Vision API round-trips from 4 (2 per image) down to 1.
    clearOcrCache();
    try {
      const batchImages: { base64: string; label: string }[] = [];
      if (frontImage) batchImages.push({ base64: frontImage.buffer.toString('base64'), label: 'front' });
      if (backImage)  batchImages.push({ base64: backImage.buffer.toString('base64'),  label: 'back'  });
      if (batchImages.length > 0) {
        await batchExtractTextFromImages(batchImages);
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

    // Analyze front image if provided
    if (frontImage) {
      try {
        const frontBase64 = frontImage.buffer.toString('base64');
        
        // Get raw OCR text for foil detection
        frontOCRText = await extractTextForBrandDetection(frontBase64);
        
        // Use dynamic analyzer that can handle all card types
        console.log(`Front text detection: ${frontOCRText.substring(0, 200)}`);
        console.log('Using dynamic analyzer for front image');
        frontResult = await Promise.race([analyzeSportsCardImage(frontBase64, 'front'), createTimeout()]);
        console.log('Front image analysis returned:', frontResult);
        console.log('Front image analysis complete');
      } catch (error) {
        console.error('Error analyzing front image:', error);
        console.error('Front image analysis error details:', error.message);
      }
    }

    // Analyze back image if provided
    if (backImage) {
      try {
        const backBase64 = backImage.buffer.toString('base64');
        
        // Get raw OCR text for foil detection
        backOCRText = await extractTextForBrandDetection(backBase64);
        
        // Use dynamic analyzer that can handle all card types
        console.log(`Back text detection: ${backOCRText.substring(0, 200)}`);
        console.log('Using dynamic analyzer for back image');
        backResult = await Promise.race([analyzeSportsCardImage(backBase64, 'back'), createTimeout()]);
        console.log('Back image analysis returned:', backResult);
        console.log('Back image analysis complete');
      } catch (error) {
        console.error('Error analyzing back image:', error);
        console.error('Back image analysis error details:', error.message);
      }
    }

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
      combinedResult = await combineCardResults(frontResult, backResult, frontOCRText, backOCRText, frontImage?.buffer, backImage?.buffer);
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
    const finalResult = ensureRequiredFields(combinedResult);
    
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
  backImageBuffer?: Buffer
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
  const frontHasYear = hasValue(frontResult.year);
  const backHasYear  = hasValue(backResult.year);

  if (frontHasYear) {
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
    'MARINERS', 'ANGELS', 'ROCKIES', 'DIAMONDBACKS', 'WHITE', 'SOX',
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
  ]);
  
  const stripTrademarkSuffix = (w: string): string => w.replace(/(?:TM|™|®|\.+)$/gi, '');
  
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
  
  const frontNameBogus = isBogusFn(combined.playerFirstName, combined.playerLastName);
  const backNameBogus = isBogusFn(backResult.playerFirstName, backResult.playerLastName);
  
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
    
    const lines = allText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      let nameCandidate = trimmed;
      const firstWord = trimmed.split(/\s+/)[0];
      if (/^[A-Z0-9]+-\d+$/.test(firstWord) || /^\d+[A-Z]\d*-\d+$/.test(firstWord)) {
        nameCandidate = trimmed.substring(firstWord.length).trim();
      }
      
      const words = nameCandidate.split(/\s+/).filter(w => w.length > 0);
      if (words.length >= 2 && words.length <= 3) {
        const allAlpha = words.every(w => /^[A-Z]{2,}$/.test(w));
        const noBogus = words.every(w => !bogusNameWords.has(w));
        const noNumbers = words.every(w => !/\d/.test(w));
        
        if (allAlpha && noBogus && noNumbers) {
          combined.playerFirstName = words[0].charAt(0) + words[0].slice(1).toLowerCase();
          combined.playerLastName = words.slice(1).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
          console.log(`Recovered player name from OCR text: ${combined.playerFirstName} ${combined.playerLastName} (from line: "${trimmed}")`);
          nameRecovered = true;
          break;
        }
      }
    }
    
    if (!nameRecovered) {
      const nameLineMatch = allText.match(/^([A-Z][A-Z]+)\s+([A-Z][A-Z]+(?:\s+[A-Z][A-Z]+)?)\s*$/m);
      if (nameLineMatch) {
        const words = nameLineMatch[0].trim().split(/\s+/);
        const noBogusFn = words.every(w => !bogusNameWords.has(w));
        if (noBogusFn && words.length >= 2 && words.length <= 3) {
          combined.playerFirstName = words[0].charAt(0) + words[0].slice(1).toLowerCase();
          combined.playerLastName = words.slice(1).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
          console.log(`Recovered player name from OCR text (fallback): ${combined.playerFirstName} ${combined.playerLastName}`);
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
      const dbLast  = (dbResult.playerLastName || '').trim().toLowerCase();
      const lastNamesOverlap = !!ocrLast && !!dbLast && (
        ocrLast === dbLast ||
        ocrLast.includes(dbLast) ||
        dbLast.includes(ocrLast)
      );
      const ocrHasNoName = !ocrLast;
      if (!lastNamesOverlap && !ocrHasNoName) {
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

  if (combined.brand && combined.year && combined.cardNumber) {
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
        // Default ±1 window. Widen to ±5 when the year came entirely from the
        // back of the card (no front year), because back stat tables can pick
        // a stat-line year (e.g. "1986 METS") that is years off from the
        // production year. The name-match guard prevents widening from
        // landing on the wrong player at the same brand/#.
        const yearLowConfidence = !!(combined as any)._yearFromBackOnly || !!(combined as any)._yearFromCopyright;
        const window = yearLowConfidence ? 5 : 1;
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
    let visualFoilResult = null;
    
    if (frontImageBuffer) {
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
          if (colorMatchFound && (hasStrongIndicators || isVividFoilColor)) {
            combined.foilType = visualFoilResult.foilType;
            combined.isFoil = true;
            console.log(`[FoilDB] Visual foil "${visualFoilResult.foilType}" validated against set variations (keywords: ${colorKeywords.join(', ')}, confidence: ${visualFoilResult.confidence.toFixed(2)}, avgSat: ${avgSaturation})`);
          } else if (colorMatchFound) {
            combined.foilType = null;
            combined.isFoil = false;
            console.log(`[FoilDB] Visual foil "${visualFoilResult.foilType}" color exists in DB but not vivid enough (avgSat=${avgSaturation} < 90, strongIndicators=${hasStrongIndicators}) — rejecting as false positive`);
          } else {
            combined.foilType = null;
            combined.isFoil = false;
            console.log(`[FoilDB] Visual foil "${visualFoilResult.foilType}" rejected — color keywords [${colorKeywords.join(', ')}] not found in ${setVariations.length} known variations for ${brand} ${year} "${collection}"`);
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
            console.log(`[FoilDB] No DB variations for ${brand} ${year} "${collection}" — rejecting visual foil (confidence ${visualFoilResult.confidence.toFixed(2)} < ${HIGH_CONFIDENCE_THRESHOLD}): ${visualFoilResult.foilType}`);
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
  if (!combined.foilType && dbVariation) {
    combined.foilType = dbVariation;
    combined.isFoil = true;
    console.log(`[CardDB] Applied DB variation as foilType fallback: "${dbVariation}"`);
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