/**
 * Match scoring between a PackScan scan and SportsCardsPro search results.
 *
 * SCP's `/api/products?q=...` returns candidates ordered by their internal
 * relevance, but that ordering isn't reliable when the query has partial
 * matches — we routinely see the wrong parallel or wrong year ranked first.
 * We re-score every candidate against the scan's structured fields and
 * return the best one only if it clears a confidence threshold.
 *
 * Scoring weights (total = 100):
 *   year        20   — hard requirement; wrong year is almost always wrong card
 *   brand       15   — "Topps" vs "Panini" are never interchangeable
 *   cardNumber  25   — most specific signal when present
 *   playerName  15   — fuzzy (last-name + first-initial prefix)
 *   set          5   — "Chrome" vs base; often the discriminator
 *   parallel    20   — canonical-bucket comparison via colorSynonyms
 *
 * Parallel scoring is a signed range (-30..+20):
 *    +20  scan + candidate normalize to same canonical parallel
 *      0  both are "base"/no parallel
 *    -20  scan has a parallel but candidate has none
 *    -20  candidate has a parallel but scan has none (we don't want to
 *         match a base card to a Gold Refractor just because the rest
 *         fit)
 *    -30  scan and candidate have different named parallels
 *
 * Why the big penalty? Before this rebalance, a Petersen US49 Pink scan
 * could match the Gold Rainbow Foil candidate at ~95/100 because the
 * player/year/brand/number all lined up and parallel was only worth 5.
 * The price for Gold is 10x Pink, so a wrong parallel is the single
 * worst mismatch we can present to a dealer.
 *
 * Threshold: 65 out of 100. Logged misses surface the breakdown so the
 * relative weights can be retuned.
 */

import type { ScpSearchResult } from "./client";
import { normalizeParallel } from "./colorSynonyms";

type Candidate = ScpSearchResult["products"][number];

export interface ScanQueryInput {
  playerName?: string | null;
  year?: number | null;
  brand?: string | null;        // "Topps", "Panini", etc.
  collection?: string | null;   // "Chrome", "Prizm", etc. — SCP calls this the "set"
  setName?: string | null;      // Sub-set like "Stars of MLB"; often same as collection
  cardNumber?: string | null;   // "17", "AA-11", "RC-3"
  parallel?: string | null;     // "Gold", "Refractor", etc.
}

export interface ScoredCandidate {
  candidate: Candidate;
  score: number; // 0..100
  breakdown: Record<string, number>;
}

/** Score threshold for "confident match". Below this → miss. */
export const MATCH_THRESHOLD = 65;

/**
 * Build an SCP search query from scan fields. Keep this small — SCP's
 * full-text matcher is keyword-based and extra terms can push good
 * candidates off the first page.
 *
 * Order matters for legibility but SCP is unordered; we still put the
 * most-distinctive terms first because fewer-word queries also get less
 * aggressive stemming.
 *
 * Card-number inclusion (PR F-2a):
 *   SCP's search endpoint caps results at 100 and sorts by an internal
 *   popularity signal. For cards with many parallels (any modern Topps
 *   flagship), the long tail of Chrome / insert / relic rows can shove
 *   base-set parallels off the result page. Example: searching
 *   "Nolan Arenado 2025 Topps" returns 100 rows but Arenado [Holiday]
 *   #101 isn't among them; adding "101" to the query narrows SCP's
 *   internal index enough that the full set (84 rows) comes back and
 *   Holiday lands at position 12.
 *
 *   We include the card number by default. It's purely additive — SCP's
 *   matcher treats it as a keyword, so products whose product-name
 *   doesn't include the number still come back when other tokens match.
 */
export function buildSearchQuery(input: ScanQueryInput): string {
  const parts: string[] = [];
  if (input.playerName) parts.push(input.playerName.trim());
  if (input.year) parts.push(String(input.year));
  if (input.brand) parts.push(input.brand.trim());
  // Card number early so SCP's keyword matcher can use it to narrow the
  // result page before its 100-cap truncates the long tail.
  if (input.cardNumber) parts.push(input.cardNumber.trim());
  // Include BOTH collection and setName when they contribute different
  // tokens. SCP console-names are concatenations like
  // "Baseball Cards 2025 Topps Update All-Star Game", so dropping either
  // half can route the query to the wrong console. Example that
  // motivated this: Ohtani ASG-1 has collection="2025 All-Star Game"
  // and set="Update Series"; using only setName queried the plain
  // "Topps Update" console and missed every ASG parallel.
  //
  // We still dedupe overlapping tokens so "Topps Chrome" (collection)
  // + "Chrome" (setName) doesn't emit "Topps Chrome Chrome".
  const collection = input.collection?.trim() || "";
  const setName = input.setName?.trim() || "";
  const seen = new Set<string>();
  const pushUniqueTokens = (src: string) => {
    for (const tok of src.split(/\s+/)) {
      const key = tok.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      parts.push(tok);
    }
  };
  if (collection) pushUniqueTokens(collection);
  if (setName && setName.toLowerCase() !== collection.toLowerCase()) {
    pushUniqueTokens(setName);
  }
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Parsing helpers — SCP embeds fields inside product/console names
// ---------------------------------------------------------------------------

/**
 * Pull the card number from an SCP product-name.
 *   "Shohei Ohtani #17"            -> "17"
 *   "Shohei Ohtani #AA-11"          -> "AA-11"
 *   "Shohei Ohtani [Gold] #AA-11"   -> "AA-11"
 *   "Michael Jordan #57 [Autograph]" -> "57"
 */
export function extractCardNumber(productName: string): string | null {
  const m = productName.match(/#\s*([A-Za-z0-9-]+)/);
  return m ? m[1] : null;
}

/**
 * Pull the parallel name from [brackets]. Returns the raw bracketed
 * text (e.g. "Gold", "Refractor", "Prizm Silver") or null if none.
 */
export function extractParallel(productName: string): string | null {
  const m = productName.match(/\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

/**
 * Pull the player name from an SCP product-name. The SCP convention is
 * that the player name sits at the front of the product-name, before any
 * `[parallel]` bracket or `#cardNumber` marker. Some trailing variant
 * tokens (e.g. "Rookie", "Autograph") are printed as words between the
 * name and the bracket/hash; we conservatively keep them out by cutting
 * at the first `[` or `#` and trimming whitespace.
 *
 *   "Shohei Ohtani #17"                   -> "Shohei Ohtani"
 *   "Shohei Ohtani [Gold] #AA-11"          -> "Shohei Ohtani"
 *   "Michael Jordan #57 [Autograph]"       -> "Michael Jordan"
 *   "Ken Griffey Jr. #350"                 -> "Ken Griffey Jr."
 *
 * Returns null for empty / unparseable names.
 */
export function extractPlayerName(productName: string): string | null {
  if (!productName) return null;
  // Cut at the first `#` (card number marker) or `[` (parallel bracket).
  const cutIdx = productName.search(/[#\[]/);
  const head = cutIdx >= 0 ? productName.slice(0, cutIdx) : productName;
  const cleaned = head.replace(/\s+/g, " ").trim();
  // Strip a trailing hyphen/en-dash/em-dash if SCP used one as a separator.
  const trimmed = cleaned.replace(/[-–—]+$/g, "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Pull the year from an SCP console-name.
 *   "Baseball Cards 2023 Topps All Aces" -> 2023
 *   "Basketball Cards 1986 Fleer"        -> 1986
 */
export function extractYear(consoleName: string): number | null {
  const m = consoleName.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : null;
}

/**
 * Pull the brand from a console-name. SCP's format is usually
 * "<Sport> Cards <Year> <Brand> <SubSet>". Returns the word immediately
 * after the year.
 */
export function extractBrand(consoleName: string): string | null {
  const m = consoleName.match(/\b(19|20)\d{2}\s+([A-Za-z][A-Za-z'&.]*)/);
  return m ? m[2] : null;
}

// ---------------------------------------------------------------------------
// Fuzzy helpers
// ---------------------------------------------------------------------------

function normalize(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(s: string | null | undefined): string[] {
  return normalize(s).split(/\s+/).filter(Boolean);
}

/**
 * Does the candidate product-name contain enough of the scan's player
 * name? We require a last-name match (exact token) and ideally a first-
 * initial prefix. "Shohei Ohtani" matches "S. Ohtani" and "Ohtani"
 * alone (common in high-end sets).
 */
function scorePlayer(scanPlayer: string, candidateProduct: string): number {
  const scanTokens = tokens(scanPlayer);
  if (scanTokens.length === 0) return 0;
  const candTokens = tokens(candidateProduct);
  if (candTokens.length === 0) return 0;

  // Last name assumed to be the final token of the scan's player name.
  const lastName = scanTokens[scanTokens.length - 1];
  if (!lastName || lastName.length < 2) return 0;
  if (!candTokens.includes(lastName)) return 0;

  // Weight: 80% of player budget for last-name match. Bump to 100% if
  // the first-name (or its initial) also appears.
  const firstName = scanTokens[0];
  if (!firstName || scanTokens.length < 2) return 80;
  const firstInitial = firstName[0];
  const hasFirstNameFull = candTokens.includes(firstName);
  const hasFirstInitial = candTokens.some((t) => t.length > 0 && t[0] === firstInitial);
  if (hasFirstNameFull) return 100;
  if (hasFirstInitial) return 90;
  return 80;
}

/** Case-insensitive equality after stripping non-alphanum. */
function eq(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  return !!na && na === nb;
}

/** "Contains" check after normalization. Useful for set names like
 *  "Chrome" matching "Topps Chrome Update". */
function contains(haystack: string | null | undefined, needle: string | null | undefined): boolean {
  const nh = normalize(haystack);
  const nn = normalize(needle);
  return !!nh && !!nn && nh.includes(nn);
}

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------

/**
 * Score a single SCP candidate against the scan. Returns a number 0..100.
 * Higher is better. Individual sub-scores are exposed via the breakdown
 * so we can surface them in the miss log.
 */
export function scoreCandidate(
  scan: ScanQueryInput,
  candidate: Candidate,
): ScoredCandidate {
  const breakdown: Record<string, number> = {
    year: 0, brand: 0, cardNumber: 0, playerName: 0, set: 0, parallel: 0,
  };

  const candYear = extractYear(candidate["console-name"]);
  const candBrand = extractBrand(candidate["console-name"]);
  const candCardNumber = extractCardNumber(candidate["product-name"]);
  const candParallel = extractParallel(candidate["product-name"]);

  // Year — 20 pts. Hard: off-by-one is still a big penalty because
  // sticker sets and carry-over numbering routinely fool us.
  if (scan.year && candYear) {
    if (candYear === scan.year) breakdown.year = 20;
    else if (Math.abs(candYear - scan.year) === 1) breakdown.year = 5;
    else breakdown.year = 0;
  } else if (!scan.year) {
    // No scan year → don't penalise; distribute neutrally.
    breakdown.year = 10;
  }

  // Brand — 15 pts. Exact or "contains" (Topps != Panini).
  if (scan.brand && candBrand) {
    if (eq(scan.brand, candBrand)) breakdown.brand = 15;
    else if (contains(candidate["console-name"], scan.brand)) breakdown.brand = 12;
    else breakdown.brand = 0;
  } else if (!scan.brand) {
    breakdown.brand = 8;
  }

  // Card number — 25 pts. Exact match on the alphanumeric portion.
  if (scan.cardNumber && candCardNumber) {
    const a = scan.cardNumber.toLowerCase().replace(/[^a-z0-9]/g, "");
    const b = candCardNumber.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (a && b) {
      if (a === b) breakdown.cardNumber = 25;
      else if (a.endsWith(b) || b.endsWith(a)) breakdown.cardNumber = 15; // "AA-11" vs "11"
      else breakdown.cardNumber = 0;
    }
  } else if (!scan.cardNumber) {
    // No card number is common for unreadable scans; partial credit.
    breakdown.cardNumber = 10;
  }

  // Player — 15 pts (scorePlayer returns 0..100, we scale).
  if (scan.playerName) {
    breakdown.playerName = Math.round((scorePlayer(scan.playerName, candidate["product-name"]) / 100) * 15);
  }

  // Set — 5 pts. collection OR setName, whichever is present, checked
  // against the full console-name (which includes "Topps Chrome" etc.).
  const setTerm = scan.setName?.trim() || scan.collection?.trim() || "";
  if (setTerm) {
    if (contains(candidate["console-name"], setTerm)) breakdown.set = 5;
    else breakdown.set = 0;
  } else {
    breakdown.set = 3;
  }

  // Parallel — 20 pts with signed mismatch penalties. Uses normalized
  // canonical buckets so "hot pink" / "Pink Wave" / "[Pink]" all collapse
  // to the same comparison. See colorSynonyms.ts.
  breakdown.parallel = scoreParallel(scan.parallel, candParallel);

  // Clamp to [0, 100] — the parallel axis is the only one that can go
  // negative, and a single -30 penalty is enough to push a candidate
  // well below threshold without producing a confusing negative total.
  const raw = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const score = Math.max(0, Math.min(100, raw));
  return { candidate, score, breakdown };
}

/**
 * Signed parallel score in [-30, +20]. Exported for targeted unit testing.
 *
 *   scan parallel    candidate parallel    result
 *   ───────────────────────────────────────────────────────────────────
 *   none / base      none / base            0  (both base — neutral)
 *   none / base      has parallel         -20  (don't match base to Gold Refractor)
 *   has parallel     none / base          -20  (scan says Pink, candidate is base)
 *   has parallel     same canonical        +20
 *   has parallel     different canonical   -30
 *   has parallel     unrecognized          -10  (SCP parallel we couldn't bucket
 *                                                 — possible false match, soft penalty)
 *   unrecognized     has parallel          -10  (mirror; Holo detected something
 *                                                 we couldn't bucket)
 */
export function scoreParallel(
  scanParallel: string | null | undefined,
  candidateParallel: string | null | undefined,
): number {
  const scanRaw = scanParallel?.trim() ?? "";
  const candRaw = candidateParallel?.trim() ?? "";

  const scanBase = !scanRaw || scanRaw.toLowerCase() === "base";
  const candBase = !candRaw;

  if (scanBase && candBase) return 0;
  if (scanBase && !candBase) return -20;
  if (!scanBase && candBase) return -20;

  // Both have a parallel.
  const scanBucket = normalizeParallel(scanRaw);
  const candBucket = normalizeParallel(candRaw);

  // Either side didn't map into a known bucket — give a soft penalty.
  // We can't confidently say they match, but we don't want a hard -30
  // either because the scanner often finds valid-but-uncatalogued parallels
  // ("Sandglitter", etc.).
  if (!scanBucket || !candBucket) return -10;

  if (scanBucket === candBucket) return 20;
  return -30;
}

/**
 * Score and sort a full candidate list, returning the best match along
 * with whether it clears the threshold. Always returns a list so the
 * orchestrator can stash the top-N candidates in the miss log.
 */
export function rankCandidates(
  scan: ScanQueryInput,
  candidates: Candidate[],
): {
  best: ScoredCandidate | null;
  confident: boolean;
  top: ScoredCandidate[]; // top 5, for logging
} {
  if (candidates.length === 0) {
    return { best: null, confident: false, top: [] };
  }
  const scored = candidates.map((c) => scoreCandidate(scan, c));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0] ?? null;
  return {
    best,
    confident: !!best && best.score >= MATCH_THRESHOLD,
    top: scored.slice(0, 5),
  };
}
