/**
 * Map Gemini VLM output onto a Partial<CardFormValues> as the authoritative
 * scan signal.
 *
 * Per user direction (Apr 28, 2026): CardDB is solid for baseball but hasn't
 * been built up for other sports yet, so the Gemini VLM output drives the
 * scan result directly without a CardDB grounding pass. Legacy OCR runs in
 * parallel for diagnostic logging but does NOT overwrite Gemini's fields.
 *
 * Field-shape mapping decisions:
 * - Gemini.player ("Stephen Curry") → playerFirstName + playerLastName split
 *   on the LAST space. Hyphenated last names ("Smith-Jones") and single
 *   tokens ("Pelé") are handled.
 * - Gemini.parallel.name → foilType (legacy schema field). When name is
 *   "None detected" / null we leave foilType blank — the card is base.
 * - Gemini.parallel.isFoil → isFoil boolean. Kept populated even when
 *   parallel.name="None detected" (Option B per session decision) because
 *   this still gives a useful agreement signal.
 * - Gemini.printRun (number) → isNumbered=true. Serial number itself can't
 *   be inferred from a print run alone, so we don't write serialNumber.
 *
 * Diagnostic fields are stashed under `_gemini` / `_legacy` so the scan log
 * can later compare them without polluting the persisted card row.
 */

import type { CardFormValues } from '@shared/schema';
import type { GeminiCardResult } from './vlmGemini';

const NONE_DETECTED_SENTINELS = new Set([
  'none detected',
  'none',
  'no parallel',
  'base',
  'base card',
]);

function splitPlayerName(full: string): { first: string; last: string } {
  const trimmed = full.trim().replace(/\s+/g, ' ');
  if (!trimmed) return { first: '', last: '' };
  // Single-token names ("Pelé", "Ronaldinho"): treat as last name so the
  // form's required-last-name validation still passes. Holo's UI lets the
  // user fix this on the review screen.
  const idx = trimmed.lastIndexOf(' ');
  if (idx === -1) return { first: '', last: trimmed };
  return {
    first: trimmed.slice(0, idx).trim(),
    last: trimmed.slice(idx + 1).trim(),
  };
}

function isNoneDetected(value: string | null | undefined): boolean {
  if (!value) return true;
  return NONE_DETECTED_SENTINELS.has(value.trim().toLowerCase());
}

function coercePrintRun(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const m = value.match(/(\d+)/);
    if (m) {
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/**
 * Overlay Gemini VLM output onto an existing `Partial<CardFormValues>`
 * (typically the result of legacy `combineCardResults`). Mutates and
 * returns the same object for ergonomic chaining.
 *
 * Gemini fields take priority — any field Gemini provides will overwrite
 * the legacy value. Legacy fields are preserved when Gemini didn't return
 * anything for that slot (e.g. Gemini doesn't return cmpNumber).
 */
export function applyGeminiToCombined(
  combined: Partial<CardFormValues>,
  gemini: GeminiCardResult,
): Partial<CardFormValues> {
  // ── Player name ─────────────────────────────────────────────────────────
  if (typeof gemini.player === 'string' && gemini.player.trim()) {
    const { first, last } = splitPlayerName(gemini.player);
    if (first) combined.playerFirstName = first;
    if (last) combined.playerLastName = last;
  }

  // ── Year (must be a finite number for the form schema) ─────────────────
  if (typeof gemini.year === 'number' && Number.isFinite(gemini.year)) {
    combined.year = gemini.year;
  }

  // ── yearPrintedRaw (verbatim year string for UI display) ───────────────
  // The integer `year` above is the source of truth for backend logic
  // (CardDB lookups, eBay search, Sheet writes). This raw string lets the
  // UI render what's actually printed on the card, so we don't slap "-YY"
  // onto a single-year © imprint for basketball/hockey cards.
  if (typeof gemini.yearPrintedRaw === 'string' && gemini.yearPrintedRaw.trim()) {
    combined.yearPrintedRaw = gemini.yearPrintedRaw.trim();
  } else {
    combined.yearPrintedRaw = null;
  }

  // ── Brand / Set / Collection / CardNumber ──────────────────────────────
  if (typeof gemini.brand === 'string' && gemini.brand.trim()) {
    combined.brand = gemini.brand.trim();
  }
  if (typeof gemini.set === 'string' && gemini.set.trim()) {
    combined.set = gemini.set.trim();
  }
  if (typeof gemini.collection === 'string' && gemini.collection.trim()) {
    combined.collection = gemini.collection.trim();
  }
  if (typeof gemini.cardNumber === 'string' && gemini.cardNumber.trim()) {
    combined.cardNumber = gemini.cardNumber.trim();
  }

  // ── CMP code (manufacturer reference) ────────────────────────────────
  // Topps/Panini stamp a small CMPxxxxx ref in the back-side legal strip;
  // we read it verbatim. Light normalization: strip whitespace and force
  // the prefix to upper case ("cmp123" → "CMP123") so identical anchors
  // collapse across scans.
  if (typeof gemini.cmpCode === 'string' && gemini.cmpCode.trim()) {
    const raw = gemini.cmpCode.trim().replace(/\s+/g, '');
    const normalized = /^cmp/i.test(raw) ? `CMP${raw.slice(3)}` : raw;
    combined.cmpNumber = normalized;
  }

  // ── Sport ──────────────────────────────────────────────────────────────
  if (typeof gemini.sport === 'string' && gemini.sport.trim()) {
    combined.sport = gemini.sport.trim();
  }

  // ── Team ───────────────────────────────────────────────────────────────
  if (typeof gemini.team === 'string' && gemini.team.trim()) {
    combined.team = gemini.team.trim();
  }

  // ── Parallel → foilType + variant ──────────────────────────────────────
  // When Gemini reports name="None detected" we treat the card as base and
  // clear any foilType the legacy pipeline may have wrongly inferred. When
  // Gemini reports a real parallel name, that name becomes the canonical
  // foilType / variant string (e.g. "Pink/Green Polka Dot", "Rainbow Foil").
  const parallelName = gemini.parallel?.name ?? null;
  if (isNoneDetected(parallelName)) {
    combined.foilType = '';
    combined.variant = '';
  } else if (typeof parallelName === 'string' && parallelName.trim()) {
    combined.foilType = parallelName.trim();
    combined.variant = parallelName.trim();
  }

  // isFoil: keep populated whenever Gemini emitted a boolean, even on base
  // cards (Option B from the session). This gives downstream agreement
  // scoring a usable signal.
  if (typeof gemini.parallel?.isFoil === 'boolean') {
    combined.isFoil = gemini.parallel.isFoil;
  }

  // ── Rookie / Autograph flags ───────────────────────────────────────────
  if (typeof gemini.isRookie === 'boolean') {
    combined.isRookieCard = gemini.isRookie;
  }
  if (typeof gemini.isAutograph === 'boolean') {
    combined.isAutographed = gemini.isAutograph;
  }

  // ── Numbered (print run) ───────────────────────────────────────────────
  // We can't infer the per-card serial number ("12/299") from the print run
  // alone, but we can confidently mark the card as numbered.
  const printRun = coercePrintRun(gemini.printRun);
  if (printRun != null && printRun > 0) {
    combined.isNumbered = true;
  }

  return combined;
}
