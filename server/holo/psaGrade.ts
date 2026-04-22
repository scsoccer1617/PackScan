/**
 * Mapping helpers that translate a Holo overall grade (1.0 \u2013 10.0 in 0.5
 * increments) into the PSA integer grade that eBay sellers actually type
 * into their slab listings. PSA does NOT issue half grades (BGS does),
 * so we floor half-grade Holo scores:
 *
 *   Holo 10.0 \u2192 PSA 10  ("GEM MT 10")
 *   Holo  9.5 \u2192 PSA 9   (conservative \u2014 a 9.5 still grades PSA 9 more often than 10)
 *   Holo  9.0 \u2192 PSA 9   ("MINT 9")
 *   Holo  8.5 \u2192 PSA 8
 *   Holo  8.0 \u2192 PSA 8   ("NM-MT 8")
 *   \u2026
 *
 * A PSA 1 is the floor of eBay\u2019s meaningful graded market (anything below
 * that is generally listed as "damaged" without a slab photo). We clamp
 * to [1, 10].
 */
export function holoOverallToPsaInt(overall: number | null | undefined): number | null {
  if (overall == null || !Number.isFinite(overall)) return null;
  // Floor for half-grade Holo scores \u2014 PSA has no half grades, and PSA is
  // historically stricter than an optimistic half-step-up prediction.
  const floored = Math.floor(overall);
  if (floored < 1) return 1;
  if (floored > 10) return 10;
  return floored;
}

/**
 * Build the eBay keyword used to filter listings to a specific PSA slab.
 * Returns null when the grade is unknown or out of range.
 *
 * Example: `psaKeyword(8)` \u2192 `"PSA 8"`.
 */
export function psaKeyword(psaInt: number | null | undefined): string | null {
  if (psaInt == null || !Number.isFinite(psaInt)) return null;
  if (psaInt < 1 || psaInt > 10) return null;
  return `PSA ${psaInt}`;
}
