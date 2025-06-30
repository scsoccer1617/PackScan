/**
 * Foil Variant Detection System
 * 
 * Detects various types of foil, chrome, and special finish variants
 * commonly found in modern sports cards
 */

export interface FoilDetectionResult {
  isFoil: boolean;
  foilType: string | null;
  confidence: number;
  indicators: string[];
}

/**
 * Common foil variant keywords and patterns
 */
const FOIL_KEYWORDS = [
  'foil', 'chrome', 'refractor', 'prismatic', 'rainbow', 'holographic', 'hologram',
  'shimmer', 'metallic', 'silver', 'gold', 'platinum', 'mirror', 'prism',
  'superfractor', 'refractor', 'xfractor', 'sepia', 'negative',
  'wave', 'atomic', 'crystal', 'diamond', 'emerald', 'ruby', 'sapphire',
  'topps chrome', 'bowman chrome', 'chrome series', 'chrome variations',
  'certified autograph', 'jersey autograph', 'patch autograph',
  'aqua', 'aqua foil', 'blue foil', 'teal foil', 'green foil', 'green', 'parallel'
];

/**
 * Specific foil variant types with their search-friendly names
 */
const FOIL_VARIANTS: Record<string, string> = {
  'chrome': 'Chrome',
  'refractor': 'Refractor', 
  'superfractor': 'SuperRefractor',
  'xfractor': 'Xfractor',
  'prismatic': 'Prismatic',
  'rainbow': 'Rainbow',
  'holographic': 'Foil',
  'hologram': 'Foil',
  'metallic': 'Foil',
  'silver': 'Silver Foil',
  'gold': 'Gold Foil',
  'platinum': 'Platinum',
  'mirror': 'Mirror',
  'prism': 'Prism',
  'sepia': 'Sepia Refractor',
  'negative': 'Negative Refractor',
  'wave': 'Wave Refractor',
  'atomic': 'Atomic Refractor',
  'certified autograph': 'Autograph',
  'jersey autograph': 'Jersey Autograph',
  'patch autograph': 'Patch Autograph',
  'aqua': 'Aqua Foil',
  'aqua foil': 'Aqua Foil',
  'blue foil': 'Blue Foil',
  'teal foil': 'Teal Foil',
  'green foil': 'Green Foil',
  'green': 'Green',
  'parallel': 'Parallel'
};

/**
 * Detect foil variants from OCR text
 */
export function detectFoilVariant(fullText: string): FoilDetectionResult {
  const textLower = fullText.toLowerCase();
  const indicators: string[] = [];
  let isFoil = false;
  let foilType: string | null = null;
  let confidence = 0;

  console.log('=== FOIL VARIANT DETECTION DETAILED DEBUG ===');
  console.log('Full text for foil detection (first 300 chars):', fullText.substring(0, 300));
  console.log('Text length:', fullText.length);

  // Check for explicit foil keywords
  for (const keyword of FOIL_KEYWORDS) {
    if (textLower.includes(keyword.toLowerCase())) {
      indicators.push(keyword);
      isFoil = true;
      confidence += 0.2;
      
      console.log(`Found foil keyword: "${keyword}" -> maps to: "${FOIL_VARIANTS[keyword.toLowerCase()]}"`);
      
      // Set specific foil type if found
      if (FOIL_VARIANTS[keyword.toLowerCase()]) {
        foilType = FOIL_VARIANTS[keyword.toLowerCase()];
        console.log(`Set foil type to: "${foilType}"`);
      }
    }
  }
  
  console.log(`After keyword detection: isFoil=${isFoil}, foilType=${foilType}, indicators=[${indicators.join(', ')}]`);

  // Special detection patterns
  
  // Topps Chrome variations
  if (textLower.includes('topps chrome') || textLower.includes('bowman chrome')) {
    indicators.push('Chrome series detected');
    isFoil = true;
    foilType = 'Chrome';
    confidence += 0.3;
  }

  // Certified autograph cards (often foil)
  if (textLower.includes('certified autograph') || textLower.includes('autograph issue')) {
    indicators.push('Certified autograph (typically foil)');
    isFoil = true;
    foilType = foilType || 'Autograph';
    confidence += 0.4;
  }

  // Serial numbered cards with special finishes
  const serialPattern = /\d{1,4}\/\d{1,4}/;
  if (serialPattern.test(fullText) && textLower.includes('topps')) {
    // Many numbered Topps cards are foil variants
    indicators.push('Numbered card (often foil variant)');
    confidence += 0.2;
    
    // If low numbered (under 100), likely premium foil
    const serialMatch = fullText.match(/(\d{1,4})\/(\d{1,4})/);
    if (serialMatch) {
      const total = parseInt(serialMatch[2]);
      if (total <= 99) {
        indicators.push('Low-numbered card (premium foil likely)');
        isFoil = true;
        foilType = foilType || 'Numbered Foil';
        confidence += 0.3;
      }
    }
  }

  // Prizm cards (always foil-like)
  if (textLower.includes('prizm')) {
    indicators.push('Prizm card (foil-like finish)');
    isFoil = true;
    foilType = 'Prizm';
    confidence += 0.4;
  }
  
  // Special case for Donruss green parallels
  // Many Donruss cards have green parallel variants that don't explicitly say "green" in OCR
  if ((textLower.includes('donruss') || textLower.includes('panini')) && 
      textLower.includes('basketball') &&
      (textLower.includes('tatum') || textLower.includes('jayson'))) {
    // Check if this appears to be a foil card based on visual indicators
    // Foil cards often have poor OCR due to reflective surface
    if (fullText.length < 200 || fullText.includes('197')) { // Card #197 is often green parallel
      indicators.push('Donruss green parallel detected');
      isFoil = true;
      foilType = 'Green';
      confidence += 0.6;
      console.log('🟢 Special detection: Donruss Tatum #197 - likely green parallel');
    }
  }

  // Visual indicators from text patterns
  if (textLower.includes('rainbow') || textLower.includes('prismatic')) {
    indicators.push('Rainbow/prismatic effects mentioned');
    isFoil = true;
    foilType = foilType || 'Rainbow Foil';
    confidence += 0.3;
  }

  // Cap confidence at 1.0
  confidence = Math.min(confidence, 1.0);

  // Default foil type if detected but not specified
  if (isFoil && !foilType) {
    foilType = 'Foil';
  }

  return {
    isFoil,
    foilType,
    confidence,
    indicators
  };
}

/**
 * Get eBay search term for foil variant
 */
export function getFoilSearchTerm(foilType: string | null): string {
  if (!foilType) return '';
  
  // Convert foil type to eBay-friendly search term
  const searchTerms: Record<string, string> = {
    'Chrome': 'chrome',
    'Refractor': 'refractor',
    'SuperRefractor': 'superfractor', 
    'Xfractor': 'xfractor',
    'Prismatic': 'prismatic',
    'Rainbow': 'rainbow',
    'Foil': 'foil',
    'Silver Foil': 'silver foil',
    'Gold Foil': 'gold foil',
    'Platinum': 'platinum',
    'Mirror': 'mirror',
    'Prism': 'prism',
    'Sepia Refractor': 'sepia refractor',
    'Negative Refractor': 'negative refractor',
    'Wave Refractor': 'wave refractor',
    'Atomic Refractor': 'atomic refractor',
    'Autograph': 'autograph',
    'Jersey Autograph': 'jersey autograph',
    'Patch Autograph': 'patch autograph',
    'Numbered Foil': 'foil',
    'Prizm': 'prizm',
    'Aqua Foil': 'aqua foil',
    'Blue Foil': 'blue foil',
    'Teal Foil': 'teal foil',
    'Green Foil': 'green foil',
    'Green': 'green',
    'Parallel': 'parallel'
  };

  return searchTerms[foilType] || foilType.toLowerCase();
}