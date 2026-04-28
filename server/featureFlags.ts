/**
 * Centralized feature flags for the scan pipeline.
 *
 * Flags resolve from process.env at call time so tests / Replit Secrets
 * can flip them without a redeploy.
 */

/**
 * CardDB lookup gate.
 *
 * When false (the default as of PR #162), the OCR pipeline skips the
 * card_database lookup entirely and lets Gemini VLM output flow through
 * as the authoritative scan signal. The CardDB code, types, imports, and
 * SQL helpers are left intact — flip this to "true" to re-enable.
 *
 * Accepts: "true" / "1" / "yes" (case-insensitive). Anything else → off.
 */
export function isCardDbLookupEnabled(): boolean {
  const raw = (process.env.CARDDB_LOOKUP_ENABLED ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}
