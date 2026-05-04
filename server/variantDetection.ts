/**
 * Variant detection for eBay picker results.
 *
 * Scans the titles of the listings returned by the picker and flags the
 * scan when at least one title contains scarcity / variation / error
 * verbiage that would skew an averaged comp price (SP, SSP, Variation,
 * Error, etc.). The user reviews flagged rows manually — this is a
 * SIGNAL, not a filter, so the listings themselves are still kept in the
 * picker output (see spec §"Edge cases").
 *
 * Vocabulary comes from the user's spec at
 * /home/user/workspace/variant_detection_spec.md.
 *
 * The detector returns the unique terms that fired and how many listings
 * had at least one match — both useful for log-side debugging even if
 * only the boolean lands in the spreadsheet today.
 */

export interface VariantDetectionResult {
  isPotentialVariant: boolean;
  matchedTerms: string[];
  matchedListingCount: number;
}

// Each entry: a label (lowercase, used as the matchedTerm key) plus the
// regex pattern that fires for it. Word boundaries are mandatory on the
// scarcity codes so "SP" doesn't fire on every word that happens to end
// in "sp" — we accept the false positive on the literal "starting
// pitcher SP" string per spec, but won't fire on e.g. "Cardinals".
const PATTERNS: Array<{ term: string; re: RegExp }> = [
  // Scarcity codes — most-specific first so SSP/SSSP/USSP don't get
  // double-counted under SP. The regex set is unioned with `i`, so
  // listing them all is fine; we de-dupe at the matchedTerms layer.
  { term: 'sssp', re: /\bSSSP\b/i },
  { term: 'ussp', re: /\bUSSP\b/i },
  { term: 'ssp', re: /\bSSP\b/i },
  { term: 'sp', re: /\bSP\b/i },
  // Multi-word phrases.
  { term: 'ssp case hit', re: /\bSSP\s+case\s+hit\b/i },
  { term: 'case hit', re: /\bcase\s+hit\b/i },
  { term: 'photo variation', re: /\bphoto\s+variation\b/i },
  { term: 'image variation', re: /\bimage\s+variation\b/i },
  { term: 'action variation', re: /\baction\s+variation\b/i },
  { term: 'nickname variation', re: /\bnickname\s+variation\b/i },
  // Generic single-word markers.
  { term: 'variation', re: /\bvariation\b/i },
  { term: 'variant', re: /\bvariant\b/i },
  { term: 'gimmick', re: /\bgimmick\b/i },
  { term: 'error', re: /\berror\b/i },
  { term: 'corrected', re: /\bcorrected\b/i },
];

export function detectPotentialVariant(
  listingTitles: string[],
): VariantDetectionResult {
  if (!Array.isArray(listingTitles) || listingTitles.length === 0) {
    return { isPotentialVariant: false, matchedTerms: [], matchedListingCount: 0 };
  }
  const matched = new Set<string>();
  let matchedListingCount = 0;
  for (const titleRaw of listingTitles) {
    if (typeof titleRaw !== 'string' || titleRaw.length === 0) continue;
    let listingMatched = false;
    for (const { term, re } of PATTERNS) {
      if (re.test(titleRaw)) {
        matched.add(term);
        listingMatched = true;
      }
    }
    if (listingMatched) matchedListingCount += 1;
  }
  return {
    isPotentialVariant: matched.size > 0,
    matchedTerms: Array.from(matched),
    matchedListingCount,
  };
}
