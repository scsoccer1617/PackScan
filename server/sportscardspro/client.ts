/**
 * SportsCardsPro HTTP client.
 *
 * Keeps all direct API concerns isolated from match scoring and the public
 * lookup orchestrator. Callers above this layer should never touch
 * `fetch`, the token, or rate-limit plumbing directly.
 *
 * Rate limit: SCP caps at 1 call/second. We enforce this with a single
 * promise-chain so concurrent callers queue up automatically. CSV
 * downloads (not used here) are capped at 1 per 10 minutes.
 *
 * Caching: 5-minute in-memory LRU keyed by request URL. Prices are
 * stable within a scan session and searches for the same card are
 * repeated often during a single dealer's intake burst.
 *
 * Docs: https://www.sportscardspro.com/api-documentation
 */

import { createHash } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@db";
import { scpProductCache } from "@shared/schema";

const BASE_URL = "https://www.sportscardspro.com";

// Durable DB cache TTL — SCP regenerates prices once per 24h, so any
// cached row younger than this is authoritative. Rows older than this
// trigger a live refresh but remain in the table as an emergency
// fallback in case SCP is unreachable (see readDurableCache).
const DURABLE_TTL_MS = 24 * 60 * 60 * 1000;

// Soft ceiling for how stale a row can be and still be served as an
// emergency fallback. Past this, we'd rather return an error than a
// wildly outdated price.
const DURABLE_STALE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

// SCP's raw product response shape. Prices are integer pennies. Strings
// may be "none" for unset fields like asin/upc.
export interface ScpProduct {
  status: "success" | "error";
  id: string;
  "product-name": string;
  "console-name": string;
  genre?: string;
  "release-date"?: string;
  "sales-volume"?: string;
  // Raw / ungraded
  "loose-price"?: number;
  // Grade tiers (mapped in priceCurve.ts — see documentation for what each key means)
  "new-price"?: number;        // Graded 8 or 8.5
  "cib-price"?: number;         // Graded 7 or 7.5
  "graded-price"?: number;      // Graded 9
  "box-only-price"?: number;    // Graded 9.5
  "manual-only-price"?: number; // PSA 10
  "bgs-10-price"?: number;
  "condition-17-price"?: number; // CGC 10
  "condition-18-price"?: number; // SGC 10
  // Retail buy/sell recommendations (dealer-focused)
  "retail-loose-buy"?: number;
  "retail-loose-sell"?: number;
  "retail-new-buy"?: number;
  "retail-new-sell"?: number;
  "retail-cib-buy"?: number;
  "retail-cib-sell"?: number;
  // Misc identifiers — rarely useful but surface through for completeness.
  upc?: string;
  asin?: string;
  epid?: string;
}

export interface ScpSearchResult {
  status: "success" | "error";
  products: Array<Pick<ScpProduct, "id" | "product-name" | "console-name">>;
}

export interface ScpErrorResponse {
  status: "error";
  "error-message": string;
}

export class ScpNotConfiguredError extends Error {
  constructor() {
    super("SPORTSCARDSPRO_API_TOKEN is not set");
    this.name = "ScpNotConfiguredError";
  }
}

export class ScpApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly apiMessage?: string,
  ) {
    super(message);
    this.name = "ScpApiError";
  }
}

function getToken(): string {
  const token = process.env.SPORTSCARDSPRO_API_TOKEN;
  if (!token) throw new ScpNotConfiguredError();
  return token;
}

// ---------------------------------------------------------------------------
// Rate limiter (1 req/sec, hard cap per SCP docs)
// ---------------------------------------------------------------------------
// A single promise chain that each request extends. Because the chain
// runs in the Node event loop, two near-simultaneous callers will be
// serialized and the second one will wait ~1s before its fetch fires.
// That's exactly what we want — SCP will revoke API access if we burst.

const MIN_GAP_MS = 1100; // small buffer over the 1s limit
let lastCallAt = 0;
let gate: Promise<void> = Promise.resolve();

function acquireSlot(): Promise<void> {
  const next = gate.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastCallAt + MIN_GAP_MS - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  // IMPORTANT: update `gate` to the *silent* tail so later callers queue
  // behind this one. We swallow rejections on the chain itself so a
  // single network error doesn't permanently poison the queue.
  gate = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// Response cache (5-min TTL, bounded size)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;
const cache = new Map<string, CacheEntry<unknown>>();

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // LRU-ish: refresh insertion order.
  cache.delete(key);
  cache.set(key, hit);
  return hit.value as T;
}

function cacheSet<T>(key: string, value: T): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Test hook — cleared between tests, never called in prod. */
export function __clearCacheForTests(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

async function request<T>(path: string, params: Record<string, string>): Promise<T> {
  const token = getToken();
  const qs = new URLSearchParams({ t: token, ...params }).toString();
  const url = `${BASE_URL}${path}?${qs}`;
  // Cache key INTENTIONALLY excludes the token so rotating the token
  // doesn't invalidate everything, and so we never log the token.
  const cacheKey = `${path}?${new URLSearchParams(params).toString()}`;

  const cached = cacheGet<T>(cacheKey);
  if (cached !== undefined) return cached;

  await acquireSlot();

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch (err) {
    throw new ScpApiError(
      `Network error calling SportsCardsPro: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }

  let body: any;
  try {
    body = await resp.json();
  } catch (err) {
    throw new ScpApiError(
      `Non-JSON response from SportsCardsPro (HTTP ${resp.status})`,
      resp.status,
    );
  }

  if (!resp.ok || body?.status === "error") {
    const apiMessage = (body as ScpErrorResponse | undefined)?.["error-message"];
    throw new ScpApiError(
      `SportsCardsPro error (HTTP ${resp.status})${apiMessage ? `: ${apiMessage}` : ""}`,
      resp.status,
      apiMessage,
    );
  }

  cacheSet(cacheKey, body as T);
  return body as T;
}

// ---------------------------------------------------------------------------
// Durable DB-backed cache (24h TTL, 7d emergency fallback)
// ---------------------------------------------------------------------------
// Layered under the 5-minute in-memory cache. Flow is:
//   1. Check in-memory cache    (fastest, survives 5 min)
//   2. Check scp_product_cache  (survives restarts, 24h fresh window)
//   3. Live SCP fetch           (rate-limited, writes both caches)
// If SCP fails on step 3, we fall back to a stale durable row if one
// exists within DURABLE_STALE_LIMIT_MS — prefer stale data to an error.

function hashQuery(kind: "search" | "product", queryText: string): string {
  const normalized = `${kind}:${queryText.trim().toLowerCase().replace(/\s+/g, " ")}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

interface DurableHit<T> {
  value: T;
  fetchedAt: Date;
  ageMs: number;
}

async function readDurableCache<T>(
  kind: "search" | "product",
  queryText: string,
): Promise<DurableHit<T> | null> {
  try {
    const hash = hashQuery(kind, queryText);
    const rows = await db
      .select()
      .from(scpProductCache)
      .where(and(eq(scpProductCache.kind, kind), eq(scpProductCache.queryHash, hash)))
      .orderBy(desc(scpProductCache.fetchedAt))
      .limit(1);
    const hit = rows[0];
    if (!hit) return null;
    return {
      value: hit.responseJson as T,
      fetchedAt: hit.fetchedAt,
      ageMs: Date.now() - hit.fetchedAt.getTime(),
    };
  } catch (err) {
    // Best-effort: if the DB is down, we still want live calls to work.
    console.warn("[SCP] durable cache read failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function writeDurableCache(
  kind: "search" | "product",
  queryText: string,
  value: unknown,
): Promise<void> {
  try {
    const hash = hashQuery(kind, queryText);
    // Upsert-ish: delete any existing row for this key, then insert. A
    // true ON CONFLICT upsert would need a unique index; the pair
    // (kind, query_hash) is logically unique but we only indexed it
    // for lookup speed, not uniqueness (so manual re-scans can inspect
    // history if needed). Delete-then-insert is fine at our volume.
    await db
      .delete(scpProductCache)
      .where(and(eq(scpProductCache.kind, kind), eq(scpProductCache.queryHash, hash)));
    await db.insert(scpProductCache).values({
      kind,
      queryHash: hash,
      queryText,
      responseJson: value as any,
    });
  } catch (err) {
    console.warn("[SCP] durable cache write failed:", err instanceof Error ? err.message : err);
  }
}

/** Periodic cleanup of rows older than the stale limit. Safe to call
 *  from a cron; no-op if nothing to prune. */
export async function pruneDurableCache(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - DURABLE_STALE_LIMIT_MS);
    const result = await db
      .delete(scpProductCache)
      .where(lt(scpProductCache.fetchedAt, cutoff));
    return (result as any)?.rowCount ?? 0;
  } catch (err) {
    console.warn("[SCP] durable cache prune failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}

/**
 * Fetch a single product by its SCP numeric ID. Returns the full price
 * curve. Throws on error — the orchestrator is responsible for turning
 * errors into a silent fallback.
 *
 * Caching:
 *   - Fresh durable cache hit (< 24h)      → returned immediately, no API call.
 *   - Stale durable hit (24h < age < 7d)   → returned only if live SCP fetch fails.
 *   - No durable hit                       → live SCP fetch, result written to cache.
 */
export async function getProduct(id: string): Promise<ScpProduct> {
  if (!/^\d+$/.test(id)) {
    throw new Error(`Invalid SCP product id: ${id}`);
  }

  const durable = await readDurableCache<ScpProduct>("product", id);
  if (durable && durable.ageMs < DURABLE_TTL_MS) {
    return durable.value;
  }

  try {
    const live = await request<ScpProduct>("/api/product", { id });
    // Fire-and-forget; writes are best-effort.
    void writeDurableCache("product", id, live);
    return live;
  } catch (err) {
    if (durable && durable.ageMs < DURABLE_STALE_LIMIT_MS) {
      console.warn(
        `[SCP] live product fetch failed, serving stale cache (${Math.round(durable.ageMs / 3600_000)}h old):`,
        err instanceof Error ? err.message : err,
      );
      return durable.value;
    }
    throw err;
  }
}

/**
 * Full-text search. SCP accepts natural queries like "tom brady rookie".
 * Returns up to ~100 partial product records (id + names) ordered by
 * SCP's internal relevance. Match scoring is done in match.ts.
 *
 * Cached with the same 24h durable policy as getProduct.
 */
export async function searchProducts(query: string): Promise<ScpSearchResult["products"]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const durable = await readDurableCache<ScpSearchResult["products"]>("search", trimmed);
  if (durable && durable.ageMs < DURABLE_TTL_MS) {
    return durable.value;
  }

  try {
    const resp = await request<ScpSearchResult>("/api/products", { q: trimmed });
    const products = resp.products ?? [];
    void writeDurableCache("search", trimmed, products);
    return products;
  } catch (err) {
    if (durable && durable.ageMs < DURABLE_STALE_LIMIT_MS) {
      console.warn(
        `[SCP] live search failed, serving stale cache (${Math.round(durable.ageMs / 3600_000)}h old):`,
        err instanceof Error ? err.message : err,
      );
      return durable.value;
    }
    throw err;
  }
}
