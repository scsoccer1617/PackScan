/**
 * SportsCardsPro catalog lookup orchestrator.
 *
 * Public entry point for the rest of the server. Combines:
 *   client.ts      — HTTP + rate limit + cache
 *   match.ts       — score SCP candidates against scan fields
 *   priceCurve.ts  — shape SCP's response into a named grade curve
 *   scp_miss_log   — persist misses for later analysis
 *
 * The orchestrator NEVER throws — any error is converted into a silent
 * miss (reason: "api_error") and surfaced to callers as `null`. This
 * matches the PR #38a contract: the catalog overlay is non-blocking and
 * purely additive.
 */

import { db } from "@db";
import { scpMissLog, type ScpMissLogInsert } from "@shared/schema";
import {
  getProduct,
  searchProducts,
  ScpNotConfiguredError,
  ScpApiError,
} from "./client";
import {
  buildSearchQuery,
  rankCandidates,
  MATCH_THRESHOLD,
  type ScanQueryInput,
} from "./match";
import { buildPriceCurve, type PriceCurve } from "./priceCurve";

export const SOURCE_SLUG = "sportscardspro" as const;

export interface CatalogMatchResult {
  source: typeof SOURCE_SLUG;
  productId: string;
  productName: string;
  consoleName: string;
  matchScore: number;          // 0..100
  matchBreakdown: Record<string, number>;
  priceCurve: PriceCurve;
  /**
   * True when the hit was recovered by the no-player retry (where the
   * player name was dropped from the search query and SCP returned a hit
   * for the structural anchors alone). Callers should be wary of trusting
   * such hits to override an OCR-confident player name — a retry hit at a
   * different player at the same brand/year/cardNumber is a contradiction
   * signal, not a correction.
   */
  recoveredByRetry: boolean;
}

/**
 * Top below-threshold candidate exposed on miss results so callers
 * (notably the bulk-scan inbox diagnostic) can show "SCP got close to X
 * with score Y" without re-running the search. Keep this small — a
 * handful of fields per candidate, top 3 only — because it can end up
 * persisted in the scanBatchItems.analysisResult jsonb column.
 */
export interface CatalogMissCandidate {
  productName: string;
  consoleName: string;
  score: number; // 0..100
}

export type CatalogMissReason =
  | "no_query"
  | "no_results"
  | "below_threshold"
  | "api_error"
  | "not_configured";

export type CatalogLookupResult =
  | { status: "hit"; match: CatalogMatchResult; query: string }
  | {
      status: "miss";
      reason: CatalogMissReason;
      query: string;
      // Populated for below_threshold so callers can show how close SCP
      // came; empty/undefined for the other miss reasons.
      topCandidates?: CatalogMissCandidate[];
      // Populated when reason='api_error' so callers can surface the
      // underlying transport / SCP-side error message.
      errorMessage?: string;
    };

interface LookupOptions {
  /** User ID for the miss log. Null for unauthenticated callers. */
  userId?: number | null;
}

/**
 * Relaxed threshold used exclusively by the no-player retry below. OCR
 * routinely reads set/parallel wordmarks printed on the front of modern
 * inserts ("UD CANVAS", "PRIZM", "CHROME") as the player's name, which
 * both wrecks the initial SCP search and drops playerName scoring to 0
 * on every candidate — landing real matches at ~60 against the normal
 * 65 bar (see the Binnington C-66 case that motivated this).
 *
 * We only consider a retry when the first pass already had cardNumber +
 * year + brand (worth 60 of the 100 total weight on their own), so a
 * 55 floor on the retry still requires the match to pick up another
 * small signal (set contains / parallel neutral) before it's accepted.
 * Wrong-player collisions that happen to share cardNumber + year + brand
 * would also fail the set check against the scan, so they stay below.
 */
const RETRY_THRESHOLD = 55;

/** Heuristic — is this cardNumber specific enough to anchor a no-player
 *  retry? Rejects empty strings, single-character codes ("A"), and
 *  pure-letter codes ("RC") where collisions across sets are likely. */
function isSpecificCardNumber(n: string | null | undefined): boolean {
  const s = (n ?? "").trim();
  if (s.length < 2) return false;
  return /\d/.test(s);
}

/**
 * Look up the catalog match + price curve for a single scan.
 *
 * Typical path is one search request and (on a confident match) one
 * product request. When the first search misses and we still have a
 * strong structured anchor (card# + year + brand), we run a second
 * search with the player name omitted — see the comment on
 * `RETRY_THRESHOLD` above. Worst case is two search + one product
 * request; all three are rate-limited and cached by the client.
 */
export async function lookupCard(
  input: ScanQueryInput,
  opts: LookupOptions = {},
): Promise<CatalogLookupResult> {
  const query = buildSearchQuery(input);
  if (!query) {
    // No identifiable query — don't bother hitting SCP or logging.
    return { status: "miss", reason: "no_query", query: "" };
  }

  let candidates;
  try {
    candidates = await searchProducts(query);
  } catch (err) {
    if (err instanceof ScpNotConfiguredError) {
      // Quietly skip — local dev without a token shouldn't clutter logs.
      return { status: "miss", reason: "not_configured", query };
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    await logMiss({
      input, query, reason: "api_error", userId: opts.userId ?? null,
      errorMessage,
    });
    return { status: "miss", reason: "api_error", query, errorMessage };
  }

  let ranked = candidates.length > 0 ? rankCandidates(input, candidates) : null;
  let finalQuery = query;
  let finalInput: ScanQueryInput = input;
  /** True when the hit we eventually return came from the no-player retry. */
  let recoveredByRetry = false;

  // First-pass decision: hit, or fall into the retry gate on miss.
  const firstPassMissed =
    candidates.length === 0 || !ranked?.best || !ranked.confident;

  if (firstPassMissed) {
    // Retry gate — only fire when the structured anchor is strong enough
    // that a 55 floor on the retry is still discriminating. Requires a
    // non-empty player to retry against (nothing to drop otherwise).
    const shouldRetry =
      !!input.playerName?.trim() &&
      !!input.year &&
      !!input.brand?.trim() &&
      isSpecificCardNumber(input.cardNumber);

    if (shouldRetry) {
      const retryInput: ScanQueryInput = { ...input, playerName: null };
      const retryQuery = buildSearchQuery(retryInput);
      console.log(
        `[SCP] first-pass miss, retrying without player: "${query}" → "${retryQuery}"`,
      );
      let retryCandidates: Awaited<ReturnType<typeof searchProducts>> = [];
      try {
        retryCandidates = await searchProducts(retryQuery);
      } catch (err) {
        // Retry API error doesn't invalidate the original miss — log once
        // with the original query so miss analytics stay clean.
        console.warn(
          '[SCP] no-player retry threw, reporting original miss:',
          err instanceof Error ? err.message : err,
        );
      }

      if (retryCandidates.length > 0) {
        const retryRanked = rankCandidates(retryInput, retryCandidates);
        if (
          retryRanked.best &&
          retryRanked.best.score >= RETRY_THRESHOLD
        ) {
          console.log(
            `[SCP] no-player retry RECOVERED: score=${retryRanked.best.score} ` +
              `(retry threshold ${RETRY_THRESHOLD}) ` +
              `"${retryRanked.best.candidate["product-name"]}"`,
          );
          ranked = retryRanked;
          finalQuery = retryQuery;
          finalInput = retryInput;
          recoveredByRetry = true;
        }
      }
    }
  }

  // No viable candidate after the retry — log the miss with the ORIGINAL
  // query/input so miss analytics reflect what the caller actually asked
  // for (not our internal retry shape).
  if (!ranked || !ranked.best || ranked.best.score < (recoveredByRetry ? RETRY_THRESHOLD : MATCH_THRESHOLD)) {
    if (candidates.length === 0) {
      await logMiss({ input, query, reason: "no_results", userId: opts.userId ?? null });
      return { status: "miss", reason: "no_results", query };
    }
    await logMiss({
      input, query, reason: "below_threshold", userId: opts.userId ?? null,
      candidates: ranked?.top,
      bestScore: ranked?.best?.score ?? null,
    });
    const topCandidates: CatalogMissCandidate[] = (ranked?.top ?? [])
      .slice(0, 3)
      .map((c) => ({
        productName: c.candidate["product-name"],
        consoleName: c.candidate["console-name"],
        score: c.score,
      }));
    return { status: "miss", reason: "below_threshold", query, topCandidates };
  }

  // Confident match — now fetch the full product for price data.
  void finalQuery; // reserved for future per-query diagnostics; silence TS unused
  void finalInput;
  let product;
  try {
    product = await getProduct(ranked.best.candidate.id);
  } catch (err) {
    const errorMessage = err instanceof ScpApiError ? err.message : String(err);
    await logMiss({
      input, query, reason: "api_error", userId: opts.userId ?? null,
      errorMessage,
    });
    return { status: "miss", reason: "api_error", query, errorMessage };
  }

  return {
    status: "hit",
    query,
    match: {
      source: SOURCE_SLUG,
      productId: product.id,
      productName: product["product-name"],
      consoleName: product["console-name"],
      matchScore: ranked.best.score,
      matchBreakdown: ranked.best.breakdown,
      priceCurve: buildPriceCurve(product),
      recoveredByRetry,
    },
  };
}

// ---------------------------------------------------------------------------
// Miss logging
// ---------------------------------------------------------------------------
// Writes run concurrently with the main flow and are best-effort. We
// catch and swallow DB errors — losing a miss row is not worth blocking
// a scan on.

interface LogMissInput {
  input: ScanQueryInput;
  query: string;
  reason: ScpMissLogInsert["reason"];
  userId: number | null;
  candidates?: Array<{ score: number; breakdown: Record<string, number>; candidate: { id: string; "product-name": string; "console-name": string } }>;
  bestScore?: number | null;
  errorMessage?: string;
}

async function logMiss(args: LogMissInput): Promise<void> {
  try {
    const candidatesPayload = args.candidates?.map((c) => ({
      id: c.candidate.id,
      productName: c.candidate["product-name"],
      consoleName: c.candidate["console-name"],
      score: c.score,
      breakdown: c.breakdown,
    })) ?? null;

    await db.insert(scpMissLog).values({
      userId: args.userId,
      playerName: args.input.playerName ?? null,
      year: args.input.year ?? null,
      brand: args.input.brand ?? null,
      collection: args.input.collection ?? null,
      setName: args.input.setName ?? null,
      cardNumber: args.input.cardNumber ?? null,
      parallel: args.input.parallel ?? null,
      query: args.query,
      reason: args.reason,
      candidates: candidatesPayload as any,
      bestScore: args.bestScore != null ? args.bestScore.toFixed(3) : null,
      errorMessage: args.errorMessage ?? null,
    });
  } catch (err) {
    // Diagnostic table — never let a log failure cascade into the scan flow.
    console.warn("[SCP] miss log insert failed:", err instanceof Error ? err.message : err);
  }
}

// Re-exports for consumers that want more granular control.
export { MATCH_THRESHOLD } from "./match";
export type { ScanQueryInput } from "./match";
export type { PriceCurve, GradedPrice } from "./priceCurve";
