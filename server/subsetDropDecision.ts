// PR #252 — Conditional subset drop on the eBay picker query.
//
// Background: `_geminiSubset` is populated by Gemini VLM vision only — see
// `subset_origin_trace.md`. There is no OCR / DB grounding. For the
// 1995 UD Collector's Choice #60 Greg Maddux scenario (`bulk-38-1020`),
// Gemini emitted "All-Star Special Edition" via the non-whitelisted-set
// fallback path in `vlmApply.ts:248-254`. That biased the picker's top-5
// active comps toward graded All-Star insert listings, dragging the Sheet
// `averagePrice` to $7.40 while the single-scan UI (which re-fetches comps
// without subset) showed $0.99 for the same identity.
//
// Rule (single source of truth, used by both bulk picker and single-scan UI):
//
//   Drop subset from the eBay query when BOTH:
//     1. The card is single-player (`gemini.players.length === 1`), AND
//     2. The subset arrived via the `vlmApply-fallback` path (a salvage of
//        a non-whitelisted Gemini.set, demonstrably less grounded than the
//        dedicated `subset` JSON field).
//
//   Keep subset (current behavior) when:
//     - Multi-player card (Team Leaders, Record Breakers, etc.) — subset is
//       the only disambiguator.
//     - Single-player card with subset from Gemini's dedicated `subset`
//       JSON field (`gemini-direct`) — whitelisted path is trusted.
//     - No subset at all (no-op).
//     - Empty player list (cannot evaluate single-player heuristic safely).

export type SubsetSource = 'gemini-direct' | 'vlmApply-fallback' | null;

export interface SubsetDropInput {
  /** `combined.players.length` after `applyGeminiToCombined`. */
  playerCount: number;
  /** `combined._geminiSubset` (empty/null when absent). */
  subset: string | null | undefined;
  /** `combined._geminiSubsetSource` set by `vlmApply.ts`. */
  subsetSource: SubsetSource;
}

export interface SubsetDropDecision {
  /** True when subset should be folded into the eBay query. */
  useSubsetInComps: boolean;
  /** Verbatim source the subset came from; null when no subset present. */
  subsetSource: SubsetSource;
  /**
   * Human-readable drop reason for telemetry. Null when subset was kept
   * (or absent). Surfaces in the scan-log Indicators column as
   * `subsetDropped=<reason>`.
   */
  subsetDroppedReason: string | null;
}

/**
 * Decide whether subset should participate in the eBay picker query for
 * this scan. Pure function — no side effects, no I/O. Called server-side
 * once per analyze, the result is forwarded to the single-scan UI as
 * `compsQuery.useSubsetInComps` so both surfaces converge.
 */
export function decideSubsetDrop(input: SubsetDropInput): SubsetDropDecision {
  const subset = (input.subset ?? '').toString().trim();
  const subsetSource: SubsetSource =
    input.subsetSource === 'gemini-direct' || input.subsetSource === 'vlmApply-fallback'
      ? input.subsetSource
      : null;

  // No subset to act on — keep `useSubsetInComps=true` (the picker query
  // template is a no-op when subset is empty anyway). Source stays null.
  if (!subset) {
    return { useSubsetInComps: true, subsetSource, subsetDroppedReason: null };
  }

  // Empty / unknown player layout — preserve subset rather than risk
  // collapsing a multi-player query whose `players[]` we never observed.
  if (!Number.isFinite(input.playerCount) || input.playerCount <= 0) {
    return { useSubsetInComps: true, subsetSource, subsetDroppedReason: null };
  }

  // Multi-player card — subset is the only disambiguator. Preserve.
  if (input.playerCount > 1) {
    return { useSubsetInComps: true, subsetSource, subsetDroppedReason: null };
  }

  // Single-player card. The drop fires only on the demonstrably-less-
  // grounded fallback path. The dedicated `gemini.subset` JSON field is
  // trusted (it's the whitelisted path; the prompt instructs literal
  // extraction from the printed banner).
  if (input.playerCount === 1 && subsetSource === 'vlmApply-fallback') {
    return {
      useSubsetInComps: false,
      subsetSource,
      subsetDroppedReason: 'single-player+fallback',
    };
  }

  return { useSubsetInComps: true, subsetSource, subsetDroppedReason: null };
}
