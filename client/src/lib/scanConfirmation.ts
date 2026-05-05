/**
 * Client-side helpers for PR AA confirmation logging.
 *
 * computeConfirmationDiff(original, edited) — returns the list of
 * changed field names so the caller can branch:
 *   - empty array  → nothing changed, fire /api/scan-confirmations
 *   - non-empty    → user edited something; PR Z's /api/scan-corrections
 *                    handles that (intentional no-op here so PR AA can
 *                    merge before PR Z without losing data).
 *
 * logScanConfirmation(input) — POSTs to /api/scan-confirmations.
 * Returns true once the request has been issued; rejects only on
 * caller errors (no input). Network failures are swallowed because
 * the endpoint is fire-and-forget on both ends.
 */

export type ConfirmationSource = 'single_scan' | 'bulk_review';

export interface PredictedFields {
  player?: string | null;
  year?: string | number | null;
  brand?: string | null;
  set?: string | null;
  collection?: string | null;
  cardNumber?: string | null;
  variant?: string | null;
  potentialVariant?: string | null;
}

const COMPARED_FIELDS: (keyof PredictedFields)[] = [
  'player',
  'year',
  'brand',
  'set',
  'collection',
  'cardNumber',
  'variant',
  'potentialVariant',
];

function normalizeForCompare(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.trim();
  return String(v).trim();
}

/**
 * Returns the field names that differ between `original` (analyzer
 * snapshot) and `edited` (form values at Save time). Whitespace is
 * trimmed and number/string mismatches collapse so that a model
 * `year: 2026` compares equal to a typed `"2026"`.
 */
export function computeConfirmationDiff(
  original: PredictedFields,
  edited: PredictedFields,
): string[] {
  const diff: string[] = [];
  for (const k of COMPARED_FIELDS) {
    const a = normalizeForCompare(original[k]);
    const b = normalizeForCompare(edited[k]);
    if (a !== b) diff.push(k);
  }
  return diff;
}

export interface LogConfirmationInput {
  scanId: string;
  source: ConfirmationSource;
  predicted: PredictedFields;
  originalConfidence?: number | string | null;
  frontImageUrl?: string | null;
  backImageUrl?: string | null;
}

/**
 * Fire the confirmation event. Issues fetch and resolves true once the
 * request has been sent. Errors are swallowed — this is best-effort.
 */
export async function logScanConfirmation(input: LogConfirmationInput): Promise<boolean> {
  if (!input?.scanId) return false;
  const body = {
    scan_id: input.scanId,
    source: input.source,
    predicted: {
      player: input.predicted.player ?? null,
      year: input.predicted.year ?? null,
      brand: input.predicted.brand ?? null,
      set: input.predicted.set ?? null,
      collection: input.predicted.collection ?? null,
      card_number: input.predicted.cardNumber ?? null,
      variant: input.predicted.variant ?? null,
      potential_variant: input.predicted.potentialVariant ?? null,
    },
    original_confidence: input.originalConfidence ?? null,
    front_image_url: input.frontImageUrl ?? null,
    back_image_url: input.backImageUrl ?? null,
  };
  try {
    await fetch('/api/scan-confirmations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    return true;
  } catch {
    // Best-effort sink — never propagate.
    return false;
  }
}
