// Admin-user identification.
//
// Mirrors the case-insensitive ADMIN_EMAIL pattern already used by
// server/scanQuota.ts, server/feedback.ts, and server/routes.ts so a single
// env var (default: daniel.j.holley@gmail.com) drives every admin-only code
// path.
//
// TODO: when proper user-auth roles land, replace these helpers with a
// `users.role === 'admin'` check. Until then, hardcoded email is the source
// of truth.
//
// Pure helpers (`isAdminEmail`, `shouldAutoSaveCard`) live in
// `./adminUser.pure.ts` and are db-free so tests can import them under tsx
// without `DATABASE_URL`. The DB-backed lookup `isAdminUser` lives here.

import { eq } from 'drizzle-orm';
import { db } from '@db';
import { users } from '@shared/schema';
import { isAdminEmail } from './adminUser.pure';

export { isAdminEmail, shouldAutoSaveCard } from './adminUser.pure';

/**
 * DB-backed: does this user id belong to the admin? Returns false for
 * unknown ids and for users whose email is missing. Caller-cached when
 * called per-batch so we don't issue one query per item.
 */
export async function isAdminUser(userId: number | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return isAdminEmail(row?.email);
}
