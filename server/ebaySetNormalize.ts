// PR X — eBay query-string-only set normalization.
//
// Sellers list season-spanning Topps releases as "Series 2" (numeric)
// while the card back prints the literal "Series Two" (spelled out).
// Stage-1 OCR captures the printed text verbatim, so the picker's eBay
// query mismatches every listing whose title uses the numeric form.
// This helper rewrites ONLY the value passed into the eBay query
// builder; the response payload, the Card Info header, the result page
// header, and the Sheet column all keep the literal "Series Two".
//
// The mapping is intentionally surgical (two entries) per user spec —
// do not extend without explicit user direction. If we discover further
// seller-vs-printer naming mismatches we'll add narrow rules then.

const SET_QUERY_MAP: Array<{ pattern: RegExp; replacement: string }> = [
  // "Series Two" → "Series 2" (case-insensitive, whole-phrase). The
  // canonical output capitalization matches what eBay sellers use most
  // often ("Series 2") regardless of the input case.
  { pattern: /\bSeries\s+Two\b/gi, replacement: 'Series 2' },
  { pattern: /\bSeries\s+One\b/gi, replacement: 'Series 1' },
];

/**
 * Rewrite a `set` value for eBay query construction only.
 *
 * Returns the input unchanged unless one of the spelled-out series
 * names is present, in which case the numeric form is substituted.
 * Never mutates other tokens in the string. Whitespace and case
 * outside the matched phrase pass through unchanged.
 *
 * Examples:
 *   normalizeSetForEbay("Series Two")              → "Series 2"
 *   normalizeSetForEbay("series two")              → "Series 2"
 *   normalizeSetForEbay("Topps Series Two")        → "Topps Series 2"
 *   normalizeSetForEbay("Series One")              → "Series 1"
 *   normalizeSetForEbay("Update Series")           → "Update Series"
 *   normalizeSetForEbay("Stadium Club")            → "Stadium Club"
 *   normalizeSetForEbay("")                        → ""
 *
 * Apply this only at the moment a `set` value is being concatenated
 * into the eBay query string (i.e. immediately before the call to
 * `buildPickerQuery`). DO NOT pass the rewritten value into anything
 * the user sees, anything that gets persisted, or any non-eBay query
 * surface.
 */
export function normalizeSetForEbay(setName: string | null | undefined): string {
  if (!setName) return '';
  let out = setName;
  for (const rule of SET_QUERY_MAP) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/**
 * Reduce a printed year (string or number) to the integer the picker
 * uses when constructing an eBay query for non-season sports. Returns
 * null when the input is unparseable.
 */
function yearStartInt(year: number | string | null | undefined): number | null {
  if (year == null) return null;
  if (typeof year === 'number') return Number.isFinite(year) ? year : null;
  const s = year.trim();
  if (!s) return null;
  const m = s.match(/(\d{4})/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the year token used inside the eBay query string.
 *
 * Season sports (Basketball, Hockey) — and any card whose printed back
 * already carries a YYYY-YY footer captured in `yearPrintedRaw` — are
 * listed by sellers using the season-range form ("2024-25 Panini
 * Prizm…"), so we emit YYYY-YY for those scans. For non-season sports
 * we fall back to the four-digit start year, which is the form sellers
 * use for Baseball, Football, etc.
 *
 * The integer `year` field on combined results stays the source of
 * truth for backend logic — Sheet writes use the rendered string via
 * `formatYearForSheet`, the picker query uses this helper, and the UI
 * uses the existing `displayYear` helper (`client/src/lib/seasonYear`).
 *
 * Returns '' when the input is unusable so the caller can omit the
 * token entirely (mirrors the existing buildPickerQuery contract).
 */
export function formatYearForEbay(opts: {
  year: number | string | null | undefined;
  sport?: string | null;
  yearPrintedRaw?: string | null;
}): string {
  const start = yearStartInt(opts.year);
  if (start == null) {
    // Last-resort: the raw printed string. Trim the surrounding © cruft
    // out so we don't paste "© 2024-25 PANINI" verbatim into _nkw.
    const raw = (opts.yearPrintedRaw ?? '').trim();
    if (raw) {
      const range = raw.match(/(\d{4})\s*[-/]\s*(\d{2,4})/);
      if (range) {
        const second = range[2].length === 4 ? range[2].slice(2) : range[2].padStart(2, '0');
        return `${range[1]}-${second}`;
      }
      const yearOnly = raw.match(/(19|20)\d{2}/);
      if (yearOnly) return yearOnly[0];
    }
    return '';
  }
  // Season-range from yearPrintedRaw wins over sport-only inference
  // because the printed value tells us what's actually on the card.
  const raw = (opts.yearPrintedRaw ?? '').trim();
  if (raw) {
    const range = raw.match(/(\d{4})\s*[-/]\s*(\d{2,4})/);
    if (range) {
      const first = range[1];
      const second = range[2].length === 4 ? range[2].slice(2) : range[2].padStart(2, '0');
      // Sanity gate: only accept the printed range when the start year
      // matches the canonical integer year. A divergence usually means
      // the back imprint lags the set year (PR #206/W (b2) override),
      // in which case we fall through to sport-based formatting.
      if (Number.parseInt(first, 10) === start) {
        return `${first}-${second}`;
      }
    }
  }
  if (isSeasonSport(opts.sport)) {
    const next = (start + 1) % 100;
    return `${start}-${next.toString().padStart(2, '0')}`;
  }
  return String(start);
}

/**
 * Same logic as `formatYearForEbay` but always returns at least the
 * 4-digit start year (never empty when the input parses), because the
 * Sheet's Year column is read by humans — leaving it blank loses
 * information they could otherwise glance at.
 */
export function formatYearForSheet(opts: {
  year: number | string | null | undefined;
  sport?: string | null;
  yearPrintedRaw?: string | null;
}): string {
  const formatted = formatYearForEbay(opts);
  if (formatted) return formatted;
  const start = yearStartInt(opts.year);
  return start == null ? '' : String(start);
}

const SEASON_SPORTS = new Set(['basketball', 'hockey']);

function isSeasonSport(sport: string | null | undefined): boolean {
  if (!sport) return false;
  return SEASON_SPORTS.has(sport.trim().toLowerCase());
}
