// PR #165 — Active-only eBay comps for the result-screen Price tab.
//
// Calls /api/ebay/comps with the final Gemini fields plus the parallel
// the user picked in the (now terminal) GeminiParallelPickerSheet. Renders
// the top ~10 Active listings and bubbles the average price up so the
// persistent hero header can render "Avg $X.XX" alongside the card title.
//
// Active-listings-only by design — the user has confirmed there is no
// sold-listings access through the current eBay credentials, so this UI
// never offers a Sold tab. The label is just "Avg" (no asking/sold
// disambiguation needed when there is exactly one source).
//
// This component is intentionally smaller than EbayPriceResults — it only
// owns the comps list and the avg. EbayPriceResults still drives the
// graded breakdown / catalog strip path, and the search-keyword waterfall
// in /api/ebay-search remains untouched.

import { useEffect, useState } from "react";
import { ExternalLink, TrendingUp, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CardFormValues } from "@shared/schema";

export interface ActiveListing {
  title: string;
  price: number;
  currency: string;
  url: string;
  imageUrl: string;
  condition: string;
}

interface CompsResponse {
  query: string;
  active: ActiveListing[];
  error?: string;
}

interface EbayActiveCompsProps {
  cardData: Partial<CardFormValues>;
  /**
   * Bubble the canonical comp-price metric + the search query up so
   * ScanResult can render the hero subtitle. PR G: `average` is the
   * MEDIAN over the wider Browse pool (limit=100, BIN-only, shipping
   * folded in) returned by /api/ebay/comps/summary — NOT the local
   * mean over the displayed listings. Mean is forwarded too for
   * diagnostics. Fires on every successful (or empty) response.
   */
  onAverage?: (info: {
    average: number;
    median: number | null;
    mean: number | null;
    query: string;
    count: number;
  }) => void;
  /**
   * BR-2: when the analyze handler had time + identity to fire eBay in
   * parallel with combineCardResults, the response carries the top-N
   * listings here. We render them on first paint and skip the mount-time
   * fetch entirely. Null = server skipped / timed out / errored — fall
   * back to the legacy mount-time fetch.
   */
  initialComps?: { query: string; active: ActiveListing[] } | null;
  /**
   * BR-2: the exact query parts the server hashed eBay against. We compare
   * this to the live `cardData`-derived parts on every render; if they
   * diverge (e.g. user picked a different parallel, edited the card) we
   * refetch /api/ebay/comps. If they match, the embedded comps are still
   * valid and no fetch is needed.
   */
  compsQuery?: {
    year: number | string;
    brand: string;
    set: string;
    cardNumber: string;
    player: string;
    parallel: string;
    /** PR #252: subset descriptor as emitted by Gemini (e.g. "Team
     *  Leaders", "MVP"). Empty for non-subset cards. */
    subset?: string;
    /** PR #252: server-side decision about whether subset participates in
     *  the `/api/ebay/comps` re-fetch. When false, this component drops
     *  subset from both the BR-2 partsKey AND the URLSearchParams so the
     *  re-fetch produces the same comps the bulk picker did. */
    useSubsetInComps?: boolean;
  } | null;
}

function buildQueryParts(cardData: Partial<CardFormValues>) {
  const playerName =
    [cardData.playerFirstName, cardData.playerLastName]
      .filter(Boolean)
      .join(" ")
      .trim() || cardData.playerLastName || cardData.playerFirstName || "";
  return {
    year: cardData.year != null ? String(cardData.year) : "",
    brand: cardData.brand || "",
    set: (cardData as any).set || "",
    cardNumber: cardData.cardNumber || "",
    player: playerName,
    parallel: cardData.foilType || "",
  };
}

function formatPrice(price: number, currency: string = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(price);
}

// BR-2: stable string key for both the live cardData parts and the server's
// embedded compsQuery. We use this to decide whether the embedded comps are
// still authoritative (match → use them) or stale (mismatch → refetch).
//
// PR #252: subset participates in the key only when the server's per-scan
// `useSubsetInComps` decision is true AND the server actually had a subset
// to forward. Otherwise we leave it out of the key entirely on both sides
// — the live UI can't mutate subset (no input for it), so including
// `compsQuery.subset` on both halves of the compare just guarantees match
// when the server kept subset, and excluding it on both halves does the
// same when the server dropped it. This is what makes the BR-2 fast-path
// stay aligned with the picker's actual query shape.
function partsKey(p: {
  year: number | string;
  brand: string;
  set: string;
  cardNumber: string;
  player: string;
  parallel: string;
  subset?: string;
}) {
  return [
    p.year != null ? String(p.year) : "",
    p.brand || "",
    p.set || "",
    p.cardNumber || "",
    p.player || "",
    p.parallel || "",
    p.subset || "",
  ].join("|");
}

export default function EbayActiveComps({
  cardData,
  onAverage,
  initialComps,
  compsQuery,
}: EbayActiveCompsProps) {
  const liveParts = buildQueryParts(cardData);
  // PR #252: subset is server-decided per scan. The live cardData has no
  // subset field, so we mirror the server's value into both halves of the
  // BR-2 compare when `useSubsetInComps` is true. When false (drop fired),
  // both halves see empty subset and the compare ignores it. Either way
  // the live re-fetch URL below uses the same `useSubsetInComps` rule.
  const useSubsetInComps =
    !!compsQuery && compsQuery.useSubsetInComps !== false;
  const subsetForKey =
    useSubsetInComps && compsQuery?.subset ? compsQuery.subset : "";
  const liveKey = partsKey({ ...liveParts, subset: subsetForKey });
  const serverKey = compsQuery
    ? partsKey({
        year: compsQuery.year,
        brand: compsQuery.brand,
        set: compsQuery.set,
        cardNumber: compsQuery.cardNumber,
        player: compsQuery.player,
        parallel: compsQuery.parallel,
        subset: subsetForKey,
      })
    : null;
  // BR-2 fast-path: server already fired the same query; render and skip
  // the mount-time fetch. Mismatch (or no embedded comps) → fall through
  // to the legacy fetch.
  const embeddedAuthoritative =
    !!initialComps && serverKey !== null && serverKey === liveKey;

  const [loading, setLoading] = useState(!embeddedAuthoritative);
  const [listings, setListings] = useState<ActiveListing[]>(
    embeddedAuthoritative && initialComps ? initialComps.active : [],
  );
  const [query, setQuery] = useState(
    embeddedAuthoritative && initialComps ? initialComps.query : "",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Need at least year + brand or a player — otherwise the query is too
    // weak to be useful and we'd just spam eBay with junk.
    const hasEnough = (liveParts.brand && liveParts.year) || liveParts.player;
    if (!hasEnough) {
      setLoading(false);
      setListings([]);
      setQuery("");
      setError(null);
      onAverage?.({ average: 0, median: null, mean: null, query: "", count: 0 });
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (liveParts.year) params.set("year", liveParts.year);
    if (liveParts.brand) params.set("brand", liveParts.brand);
    if (liveParts.set) params.set("set", liveParts.set);
    if (liveParts.cardNumber) params.set("cardNumber", liveParts.cardNumber);
    if (liveParts.player) params.set("player", liveParts.player);
    if (liveParts.parallel) params.set("parallel", liveParts.parallel);
    // PR #252: include subset only when the server's per-scan drop
    // decision says to. Single source of truth (server) — without this,
    // the re-fetch query and the bulk picker query diverge on
    // single-player+fallback subsets (Maddux scenario from `bulk-38-1020`).
    if (useSubsetInComps && compsQuery?.subset) {
      params.set("subset", compsQuery.subset);
    }

    // PR G: the hero subtitle reads MEDIAN from /api/ebay/comps/summary
    // (wider pool of 100 BIN-only listings) — single source of truth
    // shared with bulk auto-save and the reprice path. The displayed
    // listings strip below still comes from /api/ebay/comps (top-N
    // ranked picker output). The two endpoints share the same query +
    // precision filters by design; they only diverge on pool size.
    const summaryParams = new URLSearchParams(params);
    const compsParams = new URLSearchParams(params);
    compsParams.set("limit", "10");

    const compsPromise =
      initialComps && serverKey !== null && serverKey === liveKey
        ? Promise.resolve({
            query: initialComps.query || "",
            active: initialComps.active,
          } as CompsResponse)
        : fetch(`/api/ebay/comps?${compsParams.toString()}`).then(async (r) => {
            if (!r.ok) throw new Error(`comps ${r.status}`);
            return (await r.json()) as CompsResponse;
          });
    const summaryPromise = fetch(
      `/api/ebay/comps/summary?${summaryParams.toString()}`,
    ).then(async (r) => {
      if (!r.ok) throw new Error(`summary ${r.status}`);
      return (await r.json()) as {
        median: number | null;
        mean: number | null;
        count: number;
        query: string;
      };
    });

    Promise.all([compsPromise, summaryPromise])
      .then(([compsData, summaryData]) => {
        if (cancelled) return;
        const active = Array.isArray(compsData.active) ? compsData.active : [];
        setListings(active);
        setQuery(compsData.query || summaryData.query || "");
        const median = summaryData.median;
        const mean = summaryData.mean;
        onAverage?.({
          average: median ?? 0,
          median,
          mean,
          query: compsData.query || summaryData.query || "",
          count: summaryData.count,
        });
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[EbayActiveComps] fetch failed:", err?.message || err);
        setError("Couldn't load eBay listings.");
        setListings([]);
        onAverage?.({ average: 0, median: null, mean: null, query: "", count: 0 });
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // Re-fetch whenever any field that flows into the query changes —
    // critically `foilType`, which is the picker's output. The liveKey
    // dependency captures all of them in a single string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey, serverKey]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-5 w-5" />
          Active eBay listings
          {!loading && listings.length > 0 && (
            <span className="text-sm font-normal text-slate-500">
              ({listings.length})
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading active listings…
          </div>
        ) : error ? (
          <div className="text-sm text-slate-500 py-4">{error}</div>
        ) : listings.length === 0 ? (
          <div className="text-sm text-slate-500 py-4">
            No active listings found{query ? ` for "${query}"` : ""}.
          </div>
        ) : (
          <div className="space-y-3" data-testid="active-comps-list">
            {listings.map((item, idx) => (
              <a
                key={`${item.url}-${idx}`}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-3 p-2 rounded-lg border hover:bg-slate-50 transition"
                data-testid={`active-comp-${idx}`}
              >
                {item.imageUrl ? (
                  <img
                    src={item.imageUrl}
                    alt=""
                    className="w-14 h-18 object-cover rounded border shrink-0"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : (
                  <div className="w-14 h-18 rounded border bg-slate-100 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm line-clamp-2 text-ink">{item.title}</p>
                  {item.condition && (
                    <p className="text-xs text-slate-500 mt-0.5">{item.condition}</p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <div className="font-semibold text-green-700 tabular-nums">
                    {formatPrice(item.price, item.currency)}
                  </div>
                  <div className="text-xs text-slate-400 flex items-center justify-end gap-1 mt-0.5">
                    <ExternalLink className="h-3 w-3" />
                    View
                  </div>
                </div>
              </a>
            ))}
            {query && (
              <div className="pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() =>
                    window.open(
                      `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_BIN=1`,
                      "_blank",
                    )
                  }
                >
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                  Browse all on eBay
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
