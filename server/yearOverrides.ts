/**
 * Belt-and-suspenders year overrides applied AFTER the VLM year parse and
 * BEFORE the Sheet/CardDB write. The VLM prompt already does the right
 * thing on most cards, but on dense modern Topps backs (e.g. 2026 Topps
 * Series One bases with 5+ stat rows ending in "25 TEAM" + flavor prose
 * mentioning "June 2025") the model occasionally flips to year=2025
 * despite the legal-strip "© 2026 THE TOPPS COMPANY" imprint and the
 * CMP123053 code. This net catches those misses by reading the OCR back
 * text directly — if the imprint/CMP signal is unambiguous, we override.
 *
 * Brand-gated: only fires when the OCR back text actually contains the
 * Topps imprint string. Non-Topps brands are untouched. No-op when the
 * VLM year is already 2026.
 */

const TOPPS_2026_IMPRINT = /[©&]\s*2026\s+THE\s+TOPPS/i;
const TOPPS_2026_CMP = /\bCMP\s*12305\d\b/i;

export interface YearOverrideContext {
  scanId?: string | null;
  vlmYear: number | null | undefined;
  ocrBackText: string | null | undefined;
}

export interface YearOverrideResult {
  year: number;
  overridden: boolean;
  reason?: string;
}

/**
 * Apply the 2026 Topps imprint year override. Returns the (possibly
 * overridden) year and a flag indicating whether the override fired.
 *
 * Override fires when ALL of:
 *   - OCR back text matches "© 2026 THE TOPPS" / "& 2026 THE TOPPS"
 *     (the OCR sometimes reads © as &) OR contains a CMP123053-style code
 *   - VLM year is not already 2026
 *
 * When fired, returns 2026 and logs a one-line marker so the override is
 * traceable from the deploy logs.
 */
export function applyTopps2026ImprintOverride(ctx: YearOverrideContext): YearOverrideResult {
  const vlmYear = typeof ctx.vlmYear === 'number' ? ctx.vlmYear : null;
  const ocrBackText = (ctx.ocrBackText ?? '').toString();

  if (vlmYear === 2026) {
    return { year: 2026, overridden: false };
  }

  if (!ocrBackText) {
    return { year: vlmYear ?? 0, overridden: false };
  }

  const imprintMatch = TOPPS_2026_IMPRINT.test(ocrBackText);
  const cmpMatch = TOPPS_2026_CMP.test(ocrBackText);

  if (!imprintMatch && !cmpMatch) {
    return { year: vlmYear ?? 0, overridden: false };
  }

  const reasonParts: string[] = [];
  if (imprintMatch) reasonParts.push('imprint');
  if (cmpMatch) reasonParts.push('cmp');
  const reason = `2026_topps_${reasonParts.join('+')}`;

  console.log(
    `[yearOverride] year_override_2026_topps_imprint scanId=${ctx.scanId ?? 'unknown'} oldYear=${vlmYear ?? 'null'} newYear=2026 reason=${reason}`,
  );

  return { year: 2026, overridden: true, reason };
}
