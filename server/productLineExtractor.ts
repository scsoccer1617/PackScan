/**
 * Product-line extractor.
 *
 * Card dealers inventory thousands of cards. The single most expensive OCR
 * bug is mis-identifying the product line (e.g. Origins read as Prizm),
 * because that kills every downstream eBay search.
 *
 * This module is the authoritative "which product line is this card?"
 * resolver. It works in two passes:
 *
 *   1. BACK copyright line  — most modern Panini/Topps/Bowman/Upper Deck
 *      cards print a line on the back like "2020 PANINI - ORIGINS FOOTBALL".
 *      We read the brand, separator, and product name directly from that
 *      line. This is the highest-confidence signal on the card.
 *
 *   2. FRONT wordmark — if the back line didn't resolve, we scan the front
 *      OCR text for a product-line wordmark from a curated whitelist of
 *      current product lines (Origins, Contenders, Select, Immaculate,
 *      Chronicles, Prizm, Mosaic, Optic, Chrome, Heritage, etc.).
 *
 * The extractor returns both the product line (which maps to cardData.set)
 * and the brand when they can be read together. Callers should prefer this
 * value over whatever Holo / the base OCR analyzer produced for set —
 * downstream lookup chains already trust set/collection as authoritative,
 * so getting this wrong cascades into the eBay query.
 */

// Product-line whitelist keyed by brand. The values are the canonical
// display casing used throughout PackScan + eBay. Matching is
// case-insensitive and done against collapsed whitespace.
//
// Keep entries UPPERCASE-free here — this is the source of truth for
// display casing ("Origins", not "ORIGINS").
export const PRODUCT_LINES: Record<string, string[]> = {
  Panini: [
    // Put multi-word and longer names FIRST so they win the scan when they
    // contain shorter single-word names (e.g. "National Treasures" before
    // "Treasures", "Rookies & Stars" before "Stars", "Donruss Optic" before
    // "Donruss"). The extractor takes the first whitelist match it finds.
    'National Treasures', 'Crown Royale', 'Rookies & Stars', 'Plates & Patches',
    'Gold Standard', 'One & One', 'Donruss Optic',
    // Single-word product lines.
    'Origins', 'Contenders', 'Select', 'Immaculate', 'Chronicles', 'Prizm',
    'Mosaic', 'Optic', 'Obsidian', 'Spectra', 'Phoenix', 'Absolute',
    'Certified', 'Limited', 'Elite', 'Donruss', 'Score', 'Flawless',
    'Impeccable', 'Illusions', 'Zenith', 'XR', 'Playbook', 'Legacy',
    'Luminance', 'Revolution', 'Prestige',
  ],
  Topps: [
    'Allen & Ginter', 'Stadium Club', 'Tier One', 'Gypsy Queen', 'Gold Label',
    'Triple Threads', 'Five Star',
    'Chrome', 'Heritage', 'Finest', 'Archives', 'Big League', 'Pristine',
    'Dynasty', 'Transcendent', 'Opening Day', 'Update', 'Update Series',
    'Series One', 'Series Two', 'Series 1', 'Series 2',
  ],
  Bowman: [
    'Bowman Draft', 'Bowman Chrome', 'Bowman Sterling', 'Bowman Platinum',
    'Bowman Inception',
    'Draft', 'Chrome', 'Sterling', 'Platinum', 'Inception',
  ],
  'Upper Deck': [
    'Young Guns', 'The Cup', 'SP Authentic', 'SP Game Used',
    'SP', 'SPx', 'Ultimate', 'Artifacts', 'Ice', 'Premier', 'Black Diamond',
  ],
  Pokemon: [
    // Pokemon set names vary wildly; the back copyright line is almost
    // always the best signal. Keep the whitelist short — any set name
    // extracted from the back line is also preferred.
    'Base Set', 'Jungle', 'Fossil', 'Team Rocket', 'Crown Zenith',
    'Obsidian Flames', 'Paradox Rift',
  ],
};

const BRAND_ALIASES: Record<string, string> = {
  panini: 'Panini',
  topps: 'Topps',
  bowman: 'Bowman',
  'upper deck': 'Upper Deck',
  'upperdeck': 'Upper Deck',
  ud: 'Upper Deck',
  pokemon: 'Pokemon',
  'pokémon': 'Pokemon',
};

export interface ProductLineMatch {
  /** Canonical brand (e.g. "Panini", "Topps", "Bowman", "Upper Deck"). */
  brand: string;
  /** Canonical product-line name (e.g. "Origins", "Chrome"). Maps to cardData.set. */
  productLine: string;
  /** Where the match came from — for logging and confidence gating. */
  source: 'back-copyright' | 'front-wordmark' | 'back-wordmark';
  /** Verbatim OCR text that triggered the match (for logging). */
  evidence: string;
}

/**
 * Collapse whitespace (newlines, tabs, multi-spaces) so multi-word product
 * names still match when OCR breaks them across lines. e.g. the back copyright
 *   "2020 PANINI\n-\nORIGINS\nFOOTBALL"
 * should still read as one line.
 */
function normalizeOcrText(raw: string): string {
  return (raw || '').replace(/\s+/g, ' ').trim();
}

/**
 * Look up the canonical brand name from a lowercase token (or phrase).
 * Returns null when the token is not a known brand alias.
 */
function canonicalBrand(tokenLower: string): string | null {
  const key = tokenLower.trim();
  return BRAND_ALIASES[key] || null;
}

/**
 * Scan a single string for any whitelisted product-line name from the given
 * brand. Matching is case-insensitive and word-bounded. Returns the canonical
 * display name on hit, else null.
 */
function findProductLine(text: string, brand: string): string | null {
  const lines = PRODUCT_LINES[brand] || [];
  const normLower = text.toLowerCase();
  for (const name of lines) {
    const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(normLower)) return name;
  }
  return null;
}

/**
 * Parse the back-of-card copyright / product line (e.g.
 * "2020 PANINI - ORIGINS FOOTBALL") and return the extracted brand +
 * product line. This is the highest-confidence signal.
 *
 * Regex handles:
 *   "2020 PANINI - ORIGINS FOOTBALL"
 *   "2020 PANINI ORIGINS FOOTBALL"         (no dash)
 *   "© 2020 PANINI - ORIGINS FOOTBALL"
 *   "PANINI - REVOLUTION FOOTBALL 2020"    (brand-first, year trailing)
 *   "PANINI-ORIGINS FOOTBALL"              (tight dash)
 *   "TOPPS CHROME BASEBALL 2023"
 *   "BOWMAN DRAFT 2022"
 */
export function parseBackCopyrightLine(backOcr: string): ProductLineMatch | null {
  const text = normalizeOcrText(backOcr);
  if (!text) return null;

  // Pattern 1: "<YEAR?> <BRAND> [-] <PRODUCT> [SPORT]"
  //   The brand alternation is anchored to known brands so we don't match
  //   random copyright lines. The PRODUCT capture is up to 3 words (most
  //   product lines are 1-2 words; "National Treasures" is 2, etc.).
  const brandAlt = Object.keys(BRAND_ALIASES).join('|');
  // Build the pattern with flexible year/dash placement.
  const patterns: RegExp[] = [
    // "<YEAR> <BRAND> - <PRODUCT>(1-3 words)"
    new RegExp(`(\\d{4})\\s+(${brandAlt})\\s*[-–—]?\\s*([A-Za-z&\\s]{2,40}?)(?=\\s+(?:football|baseball|basketball|hockey|soccer|tcg|pokemon|pokémon)\\b|\\s*$|\\s*[\\r\\n©®™])`, 'i'),
    // "<BRAND> - <PRODUCT> ... <YEAR>" (year trailing)
    new RegExp(`(${brandAlt})\\s*[-–—]\\s*([A-Za-z&\\s]{2,40}?)\\s+(?:football|baseball|basketball|hockey|soccer)\\b`, 'i'),
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;

    // Figure out which group is brand vs product based on which pattern hit.
    let brandToken: string;
    let productRaw: string;
    if (/^\d{4}$/.test(m[1])) {
      // Pattern 1: [_, year, brand, product]
      brandToken = m[2];
      productRaw = m[3];
    } else {
      // Pattern 2: [_, brand, product]
      brandToken = m[1];
      productRaw = m[2];
    }

    const brand = canonicalBrand(brandToken.toLowerCase().trim());
    if (!brand) continue;

    // Clean the product name: strip sport suffixes, trailing punctuation.
    const productClean = productRaw
      .replace(/\b(football|baseball|basketball|hockey|soccer|tcg|pokemon|pokémon)\b/gi, '')
      .replace(/[.,;:·]+$/g, '')
      .trim();
    if (!productClean || productClean.length < 2) continue;

    // If the cleaned product name is itself in the whitelist, use the
    // canonical casing. Otherwise use what we extracted (title-cased).
    // First try matching against the full matched line so multi-word
    // product names containing the brand ("Bowman Draft", "Bowman Chrome")
    // resolve correctly even when our capture group only has the trailing
    // word.
    const canonical =
      findProductLine(m[0], brand) ||
      findProductLine(productClean, brand) ||
      titleCase(productClean);
    return {
      brand,
      productLine: canonical,
      source: 'back-copyright',
      evidence: m[0].trim(),
    };
  }

  return null;
}

/**
 * Scan an OCR text block (front preferred) for a product-line wordmark.
 * Used when the back copyright line didn't resolve. The brand must already
 * be known (usually from OCR or Holo) to scope the whitelist.
 *
 * Returns null when no whitelist word was found.
 */
export function findFrontWordmark(frontOcr: string, knownBrand: string | null | undefined): ProductLineMatch | null {
  const text = normalizeOcrText(frontOcr);
  if (!text) return null;

  // Brand-scope the whitelist iteration. The all-brand fallback exists for
  // the "no brand info at all" case — NOT for cards whose brand is known
  // but isn't a multi-product-line publisher (Donruss, Fleer, Score, Leaf,
  // Pacific, Pinnacle, Skybox, etc.). Letting those fall through used to
  // cross-match into Bowman/Topps/Panini whitelists; e.g. 1990 Donruss
  // back-of-card bios contain the word "draft" and were resolving to
  // Bowman's bare "Draft" entry.
  const trimmedKnown = (knownBrand ?? '').trim();
  let brandsToTry: string[];
  if (trimmedKnown.length === 0) {
    // No brand info — try every whitelisted brand.
    brandsToTry = Object.keys(PRODUCT_LINES);
  } else {
    const canonical = canonicalBrand(trimmedKnown.toLowerCase()) || trimmedKnown;
    if (PRODUCT_LINES[canonical]) {
      // Recognized multi-product-line brand — scope to just that one.
      brandsToTry = [canonical];
    } else {
      // Brand is known but isn't a multi-product-line publisher. Don't
      // cross-leak into other brands' whitelists.
      return null;
    }
  }

  for (const brand of brandsToTry) {
    const hit = findProductLine(text, brand);
    if (hit) {
      return {
        brand,
        productLine: hit,
        source: 'front-wordmark',
        evidence: hit,
      };
    }
  }
  return null;
}

/**
 * Single entry point: given front + back OCR text and an optional brand hint,
 * return the best product-line match found, or null.
 *
 * Priority order:
 *   1. Back copyright line (highest confidence).
 *   2. Front wordmark.
 *   3. Back wordmark scan (fallback for cards whose back has no clean
 *      copyright line but still includes the product name somewhere).
 */
export function extractProductLine(
  frontOcr: string,
  backOcr: string,
  knownBrand?: string | null,
): ProductLineMatch | null {
  const back = parseBackCopyrightLine(backOcr);
  if (back) return back;

  const front = findFrontWordmark(frontOcr, knownBrand);
  if (front) return front;

  const backWordmark = findFrontWordmark(backOcr, knownBrand);
  if (backWordmark) {
    return { ...backWordmark, source: 'back-wordmark' };
  }

  return null;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}
