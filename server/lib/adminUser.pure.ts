// Pure helpers for admin-user identification + bulk-scan routing decision.
// Db-free so tests can import them under tsx without `DATABASE_URL`.
// See `./adminUser.ts` for the DB-backed `isAdminUser` lookup.

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'daniel.j.holley@gmail.com').toLowerCase();

/** Pure: is this email the admin? Case-insensitive. Empty/null → false. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.trim().toLowerCase() === ADMIN_EMAIL;
}

/**
 * Pure decision helper: should this card auto-sync to the user's sheet, or
 * route to the review queue? Mirrors the gate logic in
 * server/bulkScan/processor.ts so the rule is testable in isolation.
 *
 *   admin    → ALWAYS review (regardless of verdict / confidence)
 *   non-admin → review when gate verdict !== 'auto_save' OR dryRun
 *
 * Hybrid spec (PR AB): admin = mandatory review, external = current
 * confidence-gate behavior unchanged.
 */
export function shouldAutoSaveCard(input: {
  reviewerIsAdmin: boolean;
  gateVerdict: 'auto_save' | 'review';
  dryRun: boolean;
}): boolean {
  if (input.reviewerIsAdmin) return false;
  if (input.dryRun) return false;
  return input.gateVerdict === 'auto_save';
}
