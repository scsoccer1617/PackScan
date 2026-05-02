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
import type { Player } from '@shared/players';

const NONE_DETECTED_SENTINELS = new Set([
  'none detected',
  'none',
  'no parallel',
  'base',
  'base card',
]);

/**
 * Strip a leading `<brand> ` or `<year> <brand> ` prefix from a `set` value.
 *
 * Per the user-defined hierarchy (and the prompt's SET NORMALIZATION rule),
 * `set` should hold only the disambiguator within the brand's product line
 * (e.g. "Series One", "Optic"), NOT the brand or year. The VLM still
 * occasionally emits "Topps Series One" or "2026 Topps Series One" — this
 * normalizer cleans that up post-hoc so the saved row, the eBay query, and
 * the sheet column line up with what users expect.
 *
 * Generic on purpose: only strips a leading token sequence that matches the
 * card's actual brand (case-insensitive) and an optional 4-digit year token
 * directly preceding it. Never strips arbitrary leading words — "Stadium
 * Club" stays "Stadium Club" even though "Topps Stadium Club" is also a
 * valid product name; if the brand is "Topps" and the set arrives as
 * "Topps Stadium Club", we drop the "Topps " and return "Stadium Club".
 *
 * Exported for tests.
 */
export function normalizeSetValue(set: string, brand: string): string {
  const trimmed = (set || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const brandTrim = (brand || '').trim();
  if (!brandTrim) return trimmed;
  const escapedBrand = brandTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // "<Year> <Brand> <rest>"  → "<rest>"
  const yearBrandRe = new RegExp(`^\\d{4}\\s+${escapedBrand}\\s+`, 'i');
  let result = trimmed.replace(yearBrandRe, '');
  if (result === trimmed) {
    // "<Brand> <rest>" → "<rest>"
    const brandRe = new RegExp(`^${escapedBrand}\\s+`, 'i');
    result = result.replace(brandRe, '');
  }
  result = result.trim();
  // If after stripping the result equals the brand itself (e.g. set was
  // exactly "Topps" — flagship with no disambiguator), return empty so
  // downstream callers can treat it as "no set disambiguator".
  if (!result || result.toLowerCase() === brandTrim.toLowerCase()) return '';
  return result;
}

const COLLECTION_BASE_SENTINELS = new Set([
  'base',
  'base set',
  'base cards',
  'none',
  'none detected',
]);

/**
 * Treat any of these `collection` values as "user meant Base Set". Most
 * commonly the VLM mirrors the set name into collection (e.g.
 * collection="Series One" when set="Series One") for base cards — that
 * pattern is detected by the caller via comparing the two strings; this
 * sentinel set is the catch-all for the explicitly-base-ish strings.
 */
export function isBaseCollection(value: string | null | undefined): boolean {
  if (value == null) return true;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return true;
  return COLLECTION_BASE_SENTINELS.has(trimmed);
}

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
  // ── Player name(s) ──────────────────────────────────────────────────────
  // Prefer the multi-player `players` array (prompt v2026-05-01.1+) when
  // present and non-empty. Each entry becomes a Player; we also mirror
  // players[0] into the legacy playerFirstName/playerLastName slots so any
  // caller that still reads the single-name fields stays correct. When the
  // array is missing (older Gemini responses), fall back to splitting the
  // top-level `player` string and wrap it as a 1-element array.
  const rawPlayers = Array.isArray(gemini.players) ? gemini.players : null;
  const cleanedPlayers: Player[] = [];
  if (rawPlayers) {
    for (const p of rawPlayers) {
      if (!p) continue;
      const first = (p.firstName ?? '').toString().trim();
      const last = (p.lastName ?? '').toString().trim();
      if (!first && !last) continue;
      const role = typeof p.role === 'string' && p.role.trim() ? p.role.trim() : undefined;
      cleanedPlayers.push(role ? { firstName: first, lastName: last, role } : { firstName: first, lastName: last });
    }
  }
  if (cleanedPlayers.length > 0) {
    combined.players = cleanedPlayers;
    combined.playerFirstName = cleanedPlayers[0].firstName;
    combined.playerLastName = cleanedPlayers[0].lastName;
  } else if (typeof gemini.player === 'string' && gemini.player.trim()) {
    const { first, last } = splitPlayerName(gemini.player);
    if (first) combined.playerFirstName = first;
    if (last) combined.playerLastName = last;
    // Coerce legacy single-name fallback into a 1-element players array so
    // downstream code can rely on `combined.players` being present whenever
    // we have any name at all.
    if (first || last) {
      combined.players = [{ firstName: first, lastName: last }];
    }
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
  // Set: strip any "<Brand> " or "<Year> <Brand> " prefix the VLM may have
  // concatenated. The user-defined hierarchy keeps Brand and Year in their
  // own fields and reserves `set` for the in-product disambiguator only.
  if (typeof gemini.set === 'string' && gemini.set.trim()) {
    const brandForNorm = (combined.brand ?? gemini.brand ?? '').toString();
    combined.set = normalizeSetValue(gemini.set, brandForNorm);
  }
  if (typeof gemini.collection === 'string' && gemini.collection.trim()) {
    combined.collection = gemini.collection.trim();
  }
  // Coerce collection → "Base Set" for base cards. The prompt instructs
  // Gemini to emit collection="Base Set" when there's no insert/subset
  // overlay, but it still occasionally mirrors the set name into
  // collection (e.g. set="Series One", collection="Series One") or leaves
  // it empty. Three cases collapse to "Base Set":
  //   (1) collection unset / empty / explicit "Base"-style sentinel,
  //   (2) collection equals the (normalized) set string verbatim,
  //   (3) collection equals the brand-prefixed form of the set
  //       (e.g. set="Series One" but collection="Topps Series One").
  // Inserts/subsets keep their distinct collection name unchanged.
  const setForBaseCheck = (combined.set ?? '').toString().trim();
  const brandForBaseCheck = (combined.brand ?? '').toString().trim();
  const collectionRaw = (combined.collection ?? '').toString().trim();
  const collectionLower = collectionRaw.toLowerCase();
  const setLower = setForBaseCheck.toLowerCase();
  const brandedSetLower = brandForBaseCheck && setForBaseCheck
    ? `${brandForBaseCheck} ${setForBaseCheck}`.toLowerCase()
    : '';
  const mirrorsSet =
    !!setLower && (collectionLower === setLower || collectionLower === brandedSetLower);
  if (isBaseCollection(collectionRaw) || mirrorsSet) {
    combined.collection = 'Base Set';
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
  // When Gemini reports name="None detected" / "Base" / "None" / null we
  // treat the card as base and CLEAR foilType / variant. The persisted
  // empty-string sentinel is load-bearing for the eBay base-card penalty
  // path in `server/ebayService.ts` (PR #205), which uses
  // `foilType.trim() === ''` as the signal to penalize listings whose
  // titles contain parallel keywords. The prompt's PARALLEL DEFAULT rule
  // is the real fix for the "VLM hallucinated a parallel on a base card"
  // failure mode reported in the 2026 Topps bulk audit; this clearing
  // step preserves the existing-base-card invariant.
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

  // ── Subset descriptor (Team Leaders, Record Breaker, Manager, etc.) ────
  // Not part of the persisted CardFormValues schema today, so we stash it
  // on the combined result via an `_geminiSubset` side-channel that
  // extractIdentityForEbay reads when building the eBay query. Null for
  // standard individual-player cards — leaving the field absent preserves
  // pre-PR query shape exactly (subset === null branch is a no-op).
  if (typeof gemini.subset === 'string' && gemini.subset.trim()) {
    (combined as any)._geminiSubset = gemini.subset.trim();
  }

  return combined;
}
