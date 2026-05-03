/**
 * Decide whether the search-verify pass should fire after eBay comps come back.
 *
 * Field choice: `PickerListing.price` (number) — defined in
 * `server/ebayPickerSearch.ts` (interface PickerListing). That's the
 * authoritative dollar amount the existing scorer (line 482) and avg-price
 * tier breakdown already use, so reusing it keeps this gate's notion of
 * "low-confidence price" aligned with everything else.
 */

import type { PickerListing } from './ebayPickerSearch';

export interface GateInput {
  active: PickerListing[] | null | undefined;
  year: number | string | null | undefined;
  /** Average sold price across `active` listings (in dollars). */
  averagePriceUsd?: number | null | undefined;
}

export interface GateDecision {
  /** True iff the verifier should fire. */
  fire: boolean;
  /** One-word reason for telemetry. */
  reason: 'zero' | 'low-confidence' | 'low-confidence-vintage' | 'enough-comps' | 'gated-off';
}

/**
 * Decide whether search-verify should fire.
 *
 * Hard gate: ebay returned 0 comps -> fire (existing behavior).
 *
 * Broad gate (only when `broadEnabled` is true):
 *   - <=2 comps AND average price < $5 -> fire (low-confidence)
 *   - <=1 comp  AND year < 2010         -> fire (low-confidence-vintage)
 *
 * Otherwise -> do not fire.
 */
export function decideSearchVerifyGate(
  input: GateInput,
  broadEnabled: boolean,
): GateDecision {
  const count = input.active?.length ?? 0;
  if (count === 0) return { fire: true, reason: 'zero' };
  if (!broadEnabled) return { fire: false, reason: 'enough-comps' };

  const avgPrice = typeof input.averagePriceUsd === 'number' && Number.isFinite(input.averagePriceUsd)
    ? input.averagePriceUsd
    : null;
  if (count <= 2 && avgPrice != null && avgPrice < 5) {
    return { fire: true, reason: 'low-confidence' };
  }

  const yearNum = typeof input.year === 'number'
    ? input.year
    : (input.year != null ? Number(String(input.year)) : NaN);
  if (count <= 1 && Number.isFinite(yearNum) && yearNum < 2010) {
    return { fire: true, reason: 'low-confidence-vintage' };
  }

  return { fire: false, reason: 'enough-comps' };
}

/**
 * Compute average sold price across active listings. Returns null when
 * no listings have a parseable price.
 */
export function computeAveragePrice(active: PickerListing[] | null | undefined): number | null {
  if (!active || active.length === 0) return null;
  const prices: number[] = [];
  for (const l of active) {
    const p = (l as any)?.price ?? (l as any)?.soldPrice ?? (l as any)?.priceUsd;
    const n = typeof p === 'number' ? p : Number(p);
    if (Number.isFinite(n) && n > 0) prices.push(n);
  }
  if (prices.length === 0) return null;
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}
