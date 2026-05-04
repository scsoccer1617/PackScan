// Pure confidence gate for the bulk-scan pipeline.
//
// Inputs: the analyzer's `analysis` blob (Gemini-authoritative as of
// PRs #161/#162) plus pairing warnings and CardDB corroboration.
//
// Output: a verdict — auto_save vs review — and a list of reasons that is
// persisted on scan_batch_items so the review UI can explain WHY a pair
// needs a human.
//
// Gemini-authority gate (post-SCP, post-PR #162 default):
//   auto_save when
//     brand AND year AND cardNumber AND player(first+last) all present
//     AND no _variationAmbiguous / _collectionAmbiguous / _cardNumberLowConfidence
//     AND no identification-blocking pairing warning
//     AND (CardDB corroborated when CARDDB_LOOKUP_ENABLED=true; neutral when off)
//   else review.
//
// When the CardDB flag is off (PR #162 default) we treat the missing CardDB
// signal as neutral — Gemini is authoritative — so a complete Gemini result
// auto-saves on its own. When the flag is on, we additionally require
// (year, cardNumber) corroboration to mirror single-card's behavior.

export interface ConfidenceGateInput {
  /**
   * The analyzer result as returned by handleDualSideCardAnalysis. Typed
   * loosely (`any`) here to avoid a hard dependency on the internal
   * CardFormWithFlags alias — the gate only reads a handful of fields
   * which we access defensively.
   */
  analysis: Record<string, any>;
  /** Pairing warnings for this pair (empty array if none). */
  pairingWarnings: string[];
  /** True when CARDDB_LOOKUP_ENABLED is set; false → CardDB signal is neutral. */
  cardDbAvailable?: boolean;
  /** True when the CardDB lookup agreed on year + cardNumber (only meaningful when cardDbAvailable). */
  cardDbCorroborated?: boolean;
}

export type GateVerdict = 'auto_save' | 'review';

export interface ConfidenceGateOutput {
  verdict: GateVerdict;
  /** 0..100 composite score — derived from Gemini field completeness, nudged by flags. */
  confidenceScore: number;
  /** Reasons feeding into a 'review' verdict. Stable snake_case strings. */
  reasons: string[];
}

export function evaluateConfidence(input: ConfidenceGateInput): ConfidenceGateOutput {
  const { analysis, pairingWarnings, cardDbAvailable, cardDbCorroborated } = input;
  const reasons: string[] = [];

  // Pull flags defensively so a missing field never throws.
  const cardNumberLowConfidence = !!analysis?._cardNumberLowConfidence;
  const variationAmbiguous = !!analysis?._variationAmbiguous;
  const collectionAmbiguous = !!analysis?._collectionAmbiguous;

  const firstName = String(analysis?.playerFirstName || '').trim();
  const lastName = String(analysis?.playerLastName || '').trim();
  const hasPlayerName = firstName.length > 0 && lastName.length > 0
    && lastName.toLowerCase() !== 'player'
    && firstName.toLowerCase() !== 'unknown';

  const cardNumberStr = String(analysis?.cardNumber || '').trim();
  const hasCardNumber = cardNumberStr.length > 0;

  const brandStr = String(analysis?.brand || '').trim();
  const hasBrand = brandStr.length > 0;

  const yearVal = typeof analysis?.year === 'number'
    ? analysis.year
    : parseInt(String(analysis?.year || ''), 10);
  const hasYear = Number.isFinite(yearVal) && yearVal > 0;

  // Flag-driven review reasons — these always block auto-save. They describe
  // specific ambiguities Gemini intentionally hands off to a human.
  if (cardNumberLowConfidence) reasons.push('card_number_low_confidence');
  if (variationAmbiguous) reasons.push('variation_ambiguous');
  if (collectionAmbiguous) reasons.push('collection_ambiguous');
  if (!hasPlayerName) reasons.push('player_name_missing');
  if (!hasCardNumber) reasons.push('card_number_missing');
  if (!hasBrand) reasons.push('brand_missing');
  if (!hasYear) reasons.push('year_missing');
  // Provenance gate: when Gemini didn't supply the core identity fields,
  // route to review even if the post-overlay analysis looks complete. The
  // populated values are coming from legacy OCR / CardDB surname-salvage
  // and have been observed to fabricate confidently-wrong identities (see
  // bulk-39/40 audit: 1992 Fleer Ultra Ripken → 2026 Ultra #11; 1989 Topps
  // #401 Canseco → 1997 Topps #246; 1987 Topps #555 Valenzuela → 1987
  // Topps #580 Krukow). `_vlmEmptyIdentity` is set in dualSideOCR.ts
  // after the Gemini overlay runs.
  if (analysis?._vlmEmptyIdentity) reasons.push('vlm_empty_identity');

  // Pairing warnings. Identification-blocking ones force review;
  // informational ones (swapped_by_classifier) don't.
  for (const w of pairingWarnings) {
    if (w === 'unpaired_trailing_page' || w === 'classifier_same_side_back' || w === 'classifier_same_side_front') {
      reasons.push(`pair_${w}`);
    } else if (w === 'classifier_unknown') {
      reasons.push('pair_classifier_unknown');
    }
    // swapped_by_classifier is corrective; tracked elsewhere, not blocking.
  }

  // CardDB corroboration:
  //   • When the flag is OFF, Gemini is authoritative → neutral signal.
  //   • When the flag is ON, require (year, cardNumber) agreement to auto-save.
  // This matches the analyzer's gate (server/dualSideOCR.ts:1757) — flip the
  // env flag and bulk scan tightens up alongside single-card.
  if (cardDbAvailable && !cardDbCorroborated) {
    reasons.push('card_db_uncorroborated');
  }

  const verdict: GateVerdict = reasons.length === 0 ? 'auto_save' : 'review';

  // Composite score: start from a baseline that reflects Gemini field
  // completeness, then nudge down by ambiguity flags. Used by the review UI
  // to sort the queue (highest confidence first so dealers knock out the
  // easy ones).
  let composite = 100;
  if (!hasBrand) composite -= 20;
  if (!hasYear) composite -= 20;
  if (!hasCardNumber) composite -= 20;
  if (!hasPlayerName) composite -= 25;
  if (cardNumberLowConfidence) composite -= 15;
  if (variationAmbiguous) composite -= 10;
  if (collectionAmbiguous) composite -= 10;
  if (cardDbAvailable && !cardDbCorroborated) composite -= 10;
  if (analysis?._vlmEmptyIdentity) composite -= 30;
  if (pairingWarnings.length > 0) composite -= 5;
  composite = Math.max(0, Math.min(100, composite));

  return {
    verdict,
    confidenceScore: Number(composite.toFixed(2)),
    reasons,
  };
}

/**
 * Compare an analyzer result against a CardDB row to determine whether the
 * two sources agree on the (year, cardNumber) anchor. Used by the processor
 * to compute the `cardDbCorroborated` input for the gate.
 *
 * We compare year as integer and cardNumber as trimmed string (case-
 * insensitive). Everything else — set, collection, playerName — is
 * enrichment, not corroboration.
 */
export function isCardDbCorroboration(
  analysis: Record<string, any>,
  dbRow: { year?: number | null; cardNumberRaw?: string | null } | null | undefined,
): boolean {
  if (!dbRow) return false;
  const analysisYear = typeof analysis?.year === 'number' ? analysis.year : parseInt(String(analysis?.year || ''), 10);
  const analysisNum = String(analysis?.cardNumber || '').trim().toLowerCase();
  const dbYear = dbRow.year ?? null;
  const dbNum = String(dbRow.cardNumberRaw || '').trim().toLowerCase();
  if (!Number.isFinite(analysisYear) || !dbYear) return false;
  if (!analysisNum || !dbNum) return false;
  return analysisYear === dbYear && analysisNum === dbNum;
}
