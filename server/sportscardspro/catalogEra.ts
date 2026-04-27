/**
 * Catalog-era policy for visual foil/parallel detection.
 *
 * Background: visualFoilDetector classifies foil presence and colour from
 * a single front image using Vision API labels + per-region pixel
 * sampling. Its heuristics are catalog-agnostic — a glossy 1991 Donruss
 * base card with a white name plate and flash hot-spot will read
 * "Silver Crackle Foil" at confidence 0.6+ even though *no Silver
 * parallel exists for any 1981-1993 Donruss baseball card*.
 *
 * Downstream the detector's output is consumed by `dualSideOCR.ts` as
 * either an authoritative `foilType` (high confidence + DB match) or a
 * `parallelSuspected + suggestedColor` hint that opens the parallel
 * picker. Both paths are wrong for vintage flagship sets that
 * structurally don't have colour parallels: the catalog era predates
 * colour-bucketed parallels entirely.
 *
 * This module encodes that catalog truth as a per-era policy. When
 * `allowParallels` is false, callers should reject visual foil results
 * outright — no auto-apply, no parallelSuspected fallback. The card is
 * a base card. Period.
 *
 * Scope: this is a deliberately narrow, manually-curated allow-list of
 * eras that are KNOWN to have zero colour parallels in the SCP catalog.
 * When the catalog era is unknown (e.g. 2026 Topps), the policy
 * returns { allowParallels: true } and the existing detector flow runs
 * unchanged. We only short-circuit eras we are certain about.
 *
 * Variation parallels vs colour parallels: this module is concerned
 * ONLY with colour-bucketed parallels (Silver, Gold, Pink, Blue Foil,
 * Refractor, etc.). Era-specific *variations* (Donruss Diamond Kings,
 * Topps Traded "T" suffix card numbers, Fleer Pro-Visions, Upper Deck
 * Heroes inserts) are not parallels — they are distinct catalog
 * entries with their own product IDs — and are unaffected by this
 * gate.
 */

export interface CatalogEraPolicy {
  /**
   * If false, the visual foil detector's output should be discarded
   * entirely for this brand+year. The card is a base card; do not
   * auto-apply a foilType, do not set parallelSuspected, do not show
   * a parallel picker for a colour the detector reported.
   */
  allowParallels: boolean;
  /**
   * Human-readable explanation that appears in scan logs / indicators
   * so dealers and operators can see why a visual hint was suppressed.
   */
  reason?: string;
}

/**
 * Brand+year ranges with no colour parallels in the SCP catalog.
 *
 * Each entry is INCLUSIVE on both ends. Brand string matches against
 * `combined.brand` after the existing brand-extraction pipeline (so
 * "Donruss" matches; "Donruss Optic" — a modern parallel-heavy set —
 * does NOT, because the brand-extractor distinguishes the two).
 *
 * Curated from SCP catalog inspection. Conservative: only eras where
 * EVERY card from EVERY set under the brand was base-only. When in
 * doubt, leave the era off this list — the existing FoilDB / SCP
 * catalog cross-checks are the second line of defence.
 *
 * Maintenance note: when adding an era, verify by spot-checking 5+
 * random cards from that brand+year on SCP. If any card has even one
 * bracketed parallel, the era does NOT belong here — instead, narrow
 * the entry to specific years that are clean.
 */
const NO_PARALLEL_ERAS: Array<{
  brand: string;
  yearMin: number;
  yearMax: number;
  reason: string;
}> = [
  {
    brand: "Donruss",
    yearMin: 1981,
    yearMax: 1993,
    reason: "1981-1993 Donruss baseball had no colour parallels (Diamond Kings and Rated Rookies are variations, not parallels)",
  },
  {
    brand: "Topps",
    yearMin: 1981,
    yearMax: 1992,
    reason: "1981-1992 Topps baseball flagship had no colour parallels (Tiffany was a separate factory set, not a per-card parallel)",
  },
  {
    brand: "Fleer",
    yearMin: 1981,
    yearMax: 1991,
    reason: "1981-1991 Fleer baseball had no colour parallels",
  },
  {
    brand: "Score",
    yearMin: 1988,
    yearMax: 1993,
    reason: "1988-1993 Score baseball had no colour parallels",
  },
  {
    brand: "Upper Deck",
    yearMin: 1989,
    yearMax: 1992,
    reason: "1989-1992 Upper Deck baseball had no colour parallels (Hologram was a security feature on every card, not a parallel bucket)",
  },
];

/**
 * Resolve the catalog-era policy for a given brand+year.
 *
 * Brand matching is case-insensitive and whitespace-tolerant. Year
 * must be a valid integer in [1900, 2100] — out-of-range or missing
 * year returns { allowParallels: true } so the detector flow runs
 * unchanged on cards we couldn't year-stamp.
 */
export function getCatalogEraPolicy(
  brand: string | null | undefined,
  year: number | null | undefined,
): CatalogEraPolicy {
  if (!brand || typeof year !== "number") {
    return { allowParallels: true };
  }
  if (year < 1900 || year > 2100) {
    return { allowParallels: true };
  }
  const normalizedBrand = brand.trim().toLowerCase();
  for (const era of NO_PARALLEL_ERAS) {
    if (era.brand.toLowerCase() !== normalizedBrand) continue;
    if (year < era.yearMin || year > era.yearMax) continue;
    return { allowParallels: false, reason: era.reason };
  }
  return { allowParallels: true };
}
