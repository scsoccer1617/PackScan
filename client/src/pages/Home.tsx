import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Camera, Mic, PenLine, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import ModeTile from "@/components/ModeTile";

/**
 * Redesigned Home — the collector's dashboard.
 *
 * Data comes from two existing endpoints (no new backend work):
 *   /api/collection/summary   → { cardCount, totalValue } for the hero
 *   /api/scan-grades?limit=8  → recent Holo grade runs for the carousel
 *
 * The "Most valuable card" strip used to live here but now lives on the
 * Stats page only — it was duplicated between Home and Stats and Home
 * already leads with the collection total value.
 *
 * Weekly delta is intentionally omitted for now — we don't store price
 * snapshots over time, so there's no honest number to show. Can be added
 * in a later PR once a `card_value_history` rollup exists.
 */

type CollectionSummary = { cardCount: number; totalValue: number };

type ScanGradesResponse = {
  success: boolean;
  grades: Array<{
    id: number;
    cardId?: number | null;
    overall: number;
    label: string;
    /** Sentinel `"none"` marks rows inserted when auto-grade was off.
        We still want these in Recent Scans (same thumbnail + identification)
        but the grade pill is hidden because there is no real grade. */
    model: string;
    createdAt: string | Date;
    identification: null | {
      player?: string | null;
      year?: number | null;
      brand?: string | null;
      setName?: string | null;
    };
    /** `/uploads/...` URL for the scanned front image, or null for legacy
        rows that predate image persistence. */
    frontImage?: string | null;
    backImage?: string | null;
    /** Cached `cards.estimatedValue` joined server-side when this grade row
        is linked to a saved card. Null for grade-only rows or unpriced cards. */
    cachedPrice?: number | null;
  }>;
};

function money(n: number, fractionDigits = 0) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(n);
}

function gradeTone(n: number): { bg: string; text: string; ring: string } {
  if (n >= 9.5) return { bg: "bg-foil-gold/10", text: "text-foil-gold", ring: "ring-foil-gold/30" };
  if (n >= 9) return { bg: "bg-foil-cyan/10", text: "text-foil-cyan", ring: "ring-foil-cyan/30" };
  if (n >= 8) return { bg: "bg-foil-green/10", text: "text-foil-green", ring: "ring-foil-green/30" };
  if (n >= 6) return { bg: "bg-foil-amber/10", text: "text-foil-amber", ring: "ring-foil-amber/30" };
  return { bg: "bg-foil-red/10", text: "text-foil-red", ring: "ring-foil-red/30" };
}

function relativeTime(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

export default function Home() {
  const { data: summary, isLoading: summaryLoading } = useQuery<CollectionSummary>({
    queryKey: ["/api/collection/summary"],
  });

  const { data: scanGrades } = useQuery<ScanGradesResponse>({
    queryKey: ["/api/scan-grades", { limit: 8 }],
    queryFn: async () => {
      const res = await fetch("/api/scan-grades?limit=8");
      if (!res.ok) throw new Error("Failed to load scans");
      return res.json();
    },
  });

  const recent = scanGrades?.grades ?? [];
  const totalValue = summary?.totalValue ?? 0;
  const cardCount = summary?.cardCount ?? 0;

  return (
    <div className="space-y-6 pt-4 pb-4">
      {/* Collection value hero — big, personal, first thing a collector sees */}
      <section className="mx-4 rounded-3xl overflow-hidden bg-pack text-white relative">
        <div
          aria-hidden
          className="absolute inset-0 opacity-40 pointer-events-none"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 0%, rgba(139,92,246,0.35), transparent 55%), radial-gradient(circle at 100% 100%, rgba(34,211,238,0.25), transparent 50%)",
          }}
        />
        <div className="relative p-5">
          <p className="text-xs uppercase tracking-[0.14em] text-white/60 font-medium">
            Collection value
          </p>
          {summaryLoading ? (
            <div className="h-10 w-40 bg-white/10 rounded mt-2 animate-pulse" />
          ) : (
            <p
              className="font-display text-[40px] leading-none font-semibold mt-2 tracking-tight"
              data-testid="text-collection-value"
            >
              {money(totalValue)}
            </p>
          )}
          <div className="flex items-center gap-2 mt-3 text-sm">
            <span className="text-white/70" data-testid="text-card-count">
              {cardCount.toLocaleString()} {cardCount === 1 ? "card" : "cards"} saved
            </span>
          </div>
        </div>
      </section>

      {/* Primary CTAs — three equal tiles: Scan (photos), Voice (speak it),
          Manual (type it). Scan is the hero and uses the foil treatment. */}
      <section className="mx-4 grid grid-cols-3 gap-2.5">
        <ModeTile
          href="/scan/camera"
          icon={<Camera className="w-5 h-5" strokeWidth={2.25} />}
          label="Scan"
          hint="Front & back"
          primary
          testId="tile-scan"
        />
        <ModeTile
          href="/scan/camera?mode=voice"
          icon={<Mic className="w-5 h-5" strokeWidth={2} />}
          label="Voice"
          hint="Speak it"
          tone="voice"
          testId="tile-voice"
        />
        <ModeTile
          href="/add-card"
          icon={<PenLine className="w-5 h-5" strokeWidth={2} />}
          label="Manual"
          hint="Type it"
          tone="manual"
          testId="tile-manual"
        />
      </section>

      {/* Recent scans — horizontal carousel of real Holo grade runs */}
      {recent.length > 0 && (
        <section>
          <div className="flex items-center justify-between px-4 mb-3">
            <h2 className="text-sm font-semibold text-ink">Recent scans</h2>
            <Link
              href="/collection"
              className="text-xs text-slate-500 flex items-center gap-0.5 hover:text-ink"
              data-testid="link-view-all"
            >
              View Collection <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="flex gap-3 overflow-x-auto px-4 pb-2 no-scrollbar">
            {recent.map((g) => {
              // Rows with model='none' or label='UNGRADED' are scan-activity
              // placeholders inserted when auto-grade was off. Render the
              // thumbnail + identification but hide the grade pill — a "0.0"
              // badge would be visually misleading and uglier than nothing.
              const isGraded = g.model !== "none" && g.label !== "UNGRADED";
              const tone = gradeTone(g.overall);
              const id = g.identification;
              const player = id?.player ?? "Unknown card";
              const meta = [id?.year, id?.brand].filter(Boolean).join(" ");
              const ariaParts = [player, meta].filter(Boolean).join(" – ");
              const href = g.cardId ? `/collection?card=${g.cardId}` : "/collection";
              const hasPrice = typeof g.cachedPrice === "number" && g.cachedPrice > 0;
              return (
                <Link
                  key={g.id}
                  href={href}
                  aria-label={`Open ${ariaParts}`}
                  className="shrink-0 w-[160px] bg-white border border-card-border rounded-2xl overflow-hidden hover:shadow-md transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                  data-testid={`recent-${g.id}`}
                >
                  <div className="aspect-[3/4] bg-muted relative flex items-center justify-center">
                    {g.frontImage ? (
                      <img
                        src={g.frontImage}
                        alt={player}
                        loading="lazy"
                        draggable={false}
                        className="absolute inset-0 w-full h-full object-cover"
                        data-testid={`img-recent-front-${g.id}`}
                      />
                    ) : (
                      <Camera className="w-8 h-8 text-slate-300" strokeWidth={1.5} />
                    )}
                    {isGraded && (
                      <span
                        className={cn(
                          "absolute top-2 right-2 px-2 py-0.5 rounded-full text-[11px] font-semibold ring-1 backdrop-blur bg-white/90",
                          tone.text,
                          tone.ring,
                        )}
                      >
                        {g.overall.toFixed(1)}
                      </span>
                    )}
                  </div>
                  <div className="p-2.5">
                    <p className="text-[13px] font-medium leading-tight truncate text-ink">
                      {player}
                    </p>
                    {meta && (
                      <p className="text-[11px] text-slate-500 truncate">{meta}</p>
                    )}
                    <div className="mt-1.5 flex items-baseline justify-between gap-2 min-w-0">
                      <p className="text-[10px] text-slate-500 truncate">
                        {relativeTime(g.createdAt)}
                      </p>
                      <p
                        className="text-[10px] text-slate-500 shrink-0"
                        data-testid={`text-recent-price-${g.id}`}
                      >
                        {hasPrice ? money(g.cachedPrice as number, 2) : "No active listings"}
                      </p>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* "Most valuable card" moved to the Stats page — previously shown
          both here and there, Stats is the single source of truth now. */}
    </div>
  );
}
