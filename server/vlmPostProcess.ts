/**
 * VLM post-processing validators applied after Gemini's raw output but
 * before the combined result is committed to the scan row.
 *
 * Today this houses the "Big League" era guard: Topps Big League is a
 * separate product line that LAUNCHED IN 2018. When the model attributes
 * `set="Big League"` to a pre-2018 card, the value is impossible by
 * construction — that scan was historically getting normalized to an
 * empty `set` with no fallback, which produced a useless eBay query
 * ("1987 Topps Big League Dwight Gooden #603" → 0 results).
 *
 * The guard lives in its own module so the rules can grow independently
 * of `vlmApply.ts` without bloating that file's already-dense overlay
 * logic. Callers pass the (post-normalization) brand/year/set strings
 * and receive a corrected `set` plus a marker describing the correction
 * for telemetry.
 */

const BIG_LEAGUE_LAUNCH_YEAR = 2018;
const VINTAGE_TOPPS_FALLBACK_CUTOFF = 1995;

export type SetCorrectionReason =
  | 'big-league-era-guard'
  | 'vintage-topps-empty-set-fallback';

export interface SetEraGuardResult {
  set: string;
  setCorrected: SetCorrectionReason | null;
}

/**
 * Apply Big League era guard + vintage Topps empty-set fallback.
 *
 * - When `set` (case-insensitive) contains "big league" and `year < 2018`,
 *   override to "Topps". (Big League launched in 2018; pre-2018 attribution
 *   is impossible by construction.)
 * - When the brand is Topps, year < 1995, and `set` is empty/unrecognized,
 *   fall back to "Topps" so the eBay query has a non-empty set descriptor.
 * - Modern Topps cards with empty set are LEFT alone — we don't know which
 *   Topps line ("Series One", "Update", "Heritage") and guessing would be
 *   worse than a query without a set descriptor.
 */
export function applySetEraGuard(input: {
  set: string;
  brand: string;
  year: number | null | undefined;
}): SetEraGuardResult {
  const rawSet = (input.set ?? '').toString();
  const brand = (input.brand ?? '').toString().trim();
  const yearNum = typeof input.year === 'number' && Number.isFinite(input.year) ? input.year : 0;

  const setLower = rawSet.trim().toLowerCase();
  const brandLower = brand.toLowerCase();

  if (setLower.includes('big league') && yearNum > 0 && yearNum < BIG_LEAGUE_LAUNCH_YEAR) {
    console.warn(
      `[vlmPostProcess] Big League era violation: year=${yearNum} brand=${brand} — overriding set to "Topps"`,
    );
    return { set: 'Topps', setCorrected: 'big-league-era-guard' };
  }

  if (
    brandLower === 'topps' &&
    yearNum > 0 &&
    yearNum < VINTAGE_TOPPS_FALLBACK_CUTOFF &&
    (setLower.length === 0 || setLower === 'unknown')
  ) {
    return { set: 'Topps', setCorrected: 'vintage-topps-empty-set-fallback' };
  }

  return { set: rawSet, setCorrected: null };
}
