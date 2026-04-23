import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Database, Info } from "lucide-react";
import type { CardFormValues } from "@shared/schema";

/**
 * Compact catalog price strip: 4-tier band (Raw / Grade 8 / Grade 9 / PSA 10)
 * sourced from SportsCardsPro. Renders alongside the 3-tier eBay comp grid
 * inside `GradedPriceBreakdown` to give dealers a catalog benchmark next to
 * live market asking prices.
 *
 * Rendering contract:
 *   - Null on no-confident-match (server returned { status: "miss" }).
 *   - Null on API failure. Silent overlay per PR #38a; eBay comps are
 *     unaffected.
 *   - Skeleton row while loading.
 *   - On hit, highlights the tier closest to Holo's predicted PSA grade.
 *
 * Mirrors `server/sportscardspro/priceCurve.ts` \u2014 keep the two in sync
 * when adding new tiers.
 */

interface GradedPriceApi {
  label: string;
  key: string;
  price: number;
}

interface PriceCurveApi {
  raw: GradedPriceApi;
  grade7: GradedPriceApi;
  grade8: GradedPriceApi;
  grade9: GradedPriceApi;
  grade95: GradedPriceApi;
  psa10: GradedPriceApi;
  bgs10: GradedPriceApi;
  cgc10: GradedPriceApi;
  sgc10: GradedPriceApi;
  salesVolume: number | null;
  releaseDate: string | null;
}

interface CatalogMatchApi {
  status: "hit";
  match: {
    source: string;
    productId: string;
    productName: string;
    consoleName: string;
    matchScore: number;
    matchBreakdown: Record<string, number>;
    priceCurve: PriceCurveApi;
  };
}

interface CatalogMissApi {
  status: "miss";
  reason: string;
}

type CatalogResponse = CatalogMatchApi | CatalogMissApi;

interface Props {
  cardData: Partial<CardFormValues>;
  /** Holo's predicted PSA grade integer (1..10) if any \u2014 used to highlight
   *  the matching catalog tier. */
  predictedPsaGrade?: number | null;
}

function formatPrice(price: number): string {
  if (price <= 0) return "\u2014";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: price >= 100 ? 0 : 2,
  }).format(price);
}

/**
 * Map Holo's predicted PSA grade to the matching catalog tier key.
 * Below 8 \u2192 nothing highlighted (we only show 4 tiers in the strip).
 */
function highlightKeyFromPsa(psa: number | null | undefined): string | null {
  if (psa == null || !Number.isFinite(psa)) return null;
  if (psa >= 10) return "psa10";
  if (psa >= 9) return "grade9";
  if (psa >= 8) return "grade8";
  return null;
}

export default function CatalogPriceStrip({ cardData, predictedPsaGrade }: Props) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<CatalogResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      // Same gate as GradedPriceBreakdown \u2014 don't even attempt a query
      // we know is too weak to match. Reduces noise in scp_miss_log.
      const hasEnough =
        (cardData.brand && (cardData.year ?? 0) > 0) ||
        (cardData.playerFirstName && cardData.playerLastName);
      if (!hasEnough) {
        setData(null);
        setLoading(false);
        return;
      }

      const body = {
        playerName:
          cardData.playerFirstName && cardData.playerLastName
            ? `${cardData.playerFirstName} ${cardData.playerLastName}`
            : cardData.playerLastName || cardData.playerFirstName || null,
        year: cardData.year ?? null,
        brand: cardData.brand || null,
        collection: cardData.collection || null,
        setName: (cardData as any).set || null,
        cardNumber: cardData.cardNumber || null,
        parallel: cardData.foilType || cardData.variant || null,
      };

      try {
        const res = await fetch("/api/catalog/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        // 4xx/5xx \u2192 hide strip entirely. The endpoint only returns
        // non-200 on malformed requests, which would indicate a bug.
        if (!res.ok) {
          if (!cancelled) {
            setData(null);
            setLoading(false);
          }
          return;
        }
        const json = (await res.json()) as CatalogResponse;
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setData(null);
          setLoading(false);
        }
      }
    };
    void run();
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
    cardData.variant,
  ]);

  if (loading) {
    return (
      <div className="rounded-lg ring-1 ring-slate-200 bg-slate-50 p-3 animate-pulse h-16" />
    );
  }

  if (!data || data.status !== "hit") return null;

  const curve = data.match.priceCurve;
  const tiers = [
    { key: "raw", label: "Raw", price: curve.raw.price },
    { key: "grade8", label: "Grade 8", price: curve.grade8.price },
    { key: "grade9", label: "Grade 9", price: curve.grade9.price },
    { key: "psa10", label: "PSA 10", price: curve.psa10.price },
  ];
  const highlight = highlightKeyFromPsa(predictedPsaGrade);

  return (
    <div
      className="rounded-lg ring-1 ring-indigo-200 bg-indigo-50/60 p-3"
      data-testid="catalog-price-strip"
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-indigo-900">
          <Database className="h-3.5 w-3.5" />
          Catalog benchmark
          <Badge
            variant="secondary"
            className="text-[10px] px-1.5 py-0 h-4 bg-indigo-100 text-indigo-800 hover:bg-indigo-100"
          >
            SportsCardsPro
          </Badge>
        </div>
        <div
          className="flex items-center gap-1 text-[10px] text-indigo-700"
          title={`Matched ${data.match.productName} \u2014 ${data.match.consoleName} (score ${data.match.matchScore}/100)`}
        >
          <Info className="h-3 w-3" />
          <span className="hidden sm:inline">match {data.match.matchScore}/100</span>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {tiers.map((t) => {
          const isHit = t.key === highlight;
          return (
            <div
              key={t.key}
              className={[
                "rounded-md px-2 py-1.5 text-center",
                isHit
                  ? "bg-indigo-600 text-white ring-1 ring-indigo-700"
                  : "bg-white ring-1 ring-indigo-200 text-slate-900",
              ].join(" ")}
              data-testid={`catalog-tier-${t.key}`}
            >
              <div
                className={[
                  "text-[10px] uppercase tracking-wide",
                  isHit ? "text-indigo-100" : "text-slate-500",
                ].join(" ")}
              >
                {t.label}
              </div>
              <div className="text-sm font-semibold tabular-nums">
                {formatPrice(t.price)}
              </div>
            </div>
          );
        })}
      </div>
      {curve.salesVolume != null && curve.salesVolume > 0 && (
        <p className="mt-2 text-[10px] text-indigo-700/80">
          {curve.salesVolume.toLocaleString()} yearly sales
          {curve.releaseDate ? ` \u00b7 released ${curve.releaseDate}` : ""}
        </p>
      )}
    </div>
  );
}
