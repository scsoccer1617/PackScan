import { useEffect, useState } from "react";
import { Database } from "lucide-react";
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
  /**
   * F-3b: Optional pre-fetched catalog result forwarded by the server on the
   * main scan response. The server fires SCP speculatively during the
   * preliminary front-OCR call while the user flips the card, so by the time
   * this page mounts the lookup has usually resolved. When present we skip
   * the /api/catalog/match round trip entirely \u2014 rendering SCP pricing
   * immediately on result-page load. Absent / `null` falls through to the
   * existing client-side fetch path with zero regression.
   */
  speculativeCatalog?: CatalogResponse | null;
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

export default function CatalogPriceStrip({
  cardData,
  predictedPsaGrade,
  speculativeCatalog,
}: Props) {
  // F-3b: seed state from the server-forwarded speculative result when present.
  // This lets the hero render immediately on mount without a skeleton flash,
  // and skips the client-side /api/catalog/match fetch entirely below.
  const [loading, setLoading] = useState(!speculativeCatalog);
  const [data, setData] = useState<CatalogResponse | null>(speculativeCatalog ?? null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      // F-3b: short-circuit \u2014 server already handed us a completed result.
      // The speculative lookup used the same OCR identity that drives cardData
      // here, and the server's sanity check already confirmed player identity
      // matches before forwarding, so this is safe to trust directly.
      if (speculativeCatalog) {
        setData(speculativeCatalog);
        setLoading(false);
        return;
      }

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
    speculativeCatalog,
  ]);

  if (loading) {
    // PR #38b: hero skeleton \u2014 taller and rounded to match the promoted
    // layout below. Still low-key enough not to cause flash if SCP misses.
    return (
      <div
        className="rounded-xl ring-1 ring-indigo-200 bg-indigo-50/40 p-4 animate-pulse h-32"
        aria-label="Loading catalog price"
      />
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

  // PR #38b: the "anchor" price is whichever tier Holo predicted \u2014 that's
  // the most meaningful single number for this scan. Falls back to raw
  // when Holo didn't run or predicted below grade 8.
  const anchorTier = tiers.find((t) => t.key === highlight) ?? tiers[0];

  return (
    <div
      className="rounded-xl ring-1 ring-indigo-300/70 bg-gradient-to-br from-indigo-50 to-white p-4 shadow-sm"
      data-testid="catalog-price-strip"
    >
      {/* Header: just the "Market Price" label. Source badge (SportsCardsPro)
          and the match-confidence Info tooltip were removed — dealers don't
          need to see the upstream data source or the internal match score
          on the primary price surface. The matched product name / console
          already appears below the anchor price for anyone who wants to
          sanity-check the lookup. */}
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-indigo-950">
          <Database className="h-4 w-4 text-indigo-700" />
          Market Price
        </div>
      </div>

      {/* Anchor headline \u2014 the one number a dealer should read first. */}
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="text-3xl font-bold tabular-nums text-indigo-950 leading-none">
            {formatPrice(anchorTier.price)}
          </div>
          <div className="mt-1 text-[11px] uppercase tracking-wide text-indigo-700/80">
            {highlight
              ? `Predicted ${anchorTier.label.toLowerCase()} value`
              : `${anchorTier.label.toLowerCase()} value`}
          </div>
        </div>
        <div className="text-[10px] text-indigo-700/70 text-right shrink-0 max-w-[55%] truncate">
          <div className="truncate">{data.match.productName}</div>
          <div className="truncate">{data.match.consoleName}</div>
        </div>
      </div>

      {/* Full price curve as pill cards. Predicted tier is filled
          indigo; others are outlined. data-testid pattern preserved. */}
      <div className="grid grid-cols-4 gap-2">
        {tiers.map((t) => {
          const isHit = t.key === highlight;
          return (
            <div
              key={t.key}
              className={[
                "rounded-lg px-2 py-2 text-center transition-colors",
                isHit
                  ? "bg-indigo-600 text-white ring-1 ring-indigo-700 shadow-sm"
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
              <div className="text-sm font-semibold tabular-nums mt-0.5">
                {formatPrice(t.price)}
              </div>
            </div>
          );
        })}
      </div>

      {curve.salesVolume != null && curve.salesVolume > 0 && (
        <p className="mt-3 text-[11px] text-indigo-700/80">
          {curve.salesVolume.toLocaleString()} yearly sales
          {curve.releaseDate ? ` \u00b7 released ${curve.releaseDate}` : ""}
        </p>
      )}
    </div>
  );
}
