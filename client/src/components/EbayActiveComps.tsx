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
   * Bubble the computed average + the search query up so ScanResult can
   * render an "Avg $X.XX" line in the persistent hero header. Fires on
   * every successful (or empty) response.
   */
  onAverage?: (info: { average: number; query: string; count: number }) => void;
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

export default function EbayActiveComps({ cardData, onAverage }: EbayActiveCompsProps) {
  const [loading, setLoading] = useState(true);
  const [listings, setListings] = useState<ActiveListing[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const parts = buildQueryParts(cardData);
    // Need at least year + brand or a player — otherwise the query is too
    // weak to be useful and we'd just spam eBay with junk.
    const hasEnough = (parts.brand && parts.year) || parts.player;
    if (!hasEnough) {
      setLoading(false);
      setListings([]);
      setQuery("");
      setError(null);
      onAverage?.({ average: 0, query: "", count: 0 });
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (parts.year) params.set("year", parts.year);
    if (parts.brand) params.set("brand", parts.brand);
    if (parts.set) params.set("set", parts.set);
    if (parts.cardNumber) params.set("cardNumber", parts.cardNumber);
    if (parts.player) params.set("player", parts.player);
    if (parts.parallel) params.set("parallel", parts.parallel);
    params.set("limit", "10");

    fetch(`/api/ebay/comps?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`comps ${r.status}`);
        return (await r.json()) as CompsResponse;
      })
      .then((data) => {
        if (cancelled) return;
        const active = Array.isArray(data.active) ? data.active : [];
        setListings(active);
        setQuery(data.query || "");
        const avg = active.length
          ? active.reduce((sum, i) => sum + (i.price || 0), 0) / active.length
          : 0;
        onAverage?.({ average: avg, query: data.query || "", count: active.length });
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[EbayActiveComps] fetch failed:", err?.message || err);
        setError("Couldn't load eBay listings.");
        setListings([]);
        onAverage?.({ average: 0, query: "", count: 0 });
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // Re-fetch whenever any field that flows into the query changes —
    // critically `foilType`, which is the picker's output.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cardData.year,
    cardData.brand,
    (cardData as any).set,
    cardData.cardNumber,
    cardData.playerFirstName,
    cardData.playerLastName,
    cardData.foilType,
  ]);

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
