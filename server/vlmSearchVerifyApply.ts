/**
 * Pure helpers for filtering corrections produced by the Gemini+Search
 * verifier (`server/vlmSearchVerify.ts`) before applying them to a scan
 * result. No I/O — fully unit-testable.
 *
 * Design notes
 * ------------
 * - `player` corrections are NEVER auto-applied. The user owns name
 *   identification end-to-end; the verifier can suggest one in its
 *   reasoning, but auto-flipping a name on a card the user is staring
 *   at would be more confusing than helpful.
 * - `cardNumber` corrections that strip an alphabetic prefix (e.g.
 *   "US175" → "100") are dropped. The prefix carries a checklist
 *   distinction (Update Series, Bowman Chrome Prospects, etc.) that the
 *   verifier sometimes loses when a search hits the cross-reference for
 *   a different printing.
 * - `set` corrections that are stylistic-only after canonicalization
 *   (e.g. "Series One" ↔ "Series 1") are dropped — same value, different
 *   spelling, no point churning the saved row.
 * - `year` and `brand` corrections pass through whenever they actually
 *   change the value.
 */

export interface IdentityFields {
  player?: string | null;
  year?: string | number | null;
  brand?: string | null;
  set?: string | null;
  cardNumber?: string | null;
}

export interface SafeCorrections {
  brand?: string;
  year?: string;
  set?: string;
  cardNumber?: string;
}

export interface FilterResult {
  safe: SafeCorrections;
  dropped: Array<{ field: string; reason: string; original: any; proposed: any }>;
}

const DIGIT_WORDS: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
};

/**
 * Lowercase, strip non-alphanumeric characters (keeping spaces),
 * normalize standalone digit-words to digits, and collapse whitespace.
 * Used to compare set names so "Series One" and "Series 1" are treated
 * as the same value.
 */
export function canonicalizeSetString(s: string | null | undefined): string {
  if (s == null) return '';
  let out = String(s).toLowerCase();
  // Drop punctuation but keep spaces and alphanumerics.
  out = out.replace(/[^a-z0-9\s]/g, ' ');
  // Tokenize, normalize digit words.
  const tokens = out.split(/\s+/).filter(Boolean).map((tok) => DIGIT_WORDS[tok] ?? tok);
  return tokens.join(' ').trim();
}

/**
 * True iff the original card number begins with one or more letters
 * (followed by either a digit or a dash) and the proposed value drops
 * that alphabetic prefix entirely. Examples:
 *   "US175" → "100"     : true  (unsafe — prefix dropped)
 *   "BCP-100" → "100"   : true  (unsafe — alpha-prefix dropped)
 *   "100" → "US175"     : false (allowed — adding info)
 *   "100" → "99"        : false (allowed — both bare numerics)
 *   null / "" inputs    : false (no prefix to mismatch)
 */
export function isCardNumberPrefixMismatch(
  original: string | null | undefined,
  proposed: string | null | undefined,
): boolean {
  if (original == null || proposed == null) return false;
  const o = String(original).trim();
  const p = String(proposed).trim();
  if (!o || !p) return false;
  // Original has alphabetic prefix? Match leading letters followed by
  // an optional dash and at least one digit.
  const m = o.match(/^([A-Za-z]+)[-]?(\d+.*)$/);
  if (!m) return false;
  const prefix = m[1];
  // Proposed has NO leading letters → prefix was stripped.
  if (/^[A-Za-z]/.test(p)) return false;
  // Proposed is a bare numeric (or numeric-leading) — that's the unsafe case.
  if (!/^\d/.test(p)) return false;
  // Belt-and-suspenders: don't false-positive when proposed simply equals
  // a different alpha-prefixed value (caught by the regex above already,
  // but explicit is clearer).
  void prefix;
  return true;
}

function asTrimmedString(v: any): string {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * Filter the verifier's `corrections` map down to only the safe-to-apply
 * fields. The input shape is whatever the caller has already flattened
 * out of `SearchVerifyResult.corrections` (an array on the verifier; the
 * caller is expected to fold it into `{ field: newValue }`).
 */
export function filterUnsafeCorrections(
  original: IdentityFields,
  corrections: Record<string, any>,
): FilterResult {
  const safe: SafeCorrections = {};
  const dropped: FilterResult['dropped'] = [];

  for (const [field, raw] of Object.entries(corrections ?? {})) {
    const proposed = asTrimmedString(raw);
    const originalRaw = asTrimmedString(
      (original as any)[field] != null ? (original as any)[field] : '',
    );

    // 1. player corrections are never auto-applied.
    if (field === 'player') {
      dropped.push({
        field,
        reason: 'player corrections never auto-applied',
        original: originalRaw,
        proposed,
      });
      continue;
    }

    // 2. Skip unknown fields (only brand/year/set/cardNumber are routable).
    if (field !== 'brand' && field !== 'year' && field !== 'set' && field !== 'cardNumber') {
      dropped.push({
        field,
        reason: 'unknown field',
        original: originalRaw,
        proposed,
      });
      continue;
    }

    // 3. No-op: proposed equals original.
    if (proposed === originalRaw) {
      dropped.push({ field, reason: 'no change', original: originalRaw, proposed });
      continue;
    }

    // 4. cardNumber: drop prefix-strip mismatches.
    if (field === 'cardNumber' && isCardNumberPrefixMismatch(originalRaw, proposed)) {
      dropped.push({
        field,
        reason: 'cardNumber prefix mismatch (alpha prefix stripped)',
        original: originalRaw,
        proposed,
      });
      continue;
    }

    // 5. set: drop stylistic-only changes.
    if (field === 'set' && canonicalizeSetString(originalRaw) === canonicalizeSetString(proposed)) {
      dropped.push({
        field,
        reason: 'set change is stylistic-only after canonicalization',
        original: originalRaw,
        proposed,
      });
      continue;
    }

    // 6. Empty proposed — never overwrite a non-empty value with empty.
    if (!proposed) {
      dropped.push({
        field,
        reason: 'proposed value is empty',
        original: originalRaw,
        proposed,
      });
      continue;
    }

    // Made it through every guard — keep the correction.
    (safe as any)[field] = proposed;
  }

  return { safe, dropped };
}

/**
 * Returns true when the corrected `set` value is materially different
 * from the original (i.e., not just a stylistic re-spelling). Materially
 * different means: after canonicalization, the corrected set's tokens are
 * NOT a subset of the original's tokens AND vice versa is also false.
 *
 * Examples:
 *   ("Upper Deck", "Upper Deck Minor League") → true   (added "minor league")
 *   ("Upper Deck Minor League", "Upper Deck") → true   (removed "minor league")
 *   ("Series One", "Series 1")                → false  (stylistic — already filtered upstream)
 *   ("Topps Chrome", "Topps Chrome")          → false  (no change)
 *   (null, "Upper Deck Minor League")         → true   (added a Set when none)
 */
export function isMaterialSetChange(
  originalSet: string | null | undefined,
  correctedSet: string | null | undefined,
): boolean {
  const o = canonicalizeSetString(originalSet);
  const c = canonicalizeSetString(correctedSet);
  if (!c) return false;          // no correction or empty
  if (o === c) return false;     // identical (stylistic gate already drops these upstream)
  if (!o) return true;           // adding a Set when there was none
  // Compare token sets — material change iff neither is a subset of the other.
  const ot = new Set(o.split(/\s+/).filter(Boolean));
  const ct = new Set(c.split(/\s+/).filter(Boolean));
  const oSubsetOfC = [...ot].every((t) => ct.has(t));
  const cSubsetOfO = [...ct].every((t) => ot.has(t));
  // If one is a strict subset of the other (different size), it's a
  // material change — tokens were added or removed.
  if (oSubsetOfC && !cSubsetOfO) return true;
  if (cSubsetOfO && !oSubsetOfC) return true;
  // Disjoint or partial overlap — definitely material.
  return true;
}