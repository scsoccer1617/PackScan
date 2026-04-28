// Season-year display helpers.
//
// In Basketball and Hockey, cards are described by season (e.g. "2021-22"),
// not calendar year. Our DB stores a single integer (the starting year of
// the season) for storage simplicity and because the catalog data is
// authored that way. These helpers derive the human-facing season label.
//
// Football and Baseball use a single calendar year, so they pass through.

const SEASON_SPORTS = new Set(['Basketball', 'Hockey']);

/**
 * Render a season label for a year + sport combination.
 *
 * Basketball/Hockey: 2021 → "2021-22"
 * Football/Baseball/etc: 2021 → "2021"
 * Missing/zero year: returns null
 */
export function formatSeasonYear(
  year: number | string | null | undefined,
  sport?: string | null
): string | null {
  const numericYear =
    typeof year === 'number' ? year : year ? parseInt(String(year), 10) : NaN;
  if (!Number.isFinite(numericYear) || numericYear <= 0) return null;
  if (sport && SEASON_SPORTS.has(sport)) {
    const next = (numericYear + 1) % 100;
    return `${numericYear}-${next.toString().padStart(2, '0')}`;
  }
  return String(numericYear);
}

/**
 * Parse a user-entered year string back to the integer year stored in the
 * DB. Accepts "2021", "2021-22", "2021-2022", "2021/22", or "2021/2022".
 * Always returns the START year (the integer the DB stores). Returns null
 * if the input is unparseable or the season range doesn't span exactly one
 * year (so "2021-23" is rejected as a typo).
 *
 * The `/` separator is accepted because users sometimes type the season
 * the way it's printed on the back of newer cards ("2024/25").
 */
export function parseSeasonYearInput(input: string): number | null {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return null;
  const seasonMatch = trimmed.match(/^(\d{4})\s*[-/]\s*(\d{2,4})$/);
  if (seasonMatch) {
    const first = parseInt(seasonMatch[1], 10);
    let second = parseInt(seasonMatch[2], 10);
    if (seasonMatch[2].length === 2) {
      // Two-digit suffix → glue to the same century as `first`, except when
      // wrapping a century (e.g. "1999-00" → 1999/2000).
      const century = Math.floor(first / 100) * 100;
      second = century + second;
      if (second < first) second += 100;
    }
    if (second !== first + 1) return null;
    if (first < 1900 || first > new Date().getFullYear() + 1) return null;
    return first;
  }
  const yearMatch = trimmed.match(/^(\d{4})$/);
  if (yearMatch) {
    const y = parseInt(yearMatch[1], 10);
    if (y < 1900 || y > new Date().getFullYear() + 1) return null;
    return y;
  }
  return null;
}

/** Sports for which the season-year format applies. */
export function isSeasonSport(sport?: string | null): boolean {
  return !!sport && SEASON_SPORTS.has(sport);
}

/**
 * Render the year for display, preferring Gemini's verbatim print over the
 * stored integer. This matches what's actually printed on the card:
 *   - Footer "2024-25" → display "2024-25"
 *   - "©2025 THE TOPPS COMPANY" → display "2025"
 *   - Missing yearPrintedRaw → fall back to formatSeasonYear(year, sport)
 *
 * `year` is still the single source of truth for backend logic (eBay
 * search, Sheet writes, CardDB lookups). Only display changes.
 */
export function displayYear(
  year: number | string | null | undefined,
  sport?: string | null,
  yearPrintedRaw?: string | null
): string | null {
  if (yearPrintedRaw && typeof yearPrintedRaw === 'string') {
    const trimmed = yearPrintedRaw.trim();
    // Try to extract a season range first (YYYY-YY, YYYY/YY, YYYY-YYYY).
    const rangeMatch = trimmed.match(/(\d{4})\s*[-/]\s*(\d{2,4})/);
    if (rangeMatch) {
      const first = rangeMatch[1];
      const secondRaw = rangeMatch[2];
      const second2 =
        secondRaw.length === 4 ? secondRaw.slice(2) : secondRaw.padStart(2, '0');
      return `${first}-${second2}`;
    }
    // Otherwise look for a single 4-digit year inside the string.
    const yearMatch = trimmed.match(/(19|20)\d{2}/);
    if (yearMatch) return yearMatch[0];
  }
  return formatSeasonYear(year, sport);
}
