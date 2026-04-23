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
 *   brand       20   — "Topps" vs "Panini" are never interchangeable
 *   cardNumber  25   — most specific signal when present
 *   playerName  20   — fuzzy (last-name + first-initial prefix)
 *   set         10   — "Chrome" vs base; often the discriminator
 *   parallel     5   — detected parallel in [brackets] of product-name
 *
 * Threshold: 65 out of 100. Tuned on eyeballing ~20 scans; we log
 * below-threshold misses to `scp_miss_log` for refinement.
 */

import type { ScpSearchResult } from "./client";

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
 */
export function buildSearchQuery(input: ScanQueryInput): string {
  const parts: string[] = [];
  if (input.playerName) parts.push(input.playerName.trim());
  if (input.year) parts.push(String(input.year));
  if (input.brand) parts.push(input.brand.trim());
  // Prefer the more specific sub-set when both are present. SCP's
  // console-name contains the full concatenation ("Baseball Cards 2023
  // Topps Chrome") so listing both usually over-constrains.
  const setTerm = (input.setName?.trim() || input.collection?.trim() || "").trim();
  if (setTerm) parts.push(setTerm);
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

  // Brand — 20 pts. Exact or "contains" (Topps != Panini).
  if (scan.brand && candBrand) {
    if (eq(scan.brand, candBrand)) breakdown.brand = 20;
    else if (contains(candidate["console-name"], scan.brand)) breakdown.brand = 15;
    else breakdown.brand = 0;
  } else if (!scan.brand) {
    breakdown.brand = 10;
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

  // Player — 20 pts (scorePlayer returns 0..100, we scale).
  if (scan.playerName) {
    breakdown.playerName = Math.round((scorePlayer(scan.playerName, candidate["product-name"]) / 100) * 20);
  }

  // Set — 10 pts. collection OR setName, whichever is present, checked
  // against the full console-name (which includes "Topps Chrome" etc.).
  const setTerm = scan.setName?.trim() || scan.collection?.trim() || "";
  if (setTerm) {
    if (contains(candidate["console-name"], setTerm)) breakdown.set = 10;
    else breakdown.set = 0;
  } else {
    breakdown.set = 5;
  }

  // Parallel — 5 pts. If scan says "Base" or no parallel, we actually
  // prefer candidates WITHOUT a [bracketed] parallel. If scan detected
  // a named parallel, we want a matching bracket.
  const hasScanParallel = !!(scan.parallel && scan.parallel.trim() &&
    scan.parallel.trim().toLowerCase() !== "base");
  if (hasScanParallel && candParallel) {
    if (contains(candParallel, scan.parallel!)) breakdown.parallel = 5;
    else breakdown.parallel = 0;
  } else if (!hasScanParallel && !candParallel) {
    breakdown.parallel = 5;
  } else {
    // Mismatch: base scan but parallel candidate (or vice versa). No credit.
    breakdown.parallel = 0;
  }

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { candidate, score, breakdown };
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
