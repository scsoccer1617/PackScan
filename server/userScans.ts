// ─── User Scan Logger ───────────────────────────────────────────────────────
//
// Logs every save event to the `user_scans` table. This is intentionally
// walled off from `card_database` (the curated source of truth) — the admin
// reviews these rows offline at /admin/scans and decides what (if anything)
// gets promoted to the reference catalog.
//
// Three actions:
//   - 'confirmed'           → 👍 path; user said the scanner output is correct as-is
//   - 'declined_edited'     → 👎 path; user opened the edit modal, made corrections, and saved
//   - 'saved_no_feedback'   → user just hit save without using either thumb
//
// Per-field diff:
//   `fieldsChanged` is the list of field names where the saved value differs
//   from the detected value. Empty on 'confirmed'. Populated on
//   'declined_edited' and 'saved_no_feedback' (we still record the diff so
//   plain-save rows are useful for review).
//
// Failure mode:
//   This module is best-effort. We never want a logger glitch to block the
//   user's actual save. All callers wrap `logUserScan` in try/catch (or
//   .catch(() => {})) so a thrown error here is swallowed and logged.

import { db } from '@db';
import { eq } from 'drizzle-orm';
import { userScans, type UserScan, type UserScanAction } from '@shared/schema';

/**
 * The detected (raw scanner) and final (post-edit) value bundles.
 * Everything is optional — older callers may not have every field. The
 * logger only persists what's provided.
 */
export interface ScanFieldValues {
  sport?: string | null;
  playerFirstName?: string | null;
  playerLastName?: string | null;
  brand?: string | null;
  collection?: string | null;
  set?: string | null;
  cardNumber?: string | null;
  year?: number | null;
  variant?: string | null;
  team?: string | null;
  cmpNumber?: string | null;
  serialNumber?: string | null;
  foilType?: string | null;
  isRookie?: boolean | null;
  isAuto?: boolean | null;
  isNumbered?: boolean | null;
  isFoil?: boolean | null;
}

export interface LogUserScanParams {
  userId: number | null | undefined;
  cardId?: number | null;
  userAction: UserScanAction;
  detected: ScanFieldValues;
  /**
   * What the user actually saved. If omitted, falls back to `detected`
   * (i.e. nothing was edited). Always provide for 'declined_edited' and
   * 'saved_no_feedback' paths so the diff is meaningful.
   */
  final?: ScanFieldValues;
  frontImage?: string | null;
  backImage?: string | null;
  scpScore?: number | null;
  scpMatchedTitle?: string | null;
  cardDbCorroborated?: boolean | null;
  analyzerVersion?: string | null;
  /**
   * Full Gemini analyzer payload at scan time. Stored as stringified JSON
   * in the `gemini_snapshot` column and used by /admin/scans as the
   * authoritative DETECTED snapshot — separate from the per-field
   * `detectedX` columns so the admin sees exactly what the model emitted
   * before any client-side coercion. Accepts an object (will be stringified)
   * or a pre-stringified JSON string. Persisted on insert; never mutated
   * by updateUserScan.
   */
  geminiSnapshot?: unknown;
  /**
   * Override the auto-computed diff. Use when the client tells us
   * authoritatively which fields it considers "changed" (e.g. when the user
   * pressed 👍 and we want to record fieldsChanged=[] regardless of any
   * coercion noise between detected/final).
   */
  fieldsChangedOverride?: string[];
}

function serializeSnapshot(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  try { return JSON.stringify(v); } catch { return null; }
}

/**
 * Compute the per-field diff between `detected` and `final`. Order matches
 * the column ordering in the user_scans table for stable review display.
 */
export function diffScanFields(detected: ScanFieldValues, final: ScanFieldValues): string[] {
  const keys: (keyof ScanFieldValues)[] = [
    'sport',
    'playerFirstName',
    'playerLastName',
    'brand',
    'collection',
    'set',
    'cardNumber',
    'year',
    'variant',
    'team',
    'cmpNumber',
    'serialNumber',
    'foilType',
    'isRookie',
    'isAuto',
    'isNumbered',
    'isFoil',
  ];
  const changed: string[] = [];
  for (const k of keys) {
    const a = normalizeForCompare(detected[k]);
    const b = normalizeForCompare(final[k]);
    if (a !== b) changed.push(k);
  }
  return changed;
}

function normalizeForCompare(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') return v.trim().toLowerCase();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

/**
 * Insert one row into user_scans. Best-effort — returns the inserted id on
 * success, undefined on any failure (logged but never thrown).
 */
export async function logUserScan(params: LogUserScanParams): Promise<number | undefined> {
  try {
    const detected = params.detected ?? {};
    const final = params.final ?? detected;

    const fieldsChanged = params.fieldsChangedOverride
      ? [...params.fieldsChangedOverride]
      : diffScanFields(detected, final);

    const [row] = await db
      .insert(userScans)
      .values({
        userId: params.userId ?? null,
        cardId: params.cardId ?? null,
        userAction: params.userAction,
        fieldsChanged,
        // Detected
        detectedSport: nullableString(detected.sport),
        detectedPlayerFirstName: nullableString(detected.playerFirstName),
        detectedPlayerLastName: nullableString(detected.playerLastName),
        detectedBrand: nullableString(detected.brand),
        detectedCollection: nullableString(detected.collection),
        detectedSet: nullableString(detected.set),
        detectedCardNumber: nullableString(detected.cardNumber),
        detectedYear: nullableNumber(detected.year),
        detectedVariant: nullableString(detected.variant),
        detectedTeam: nullableString(detected.team),
        detectedCmpNumber: nullableString(detected.cmpNumber),
        detectedSerialNumber: nullableString(detected.serialNumber),
        detectedFoilType: nullableString(detected.foilType),
        detectedIsRookie: nullableBool(detected.isRookie),
        detectedIsAuto: nullableBool(detected.isAuto),
        detectedIsNumbered: nullableBool(detected.isNumbered),
        detectedIsFoil: nullableBool(detected.isFoil),
        // Final
        finalSport: nullableString(final.sport),
        finalPlayerFirstName: nullableString(final.playerFirstName),
        finalPlayerLastName: nullableString(final.playerLastName),
        finalBrand: nullableString(final.brand),
        finalCollection: nullableString(final.collection),
        finalSet: nullableString(final.set),
        finalCardNumber: nullableString(final.cardNumber),
        finalYear: nullableNumber(final.year),
        finalVariant: nullableString(final.variant),
        finalTeam: nullableString(final.team),
        finalCmpNumber: nullableString(final.cmpNumber),
        finalSerialNumber: nullableString(final.serialNumber),
        finalFoilType: nullableString(final.foilType),
        finalIsRookie: nullableBool(final.isRookie),
        finalIsAuto: nullableBool(final.isAuto),
        finalIsNumbered: nullableBool(final.isNumbered),
        finalIsFoil: nullableBool(final.isFoil),
        // Images + metadata
        frontImage: params.frontImage ?? null,
        backImage: params.backImage ?? null,
        scpScore: params.scpScore != null ? String(params.scpScore) : null,
        scpMatchedTitle: params.scpMatchedTitle ?? null,
        cardDbCorroborated: params.cardDbCorroborated ?? null,
        analyzerVersion: params.analyzerVersion ?? null,
        geminiSnapshot: serializeSnapshot(params.geminiSnapshot),
      })
      .returning({ id: userScans.id });

    return row?.id;
  } catch (err) {
    console.error('[user_scans] logUserScan failed:', err);
    return undefined;
  }
}

/**
 * Update an existing user_scans row identified by `scanId`. Used to
 * promote a row from 'analyzed_no_save' (logged at analyze time) to one
 * of the three save actions when the user actually saves the card.
 *
 * Best-effort — returns true on success, false on any failure (logged but
 * never thrown). If the row doesn't exist (e.g. logging failed at
 * analyze time, or scanId is stale), the caller can fall back to a fresh
 * insert via logUserScan.
 */
export async function updateUserScan(
  scanId: number,
  params: Omit<LogUserScanParams, 'userId'> & { userId?: number | null },
): Promise<boolean> {
  try {
    const detected = params.detected ?? {};
    const final = params.final ?? detected;

    const fieldsChanged = params.fieldsChangedOverride
      ? [...params.fieldsChangedOverride]
      : diffScanFields(detected, final);

    // Promote anonymous analyze-time rows to authed when userId is now
    // known (e.g. session became available between analyze and save).
    // `undefined` skips the column so we never blow away a userId that
    // was already attached to the row.
    const userIdSet = params.userId != null ? params.userId : undefined;

    const result = await db
      .update(userScans)
      .set({
        ...(userIdSet !== undefined ? { userId: userIdSet } : {}),
        cardId: params.cardId ?? null,
        userAction: params.userAction,
        fieldsChanged,
        // Final-only update on save — detected and the geminiSnapshot were
        // set at analyze time and we deliberately don't touch them here so
        // the audit row always reflects the original scanner output for
        // review purposes (even after the user edits and re-saves).
        finalSport: nullableString(final.sport),
        finalPlayerFirstName: nullableString(final.playerFirstName),
        finalPlayerLastName: nullableString(final.playerLastName),
        finalBrand: nullableString(final.brand),
        finalCollection: nullableString(final.collection),
        finalSet: nullableString(final.set),
        finalCardNumber: nullableString(final.cardNumber),
        finalYear: nullableNumber(final.year),
        finalVariant: nullableString(final.variant),
        finalTeam: nullableString(final.team),
        finalCmpNumber: nullableString(final.cmpNumber),
        finalSerialNumber: nullableString(final.serialNumber),
        finalFoilType: nullableString(final.foilType),
        finalIsRookie: nullableBool(final.isRookie),
        finalIsAuto: nullableBool(final.isAuto),
        finalIsNumbered: nullableBool(final.isNumbered),
        finalIsFoil: nullableBool(final.isFoil),
        // Save-time metadata that the analyze call may not have known.
        frontImage: params.frontImage ?? undefined,
        backImage: params.backImage ?? undefined,
        scpScore: params.scpScore != null ? String(params.scpScore) : undefined,
        scpMatchedTitle: params.scpMatchedTitle ?? undefined,
        cardDbCorroborated: params.cardDbCorroborated ?? undefined,
        analyzerVersion: params.analyzerVersion ?? undefined,
      })
      .where(eq(userScans.id, scanId))
      .returning({ id: userScans.id });

    return result.length > 0;
  } catch (err) {
    console.error(`[user_scans] updateUserScan(scanId=${scanId}) failed:`, err);
    return false;
  }
}

function nullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  return String(v);
}

function nullableNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nullableBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return null;
}

export type { UserScan };
