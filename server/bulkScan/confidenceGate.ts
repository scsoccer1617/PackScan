// Pure confidence gate for the bulk-scan pipeline.
//
// Inputs: the Partial<CardFormValues> result from handleDualSideCardAnalysis
// (with SCP-first flags already stamped by dualSideOCR.ts) plus any pairing
// warnings from pairing.ts.
//
// Output: a verdict — auto_save vs review — and a list of reasons that is
// persisted on scan_batch_items so the review UI can explain WHY a pair
// needs a human.
//
// The rules (locked in the resumed plan):
//   auto_save when
//     (SCP hit with matchScore ≥ 75)
//     OR (SCP hit with score ≥ 65 AND CardDB corroborated the identity)
//     AND no _variationAmbiguous
//     AND no _collectionAmbiguous
//     AND _cardNumberLowConfidence is falsy
//     AND playerFirstName AND playerLastName are both populated
//     AND no pairing warnings
//   else review.
//
// This module is pure so it's trivial to unit-test and to swap thresholds
// later without touching the orchestrator.

export interface ConfidenceGateInput {
  /**
   * The analyzer result as returned by handleDualSideCardAnalysis. Typed
   * loosely (`any`) here to avoid a hard dependency on the internal
   * CardFormWithFlags alias — the gate only reads a handful of fields
   * which we access defensively. Keep this permissive; dualSideOCR.ts is
   * the authority on the flag shapes.
   */
  analysis: Record<string, any>;
  /** Pairing warnings for this pair (empty array if none). */
  pairingWarnings: string[];
  /** True when the CardDB set/collection enrichment agreed on year + cardNumber. */
  cardDbCorroborated?: boolean;
}

export type GateVerdict = 'auto_save' | 'review';

export interface ConfidenceGateOutput {
  verdict: GateVerdict;
  /** 0..100 composite score — mostly the SCP matchScore, nudged by flags. */
  confidenceScore: number;
  /** Reasons feeding into a 'review' verdict. Stable snake_case strings. */
  reasons: string[];
}

const SCP_AUTO_SAVE_STRONG = 75;
const SCP_AUTO_SAVE_CORROBORATED = 65;

export function evaluateConfidence(input: ConfidenceGateInput): ConfidenceGateOutput {
  const { analysis, pairingWarnings, cardDbCorroborated } = input;
  const reasons: string[] = [];

  // Pull flags defensively so a missing field never throws.
  const scpHit = !!analysis?._scpHit;
  const scpScore = 0;
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

  // Flag-driven review reasons — these always block auto-save regardless
  // of SCP score. They describe specific ambiguities the OCR pipeline
  // intentionally hands off to a human.
  if (cardNumberLowConfidence) reasons.push('card_number_low_confidence');
  if (variationAmbiguous) reasons.push('variation_ambiguous');
  if (collectionAmbiguous) reasons.push('collection_ambiguous');
  if (!hasPlayerName) reasons.push('player_name_missing');
  if (!hasCardNumber) reasons.push('card_number_missing');

  // Pairing warnings. The ones that affect identification accuracy force
  // review; purely informational ones (unknown classifier verdict) do not.
  for (const w of pairingWarnings) {
    if (w === 'unpaired_trailing_page' || w === 'classifier_same_side_back' || w === 'classifier_same_side_front') {
      reasons.push(`pair_${w}`);
    } else if (w === 'swapped_by_classifier') {
      // Swapping is a corrective action, not an error — we still auto-save
      // when other signals are strong, but record the warning for audit.
      // No reason entry needed here; it's tracked elsewhere.
    } else if (w === 'classifier_unknown') {
      // Ambiguous classifier on one side is a soft signal — push to review
      // only if SCP didn't give us a strong hit below.
      reasons.push('pair_classifier_unknown');
    }
  }

  // SCP-based strength check.
  let scpStrongEnough = false;
  if (scpHit) {
    if (scpScore >= SCP_AUTO_SAVE_STRONG) {
      scpStrongEnough = true;
    } else if (scpScore >= SCP_AUTO_SAVE_CORROBORATED && cardDbCorroborated) {
      scpStrongEnough = true;
    } else {
      reasons.push(cardDbCorroborated
        ? `scp_score_low_${Math.round(scpScore)}`
        : `scp_uncorroborated_${Math.round(scpScore)}`);
    }
  } else {
    reasons.push('scp_miss');
  }

  const verdict: GateVerdict = reasons.length === 0 && scpStrongEnough ? 'auto_save' : 'review';

  // Composite score: SCP match score clamped to 0..100, nudged down by each
  // ambiguity flag. Used by the review UI to sort the queue (highest
  // confidence first so the user knocks out the easy ones).
  let composite = Math.max(0, Math.min(100, scpScore));
  if (cardNumberLowConfidence) composite -= 15;
  if (variationAmbiguous) composite -= 10;
  if (collectionAmbiguous) composite -= 10;
  if (!hasPlayerName) composite -= 25;
  if (!hasCardNumber) composite -= 15;
  if (pairingWarnings.length > 0) composite -= 5;
  composite = Math.max(0, composite);

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
