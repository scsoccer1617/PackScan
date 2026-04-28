/**
 * Sanitize Gemini VLM response sentinels at the boundary where JSON
 * becomes our domain model.
 *
 * Why: PR #166 added a "skip the Confirm-parallel picker when Gemini
 * returned no parallel" gate. The gate checks `_gemini.parallel.name`
 * for a non-empty trimmed string. PR #167 added a `GeminiParallel`
 * scan-log column reading from the same source.
 *
 * In production, Gemini interprets the prompt's "if no parallel,
 * indicate so" literally and returns the STRING "None detected" (and
 * variants) rather than null/empty. That non-empty string slips past
 * PR #166's gate, the picker renders "Potential parallel detected:
 * None detected · Yes/No", and the scan log column logs the sentinel
 * instead of empty. Both bugs collapse to "the parser's contract was
 * 'name is empty when no parallel' and Gemini didn't honour it."
 *
 * This module makes the contract enforceable server-side: any time we
 * parse a Gemini response, we run it through `normalizeGeminiResult`
 * first, and downstream consumers (overlay, scan log, picker gate)
 * never have to think about sentinels again.
 *
 * Set field gets a lighter touch — set names can legitimately contain
 * "Base" / "Base Set" (Topps Series One Base Set is a real set), so
 * we only strip obvious sentinels there.
 */
const PARALLEL_SENTINELS = new Set([
  '',
  'none',
  'none detected',
  'none found',
  'not detected',
  'base',
  'base set',
  'base card',
  'no parallel',
  'n/a',
  'na',
  'null',
  'undefined',
]);

const SET_SENTINELS = new Set([
  '',
  'none',
  'none detected',
  'unknown',
  'n/a',
  'na',
  'null',
  'undefined',
]);

function normalize(value: unknown, sentinels: Set<string>): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (sentinels.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/** Returns null if the string is a parallel sentinel ("None detected",
 *  "Base", "N/A", etc., case-insensitive). Otherwise the trimmed string. */
export function normalizeParallelName(value: unknown): string | null {
  return normalize(value, PARALLEL_SENTINELS);
}

/** Returns null if the string is a set sentinel ("Unknown", "N/A", etc.).
 *  Real set names containing "Base" are preserved verbatim. */
export function normalizeSetName(value: unknown): string | null {
  return normalize(value, SET_SENTINELS);
}

/**
 * Sanitize a parsed Gemini result in place. Returns the same object
 * (mutated) for ergonomic chaining at the parse boundary. Accepts an
 * unknown-shaped record because callers pass JSON.parse output before
 * the typed cast — we just defensively narrow what we touch.
 */
export function normalizeGeminiResult<T extends Record<string, any>>(raw: T): T {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, any>;
    if (r.parallel && typeof r.parallel === 'object') {
      r.parallel.name = normalizeParallelName(r.parallel.name);
    }
    if ('set' in r) {
      r.set = normalizeSetName(r.set);
    }
  }
  return raw;
}
