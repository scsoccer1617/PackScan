/**
 * Guard against Gemini player hallucinations by cross-checking the VLM's
 * proposed last name against what the front + back OCR text actually says.
 *
 * Motivation — bulk-37-958 (Allensworth):
 *   - Front + back OCR clearly show "JERMAINE ALLENSWORTH" 3x.
 *   - Gemini emitted players=[{firstName:"Jermaine", lastName:"Dye"}] —
 *     a hallucination on a card that hadn't shipped yet.
 *   - The legacy rule-based combine pipeline correctly extracted
 *     lastName="Allensworth" but Gemini's authoritative overlay won.
 *   - Search-verify then queried the wrong player, found a real Dye card,
 *     validated, and shipped the wrong identity.
 *
 * This module runs BEFORE the search-verify gate so the verifier queries
 * the corrected player when a confident legacy fallback is available.
 */
export type PlayerConsistencyResult =
  | { decision: 'gemini-ok' }
  | { decision: 'fallback-to-legacy'; reason: string }
  | { decision: 'no-confident-player'; reason: string };

/**
 * Normalize a name/OCR token: uppercase, strip non-alphanumerics, collapse
 * whitespace. "O'Neill" → "ONEILL", "Smith-Jones" → "SMITH JONES" (we keep
 * the space so multi-segment last names still emit two distinct tokens).
 */
function normalize(value: string | null | undefined): string {
  if (!value) return '';
  // Apostrophes are stripped in place (not turned into a space) so "O'Neill"
  // and "ONeill" both normalize to "ONEILL" — matching how Vision OCR
  // typically renders them. All other non-alphanumerics (hyphens, spaces,
  // dots, commas) become a single space so multi-segment names yield
  // distinct tokens.
  return value
    .toString()
    .replace(/['\u2019]+/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

/**
 * Tokenize OCR text into a Set of normalized whole-word tokens for O(1)
 * containment checks. We split on the same character class as `normalize`
 * so a name's normalized form (which has no punctuation) compares directly
 * against the OCR's token set.
 */
function tokenize(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  // Strip apostrophes in place so OCR's "O'NEILL" tokenizes to "ONEILL"
  // (matches the same handling in `normalize`). Then split on any other
  // non-alphanumeric run.
  const upper = text.toString().replace(/['\u2019]+/g, '').toUpperCase();
  const tokens = upper.split(/[^A-Z0-9]+/).filter((t) => t.length > 0);
  return new Set(tokens);
}

/**
 * Whole-word containment: every space-separated normalized chunk of `name`
 * must appear as its own token in the OCR token set. This makes "Ye" NOT
 * match OCR "DYE" (substring), but "ALLENSWORTH" DOES match OCR
 * "JERMAINE ALLENSWORTH 122". For multi-segment last names ("Smith-Jones"
 * normalizes to "SMITH JONES"), every segment must be present.
 */
function nameAppearsInOcr(name: string, ocrTokens: Set<string>): boolean {
  const normalized = normalize(name);
  if (!normalized) return false;
  const parts = normalized.split(' ').filter(Boolean);
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (!ocrTokens.has(part)) return false;
  }
  return true;
}

export function checkPlayerOcrConsistency(input: {
  geminiLastName?: string | null;
  geminiFirstName?: string | null;
  legacyLastName?: string | null;
  legacyFirstName?: string | null;
  frontOcrText?: string | null;
  backOcrText?: string | null;
}): PlayerConsistencyResult {
  const geminiLast = (input.geminiLastName ?? '').toString().trim();
  // No Gemini lastName to challenge — the legacy/multi-player path already
  // owns the identity, so nothing to do here.
  if (!geminiLast) return { decision: 'gemini-ok' };

  const ocrTokens = tokenize(
    `${input.frontOcrText ?? ''} ${input.backOcrText ?? ''}`,
  );

  const geminiNormalized = normalize(geminiLast);
  if (geminiNormalized && nameAppearsInOcr(geminiLast, ocrTokens)) {
    return { decision: 'gemini-ok' };
  }

  const legacyLast = (input.legacyLastName ?? '').toString().trim();
  const legacyNormalized = normalize(legacyLast);
  if (
    legacyNormalized
    && legacyNormalized !== geminiNormalized
    && nameAppearsInOcr(legacyLast, ocrTokens)
  ) {
    return {
      decision: 'fallback-to-legacy',
      reason: 'gemini lastName not in OCR; legacy lastName matched OCR',
    };
  }

  return {
    decision: 'no-confident-player',
    reason: 'gemini lastName not in OCR; no legacy fallback available',
  };
}
