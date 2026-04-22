import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ExternalLink,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  ShoppingBag,
} from "lucide-react";
import type { CardFormValues } from "@shared/schema";

/**
 * Shape of one tier returned by GET /api/ebay-graded-search. Mirrors
 * server/routes.ts\u2019s `toTier` helper \u2014 keep the two in sync if either
 * side changes.
 */
type GradedTier = {
  grade: string;
  averageValue: number;
  count: number;
  items: Array<{
    title: string;
    price: number;
    currency: string;
    url: string;
    imageUrl: string;
    condition: string;
    endTime: string;
  }>;
  searchUrl: string;
  dataType: "sold" | "current";
  errorMessage?: string;
  empty: boolean;
};

type GradedResponse = {
  predictedPsaGrade: number | null;
  raw: GradedTier | null;
  atGrade: GradedTier | null;
  topGrade: GradedTier | null;
};

interface GradedPriceBreakdownProps {
  cardData: Partial<CardFormValues>;
  holoOverall: number | null | undefined;
}

function formatPrice(price: number, currency: string = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: price >= 100 ? 0 : 2,
  }).format(price);
}

/**
 * Compute the median of an array of prices. The server returns an
 * `averageValue` (arithmetic mean), which is more sensitive to outliers \u2014
 * a single mispriced slab can pull PSA 10 comps way off. We compute
 * median on the client so the headline number tracks what most buyers
 * actually paid.
 */
function median(prices: number[]): number {
  if (!prices.length) return 0;
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Returns [low, high] of a trimmed price range so a single lucky or
 * disastrous sale doesn\u2019t dominate the displayed range. We strip the
 * top/bottom 10 % when count >= 5; otherwise show the full min/max.
 */
function priceRange(prices: number[]): [number, number] {
  if (!prices.length) return [0, 0];
  if (prices.length < 5) {
    return [Math.min(...prices), Math.max(...prices)];
  }
  const sorted = [...prices].sort((a, b) => a - b);
  const lo = Math.floor(sorted.length * 0.1);
  const hi = Math.ceil(sorted.length * 0.9) - 1;
  return [sorted[lo], sorted[hi]];
}

// Visual tone for each tier column. Three-column layout keeps these
// near-neutral so the tier labels + prices do the talking.
const TIER_TONES: Record<
  "raw" | "atGrade" | "topGrade",
  { icon: typeof ShoppingBag; badge: string; ring: string }
> = {
  raw: {
    icon: ShoppingBag,
    badge: "bg-slate-100 text-slate-700",
    ring: "ring-slate-200",
  },
  atGrade: {
    icon: ShieldCheck,
    badge: "bg-cyan-100 text-cyan-800",
    ring: "ring-cyan-200",
  },
  topGrade: {
    icon: Sparkles,
    badge: "bg-amber-100 text-amber-800",
    ring: "ring-amber-200",
  },
};

function TierColumn({
  tier,
  label,
  sublabel,
  variant,
}: {
  tier: GradedTier | null;
  label: string;
  sublabel: string;
  variant: "raw" | "atGrade" | "topGrade";
}) {
  const tone = TIER_TONES[variant];
  const Icon = tone.icon;

  // Tier was intentionally not fetched (e.g. no predicted grade yet).
  if (!tier) {
    return (
      <div
        className={`flex-1 rounded-lg ring-1 ${tone.ring} bg-white p-4 flex flex-col gap-2 min-w-0`}
      >
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-slate-500" />
          <span className="text-sm font-semibold text-slate-700">{label}</span>
        </div>
        <div className="text-xs text-slate-500">{sublabel}</div>
        <div className="text-sm text-slate-400 mt-2">—</div>
      </div>
    );
  }

  const prices = tier.items.map((it) => it.price).filter((p) => p > 0);
  const med = median(prices) || tier.averageValue || 0;
  const [low, high] = priceRange(prices);

  return (
    <div
      className={`flex-1 rounded-lg ring-1 ${tone.ring} bg-white p-4 flex flex-col gap-2 min-w-0`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="h-4 w-4 text-slate-500 shrink-0" />
          <span className="text-sm font-semibold text-slate-700 truncate">
            {label}
          </span>
        </div>
        <Badge
          variant="secondary"
          className={`${tone.badge} text-[10px] font-medium px-1.5 py-0 h-5 shrink-0`}
        >
          {sublabel}
        </Badge>
      </div>

      {tier.empty ? (
        <div className="flex flex-col gap-2 mt-1">
          <div className="text-sm text-slate-500 italic">
            {tier.dataType === "current" ? "No active listings yet" : "No comps yet"}
          </div>
          {tier.searchUrl && (
            <a
              href={tier.searchUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                // Some mobile webviews (iOS PWA, in-app browsers) silently
                // swallow target="_blank" on bare anchors. Force-open a new
                // window in the same click tick as a fallback.
                e.preventDefault();
                window.open(tier.searchUrl, "_blank", "noopener,noreferrer");
              }}
              className="text-xs text-blue-600 hover:text-blue-800 inline-flex items-center gap-1 py-1 -my-1 cursor-pointer"
              data-testid={`link-search-ebay-${variant}`}
            >
              <ExternalLink className="h-3 w-3" />
              Search eBay
            </a>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-slate-900 tabular-nums">
              {formatPrice(med)}
            </span>
            <span className="text-[11px] text-slate-500 uppercase tracking-wide">
              {tier.dataType === "current" ? "asking" : "sold"} median
            </span>
          </div>
          {low > 0 && high > 0 && low !== high && (
            <div className="text-xs text-slate-500 tabular-nums">
              {formatPrice(low)} – {formatPrice(high)}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 mt-1">
            <span className="text-xs text-slate-500">
              {tier.count} listing{tier.count === 1 ? "" : "s"}
            </span>
            {tier.searchUrl && (
              <a
                href={tier.searchUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  // See note on the empty-state link above — webviews can
                  // swallow bare target="_blank" taps. Force-open in the
                  // same click tick.
                  e.preventDefault();
                  window.open(tier.searchUrl, "_blank", "noopener,noreferrer");
                }}
                className="text-xs text-blue-600 hover:text-blue-800 inline-flex items-center gap-1 py-1 -my-1 cursor-pointer"
                data-testid={`link-view-ebay-${variant}`}
              >
                <ExternalLink className="h-3 w-3" />
                eBay
              </a>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Three-tier graded-price comparison:
 *   Raw  \u2014  ungraded comps (slabs filtered out)
 *   At grade  \u2014  PSA {predictedGrade} comps
 *   Top grade \u2014  PSA 10 comps (ceiling)
 *
 * Only renders when we have a Holo grade to anchor the at-grade tier.
 * The parent (PriceLookup) hides this component entirely when holoGrade
 * is null to avoid running an extra eBay call when Holo didn\u2019t run.
 */
export default function GradedPriceBreakdown({
  cardData,
  holoOverall,
}: GradedPriceBreakdownProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<GradedResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchTiers = async () => {
      setLoading(true);
      setError(null);

      // The same gate as EbayPriceResults \u2014 don\u2019t bother hitting the API
      // if we don\u2019t have enough identification for a meaningful query.
      const hasEnoughForSearch =
        (cardData.brand && (cardData.year ?? 0) > 0) ||
        (cardData.playerFirstName && cardData.playerLastName);
      if (!hasEnoughForSearch) {
        setData(null);
        setLoading(false);
        return;
      }

      try {
        const playerName =
          cardData.playerFirstName && cardData.playerLastName
            ? `${cardData.playerFirstName} ${cardData.playerLastName}`
            : cardData.playerLastName || cardData.playerFirstName || "";
        const params = new URLSearchParams({
          playerName,
          cardNumber: cardData.cardNumber || "",
          brand: cardData.brand || "",
          year: (cardData.year ?? 0).toString(),
          collection: cardData.collection || "",
          set: (cardData as any).set || "",
          condition: cardData.condition || "",
          isNumbered: cardData.isNumbered ? "true" : "false",
          foilType: cardData.foilType || "",
          serialNumber: cardData.serialNumber || "",
          variant: cardData.variant || "",
          isAutographed: cardData.isAutographed ? "true" : "false",
        });
        if (holoOverall != null && Number.isFinite(holoOverall)) {
          params.set("overall", String(holoOverall));
        }

        const res = await fetch(`/api/ebay-graded-search?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as GradedResponse;
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError("Graded price lookup failed.");
          setLoading(false);
        }
      }
    };
    void fetchTiers();
    return () => {
      cancelled = true;
    };
  }, [
    cardData.brand,
    cardData.year,
    cardData.playerFirstName,
    cardData.playerLastName,
    cardData.cardNumber,
    cardData.collection,
    (cardData as any).set,
    cardData.foilType,
    cardData.serialNumber,
    cardData.variant,
    cardData.isNumbered,
    cardData.isAutographed,
    cardData.condition,
    holoOverall,
  ]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4" />
            Comparable Listings
          </CardTitle>
          <p className="text-xs text-slate-500">
            Gathering raw, at-grade, and PSA 10 listings from eBay…
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col md:flex-row gap-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex-1 rounded-lg ring-1 ring-slate-200 bg-white p-4 animate-pulse h-32"
              />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Comparable Listings</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">{error}</p>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const psa = data.predictedPsaGrade;
  const atGradeSublabel = psa ? `predicted PSA ${psa}` : "predicted grade";
  const topGradeSublabel = psa === 10 ? "same as at-grade" : "ceiling";

  return (
    <Card data-testid="card-graded-price-breakdown">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-4 w-4" />
          Comparable Listings
        </CardTitle>
        <p className="text-xs text-slate-500">
          Current eBay asking prices at three slab tiers. Median of active
          listings — not an AI estimate. (Sold data coming once we're
          approved for eBay Marketplace Insights.)
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col md:flex-row gap-3">
          <TierColumn
            tier={data.raw}
            label="Raw"
            sublabel="ungraded"
            variant="raw"
          />
          <TierColumn
            tier={data.atGrade}
            label="At grade"
            sublabel={atGradeSublabel}
            variant="atGrade"
          />
          <TierColumn
            tier={data.topGrade}
            label="Top grade"
            sublabel={topGradeSublabel}
            variant="topGrade"
          />
        </div>
        <p className="text-[11px] text-slate-400 mt-3">
          Graded tiers filter to PSA slabs only. Other grading companies may
          price differently.
        </p>
      </CardContent>
    </Card>
  );
}
