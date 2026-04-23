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
}

export type CatalogLookupResult =
  | { status: "hit"; match: CatalogMatchResult }
  | { status: "miss"; reason: "no_query" | "no_results" | "below_threshold" | "api_error" | "not_configured" };

interface LookupOptions {
  /** User ID for the miss log. Null for unauthenticated callers. */
  userId?: number | null;
}

/**
 * Look up the catalog match + price curve for a single scan.
 *
 * Runs exactly one search request and (on a confident match) one
 * product request — so two API calls max, and those are rate-limited
 * and cached by the client.
 */
export async function lookupCard(
  input: ScanQueryInput,
  opts: LookupOptions = {},
): Promise<CatalogLookupResult> {
  const query = buildSearchQuery(input);
  if (!query) {
    // No identifiable query — don't bother hitting SCP or logging.
    return { status: "miss", reason: "no_query" };
  }

  let candidates;
  try {
    candidates = await searchProducts(query);
  } catch (err) {
    if (err instanceof ScpNotConfiguredError) {
      // Quietly skip — local dev without a token shouldn't clutter logs.
      return { status: "miss", reason: "not_configured" };
    }
    await logMiss({
      input, query, reason: "api_error", userId: opts.userId ?? null,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { status: "miss", reason: "api_error" };
  }

  if (candidates.length === 0) {
    await logMiss({ input, query, reason: "no_results", userId: opts.userId ?? null });
    return { status: "miss", reason: "no_results" };
  }

  const ranked = rankCandidates(input, candidates);
  if (!ranked.best || !ranked.confident) {
    await logMiss({
      input, query, reason: "below_threshold", userId: opts.userId ?? null,
      candidates: ranked.top,
      bestScore: ranked.best?.score ?? null,
    });
    return { status: "miss", reason: "below_threshold" };
  }

  // Confident match — now fetch the full product for price data.
  let product;
  try {
    product = await getProduct(ranked.best.candidate.id);
  } catch (err) {
    await logMiss({
      input, query, reason: "api_error", userId: opts.userId ?? null,
      errorMessage: err instanceof ScpApiError ? err.message : String(err),
    });
    return { status: "miss", reason: "api_error" };
  }

  return {
    status: "hit",
    match: {
      source: SOURCE_SLUG,
      productId: product.id,
      productName: product["product-name"],
      consoleName: product["console-name"],
      matchScore: ranked.best.score,
      matchBreakdown: ranked.best.breakdown,
      priceCurve: buildPriceCurve(product),
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
