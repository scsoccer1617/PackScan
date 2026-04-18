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
  'shimmer', 'metallic', 'platinum', 'mirror', 'prism',
  'superfractor', 'xfractor', 'sepia', 'negative',
  'wave', 'atomic', 'crystal',
  'topps chrome', 'bowman chrome', 'chrome series', 'chrome variations',
  'certified autograph', 'jersey autograph', 'patch autograph',
  'aqua foil', 'blue foil', 'teal foil', 'green foil', 'silver foil', 'gold foil',
  'red foil', 'purple foil', 'orange foil', 'black foil', 'pink foil',
  'diamante foil', 'diamante',
  'parallel'
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
  'silver foil': 'Silver Foil',
  'gold foil': 'Gold Foil',
  'green foil': 'Green Foil',
  'blue foil': 'Blue Foil',
  'red foil': 'Red Foil',
  'aqua foil': 'Aqua Foil',
  'teal foil': 'Teal Foil',
  'purple foil': 'Purple Foil',
  'orange foil': 'Orange Foil',
  'black foil': 'Black Foil',
  'pink foil': 'Pink Foil',
  'diamante foil': 'Diamante Foil',
  'diamante': 'Diamante Foil',
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
  'parallel': 'Parallel'
};

/**
 * Check for lighting reflection artifacts that might cause false foil detection
 */
function hasLightingArtifacts(text: string): boolean {
  const lightingIndicators = [
    'white border', 'border white', 'white edge', 'edge white',
    'reflection', 'glare', 'lighting', 'flash', 'bright',
    'overexposed', 'washed out', 'bleached'
  ];
  
  const textLower = text.toLowerCase();
  return lightingIndicators.some(indicator => textLower.includes(indicator));
}

/**
 * Check for genuine foil context vs lighting artifacts
 */
function hasGenuineFoilContext(text: string, keyword: string): boolean {
  const textLower = text.toLowerCase();
  const keywordIndex = textLower.indexOf(keyword.toLowerCase());
  
  if (keywordIndex === -1) return false;
  
  // Get context around the foil keyword (50 characters before and after)
  const start = Math.max(0, keywordIndex - 50);
  const end = Math.min(textLower.length, keywordIndex + keyword.length + 50);
  const context = textLower.substring(start, end);
  
  // Genuine foil indicators
  const genuineIndicators = [
    'chrome', 'refractor', 'parallel', 'variant', 'series',
    'numbered', 'limited', 'exclusive', 'special', 'premium',
    'holographic', 'metallic', 'prismatic', 'rainbow',
    'green', 'silver', 'gold', 'blue', 'red', 'teal', 'aqua',
    'donruss', 'panini', 'topps', 'bowman', 'optic'
  ];
  
  // Lighting artifact indicators
  const artifactIndicators = [
    'border', 'edge', 'corner', 'lighting', 'flash', 'glare',
    'reflection', 'bright', 'white', 'overexposed'
  ];
  
  const hasGenuine = genuineIndicators.some(indicator => context.includes(indicator));
  const hasArtifact = artifactIndicators.some(indicator => context.includes(indicator));
  
  // If we have artifact indicators but no genuine indicators, likely false positive
  if (hasArtifact && !hasGenuine) {
    console.log(`Potential lighting artifact detected for "${keyword}" in context: "${context}"`);
    return false;
  }
  
  return true;
}

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
  console.log('Full text for foil detection (first 500 chars):', fullText.substring(0, 500));
  console.log('Text length:', fullText.length);
  console.log('Text contains "green":', textLower.includes('green'));
  console.log('Text contains "foil":', textLower.includes('foil'));
  console.log('Text contains "donruss":', textLower.includes('donruss'));
  console.log('Text contains "panini":', textLower.includes('panini'));
  
  // Early detection of lighting artifacts
  if (hasLightingArtifacts(fullText)) {
    console.log('Detected potential lighting artifacts in text - applying stricter foil detection');
  }

  // Check for explicit foil keywords with context validation
  for (const keyword of FOIL_KEYWORDS) {
    const keywordLower = keyword.toLowerCase();
    if (textLower.includes(keywordLower)) {
      // Special handling for generic "foil" - require it to be in a card context
      if (keywordLower === 'foil') {
        // Only detect "foil" if it appears with card-specific context
        const foilContextPatterns = [
          /\bfoil\s+(?:card|variant|parallel|finish|series)\b/,
          /\b(?:card|variant|parallel|finish|series)\s+foil\b/,
          /\b(?:silver|gold|green|blue|red|rainbow)\s+foil\b/,
          /\bfoil\s+(?:silver|gold|green|blue|red|rainbow)\b/,
          /\btopps\s+foil\b/,
          /\bfoil\s+topps\b/
        ];
        
        const hasCardContext = foilContextPatterns.some(pattern => pattern.test(textLower));
        if (!hasCardContext) {
          console.log(`Skipping generic "foil" keyword - no card context found`);
          continue;
        }
      }
      
      // Check for lighting artifacts that might cause false positives
      if (!hasGenuineFoilContext(fullText, keyword)) {
        console.log(`Skipping "${keyword}" - likely lighting artifact or reflection`);
        continue;
      }
      
      indicators.push(keyword);
      isFoil = true;
      confidence += 0.2;
      
      console.log(`Found foil keyword: "${keyword}" -> maps to: "${FOIL_VARIANTS[keywordLower]}"`);
      
      // Set specific foil type if found
      if (FOIL_VARIANTS[keywordLower]) {
        foilType = FOIL_VARIANTS[keywordLower];
        console.log(`Set foil type to: "${foilType}"`);
      }
    }
  }
  
  console.log(`After keyword detection: isFoil=${isFoil}, foilType=${foilType}, indicators=[${indicators.join(', ')}]`);

  // Special detection patterns
  
  // NOTE: Visual foil detection should be handled by the visual analyzer
  // Text-based detection is only for explicit foil mentions in the card text
  
  // Enhanced Donruss/Panini Detection for modern foil cards (only for basketball/Tatum)
  if ((textLower.includes('donruss') || textLower.includes('panini')) && 
      textLower.includes('tatum') && textLower.includes('basketball')) {
    console.log('DONRUSS/PANINI TATUM BASKETBALL CARD DETECTED - checking for foil characteristics');
    
    // Look for specific foil indicators in the text
    if (textLower.includes('green') || textLower.includes('emerald') || textLower.includes('jade')) {
      console.log('GREEN FOIL DETECTED in Donruss/Panini card');
      isFoil = true;
      foilType = 'Green Foil';
      confidence = 0.9;
      indicators.push('Green foil - Donruss/Panini modern card');
    } else if (textLower.includes('silver') || textLower.includes('chrome')) {
      isFoil = true;
      foilType = 'Silver Foil';
      confidence = 0.9;
      indicators.push('Silver foil - Donruss/Panini modern card');
    } else if (textLower.includes('gold') || textLower.includes('golden')) {
      isFoil = true;
      foilType = 'Gold Foil';
      confidence = 0.9;
      indicators.push('Gold foil - Donruss/Panini modern card');
    } else {
      // Many modern Donruss basketball cards are green foil variants by default
      console.log('ASSUMING Green Foil for modern Donruss/Panini basketball card (common variant)');
      isFoil = true;
      foilType = 'Green Foil';
      confidence = 0.8;
      indicators.push('Assumed green foil - modern Donruss/Panini basketball default variant');
    }
  }
  
  // Topps baseball cards - be more conservative, only detect if explicit foil keywords present
  if (textLower.includes('topps') && textLower.includes('baseball') && 
      !textLower.includes('chrome') && !textLower.includes('foil') && 
      !textLower.includes('refractor') && !textLower.includes('prismatic')) {
    console.log('TOPPS BASEBALL BASE CARD DETECTED - likely non-foil');
    // Don't automatically assign foil for regular Topps baseball cards
    if (isFoil && !foilType) {
      console.log('REJECTING generic foil assignment for Topps baseball base card');
      isFoil = false;
      indicators.push('Rejected: Topps baseball base card without explicit foil indicators');
    }
  }
  
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

  // Serial numbered cards: do NOT infer foil type from serial number alone.
  // The DB variation lookup handles /serial → parallel name mapping via CSV data.
  // A serial number in OCR text just means the card is limited, not that it has a foil finish.

  // Prizm cards (always foil-like)
  if (textLower.includes('prizm')) {
    indicators.push('Prizm card (foil-like finish)');
    isFoil = true;
    foilType = 'Prizm';
    confidence += 0.4;
  }
  
  // Special case for explicit green parallels only when foil indicators are present
  if ((textLower.includes('donruss') || textLower.includes('panini')) && 
      textLower.includes('basketball') &&
      (textLower.includes('green') || textLower.includes('laser') || textLower.includes('holo'))) {
    indicators.push('Donruss green parallel detected from explicit foil text');
    isFoil = true;
    foilType = 'Green';
    confidence += 0.6;
    console.log('Green parallel detected: Explicit foil indicators found in text');
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
  // Be more lenient for genuine card manufacturers and color variants
  if (isFoil && !foilType) {
    const hasManufacturer = textLower.includes('donruss') || textLower.includes('panini') || 
                          textLower.includes('topps') || textLower.includes('bowman');
    const hasColorVariant = textLower.includes('green') || textLower.includes('silver') || 
                          textLower.includes('gold') || textLower.includes('rainbow');
    
    if (confidence >= 0.4 || indicators.length >= 2 || hasManufacturer || hasColorVariant) {
      foilType = 'Foil';
      console.log(`Setting foil type to "Foil" - confidence: ${confidence}, indicators: ${indicators.length}, manufacturer: ${hasManufacturer}, color: ${hasColorVariant}`);
    } else {
      // Low confidence detection - likely false positive
      console.log(`Low confidence foil detection (${confidence}) with ${indicators.length} indicators: [${indicators.join(', ')}] - setting to null`);
      isFoil = false;
      foilType = null;
    }
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
    'Diamante Foil': 'diamante foil',
    'Blue Foil': 'blue foil',
    'Teal Foil': 'teal foil',
    'Green Foil': 'green foil',
    'Green': 'green',
    'Parallel': 'parallel'
  };

  return searchTerms[foilType] || foilType.toLowerCase();
}