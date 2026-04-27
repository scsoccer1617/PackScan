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
 * DB. Accepts "2021" or "2021-22" (or "2021-2022"). Returns null if invalid.
 *
 * Validates that the second half of a season label is exactly one year after
 * the first (so "2021-23" is rejected as a typo).
 */
export function parseSeasonYearInput(input: string): number | null {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return null;
  const seasonMatch = trimmed.match(/^(\d{4})\s*-\s*(\d{2,4})$/);
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
