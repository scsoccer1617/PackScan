/**
 * Client-side helper for the ML training-data correction sink.
 *
 * Two pieces:
 *   1) computeFieldDiff(original, edited) — produce the array of
 *      {field, original_value, corrected_value} changes between a
 *      pre-edit snapshot and the saved form, normalising whitespace
 *      and null/undefined/'' so trivial UI churn is not logged.
 *   2) postScanCorrections({ scanId, source, original, edited, ... })
 *      — fire-and-forget POST to /api/scan-corrections. Returns the
 *      number of rows posted; resolves to 0 (without hitting the
 *      network) when the diff is empty, and never throws — failures
 *      are logged to console.warn so save flows can ignore the result.
 *
 * Used by:
 *   - client/src/pages/BulkScanBatch.tsx (ReviewCard.handleSave)
 *   - client/src/pages/ScanResult.tsx    (handleSaveCardInfo)
 */

export const FIELDS_TO_LOG = [
  'player',
  'year',
  'brand',
  'set',
  'collection',
  'cardNumber',
  'parallel',
  'subset',
  'team',
  'manufacturer',
  'rookie',
  'autograph',
  'memorabilia',
  'serialNumber',
  'foilType',
] as const;

export type LoggableField = (typeof FIELDS_TO_LOG)[number];

export type FieldValues = Record<string, unknown>;

/**
 * Coerce a value into the canonical string form used for diffing.
 *   - null / undefined / '' all collapse to ''
 *   - whitespace is trimmed and runs collapsed
 *   - finite numbers become their plain string form
 *   - booleans stringify
 *   - objects / arrays JSON-stringify (best-effort)
 */
export function normalizeForDiff(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim().replace(/\s+/g, ' ');
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface FieldDiff {
  field: string;
  original_value: string;
  corrected_value: string;
}

/**
 * Diff two flat field maps. Only fields whose normalised values
 * differ are returned. By default we only consider FIELDS_TO_LOG; pass
 * a custom list to widen.
 */
export function computeFieldDiff(
  original: FieldValues | null | undefined,
  edited: FieldValues | null | undefined,
  fields: readonly string[] = FIELDS_TO_LOG,
): FieldDiff[] {
  const out: FieldDiff[] = [];
  const before = original ?? {};
  const after = edited ?? {};
  for (const f of fields) {
    const a = normalizeForDiff(before[f]);
    const b = normalizeForDiff(after[f]);
    if (a === b) continue;
    out.push({ field: f, original_value: a, corrected_value: b });
  }
  return out;
}

export interface PostCorrectionsArgs {
  scanId: string;
  source: 'single_scan' | 'bulk_review';
  original: FieldValues | null | undefined;
  edited: FieldValues | null | undefined;
  /** Optional override of fields to consider for the diff. */
  fields?: readonly string[];
  frontImageUrl?: string | null;
  backImageUrl?: string | null;
  originalConfidence?: number | null;
  notes?: string | null;
}

type Fetcher = typeof fetch;

/**
 * Fire-and-forget post the diff to /api/scan-corrections. Returns a
 * promise resolving to the number of corrections submitted; resolves
 * to 0 when the diff is empty (no network call) and never throws —
 * failures land in console.warn.
 *
 * The optional second parameter exists so unit tests can inject a
 * mock fetch without monkey-patching globals.
 */
export async function postScanCorrections(
  args: PostCorrectionsArgs,
  fetcher?: Fetcher,
): Promise<number> {
  const corrections = computeFieldDiff(args.original, args.edited, args.fields);
  if (corrections.length === 0) return 0;
  if (!args.scanId) return 0;

  const body = {
    scan_id: args.scanId,
    source: args.source,
    front_image_url: args.frontImageUrl ?? null,
    back_image_url: args.backImageUrl ?? null,
    original_confidence: args.originalConfidence ?? null,
    notes: args.notes ?? null,
    corrections,
  };

  const fetchImpl: Fetcher | undefined =
    fetcher ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!fetchImpl) return 0;

  try {
    await fetchImpl('/api/scan-corrections', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn('[scanCorrections] post failed:', (err as Error)?.message ?? err);
  }
  return corrections.length;
}
