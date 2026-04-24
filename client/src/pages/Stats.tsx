import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Award, DollarSign, Sparkles, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CardWithRelations } from "@shared/schema";

/**
 * Redesigned Stats page.
 *
 * Visual direction from packscan-redesign/client/src/pages/Stats.tsx:
 *   - Dark "pack" gradient hero with the collection's current value, a
 *     small growth-since-first-scan line, and an SVG sparkline of
 *     weekly value over the most recent (up to 7) weeks.
 *   - 4 KPI tiles in a 2×2 grid with foil-tone accent swatches.
 *   - A single "Most valuable card" row at the bottom.
 *
 * Data comes entirely from existing endpoints — no backend work:
 *   /api/collection/summary   → { cardCount, totalValue }
 *   /api/cards                → every card (for weekly-value sparkline,
 *                               monthly-added KPI, and set rollup).
 *   /api/scan-grades?limit=100→ recent Holo grades (for avg-grade and
 *                               scan-count KPIs).
 *   /api/stats/top-cards      → top-5-by-estimatedValue; #1 drives the
 *                               "Most valuable card" row at the bottom.
 *
 * KPI mapping vs. prototype (the prototype had mock-only metrics that
 * don't have a real backend counterpart):
 *   - "Pull rate"     → "Scans · 30d"       (count of scans in last 30d)
 *   - "Avg grade"     → unchanged (mean of overall grade across scans)
 *   - "Unique card scans" → count of distinct cards that have a Holo
 *                           grade on file (deduped per cardId, falling
 *                           back to grade.id for untracked scans). Label
 *                           renamed from "Graded cards" so it's clear it
 *                           counts unique cards, not total scan events.
 *   - "This month"    → "Added this month" (sum of estimatedValue for
 *                       cards with createdAt in the current calendar month)
 *
 * Sparkline strategy: bucket every card by the ISO week of its createdAt,
 * cumulatively sum estimatedValue over the most recent 7 weeks. Leading
 * zero weeks are trimmed so the chart starts at the first activity
 * (prevents the "flat $0 until W5" look). Ticks are labeled as short
 * dates instead of W1…W7 so the timeline is self-explanatory.
 */

type CollectionSummary = { cardCount: number; totalValue: number };

type ScanGrade = {
  id: number;
  cardId?: number | null;
  overall: number;
  label: string;
  createdAt: string | Date;
  /** Identification captured during grading — used to dedupe scans by card
      so the "Cards graded" KPI counts unique cards, not raw scan events. */
  identification?: {
    player?: string | null;
    year?: number | string | null;
    brand?: string | null;
  } | null;
};

type ScanGradesResponse = {
  success: boolean;
  grades: ScanGrade[];
};

// Mirrors the shape /api/stats/top-cards returns — kept narrow on purpose
// so Stats only depends on the fields it actually renders.
type TopCard = {
  id: number;
  playerFirstName: string;
  playerLastName: string;
  year: number;
  estimatedValue: string | null;
  frontImage: string | null;
  brand?: { name?: string } | null;
};

function money(n: number, fractionDigits = 0) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: fractionDigits,
  }).format(n);
}

/** Monday 00:00 of the week that contains `d`, local time. */
function weekStart(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const day = out.getDay(); // 0=Sun, 1=Mon
  const diffToMonday = (day + 6) % 7;
  out.setDate(out.getDate() - diffToMonday);
  return out;
}

/**
 * Build a cumulative-value sparkline over the most recent weeks.
 *
 * Windowing:
 * - At most 7 weeks are shown.
 * - Weeks older than the oldest card are trimmed so a brand-new
 *   collector's chart doesn't look like a flat $0 until week 5. When
 *   trimming happens we always keep at least 2 points (the week before
 *   the first add, at $0, plus the first non-zero week) so the growth
 *   is still legible.
 * - Cards created before the 7-week window fold into the earliest
 *   kept bucket as a baseline so their value doesn't disappear.
 *
 * Ticks are labeled as short dates (e.g. "Mar 4", "Now") instead of
 * abstract W1…W7, which matches how dealers think about inventory.
 */
function buildSparkline(cards: CardWithRelations[] | undefined) {
  type Point = { week: string; value: number };
  if (!cards || cards.length === 0) return [] as Point[];

  const now = new Date();
  const currentWeek = weekStart(now);
  // 7 weekly offsets, oldest → newest. Index 6 is this week.
  const weekOffsets: Date[] = [];
  for (let i = 6; i >= 0; i--) {
    const w = new Date(currentWeek);
    w.setDate(currentWeek.getDate() - i * 7);
    weekOffsets.push(w);
  }

  // Per-week deltas plus a "before the window" baseline so older cards
  // still contribute their value at the start of the line instead of
  // being dropped or stuffed into bucket 0 (which used to make W1 equal
  // the entire lifetime total).
  const deltas = Array(7).fill(0);
  let baseline = 0;
  for (const c of cards) {
    const created = c.createdAt ? new Date(c.createdAt as any) : null;
    if (!created || isNaN(created.getTime())) continue;
    const cw = weekStart(created);
    const v = c.estimatedValue ? Number(c.estimatedValue) : 0;
    if (cw < weekOffsets[0]) {
      baseline += v;
      continue;
    }
    let idx = 0;
    for (let i = 0; i < 7; i++) {
      if (cw >= weekOffsets[i]) idx = i;
    }
    deltas[idx] += v;
  }
  const buckets: number[] = Array(7).fill(0);
  let run = baseline;
  for (let i = 0; i < 7; i++) {
    run += deltas[i];
    buckets[i] = run;
  }

  // Trim leading buckets that are still at the baseline — i.e. no
  // activity yet. Keep the last trimmed bucket as the $0 (or baseline)
  // starting point so the line has somewhere to start from.
  let firstActivityIdx = 0;
  for (let i = 0; i < 7; i++) {
    if (deltas[i] > 0) { firstActivityIdx = i; break; }
    firstActivityIdx = i + 1;
  }
  // If there's no activity at all, show the whole window so the empty
  // state still reads correctly.
  let startIdx = 0;
  if (firstActivityIdx < 7 && firstActivityIdx > 0) {
    startIdx = Math.max(firstActivityIdx - 1, 0);
  }

  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  return weekOffsets.slice(startIdx).map((d, i, arr) => ({
    week: i === arr.length - 1 ? "Now" : fmt.format(d),
    value: buckets[startIdx + i],
  }));
}

export default function Stats() {
  const { data: summary } = useQuery<CollectionSummary>({
    queryKey: ["/api/collection/summary"],
  });

  const { data: cards } = useQuery<CardWithRelations[]>({
    queryKey: ["/api/cards"],
  });

  const { data: scanGrades } = useQuery<ScanGradesResponse>({
    queryKey: ["/api/scan-grades?limit=100"],
  });

  const points = useMemo(() => buildSparkline(cards), [cards]);

  // Derived KPIs
  const scans30d = useMemo(() => {
    if (!scanGrades?.grades) return 0;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return scanGrades.grades.filter((g) => {
      const d = new Date(g.createdAt as any).getTime();
      return !isNaN(d) && d >= cutoff;
    }).length;
  }, [scanGrades]);

  const avgGrade = useMemo(() => {
    if (!scanGrades?.grades || scanGrades.grades.length === 0) return 0;
    const sum = scanGrades.grades.reduce((acc, g) => acc + (Number(g.overall) || 0), 0);
    return sum / scanGrades.grades.length;
  }, [scanGrades]);

  // "Cards graded" — unique cards graded, not raw scan events. A dealer
  // flipping a card back-and-forth can easily rack up 10+ grade rows for
  // a single card; counting raw rows made the KPI balloon far past the
  // number of cards actually in the sheet (e.g. 83 scans against 7 rows).
  // We dedupe by (playerLastName + year + brand) — the same identification
  // signature the server uses to backfill Collection images.
  const gradedCount = useMemo(() => {
    const grades = scanGrades?.grades ?? [];
    if (grades.length === 0) return 0;
    const seen = new Set<string>();
    for (const g of grades) {
      const ident = g.identification;
      if (!ident) {
        // Pre-identification rows still represent a unique scan event; key
        // on the grade row id so they don't collapse into one bucket.
        seen.add(`id:${g.id}`);
        continue;
      }
      const last =
        (typeof ident.player === "string" ? ident.player.trim().split(/\s+/).pop() : "") || "";
      const yearStr =
        ident.year == null ? "" : String(ident.year).trim();
      const brand = (ident.brand ?? "").trim();
      const sig = `${last.toLowerCase()}|${yearStr}|${brand.toLowerCase()}`;
      // If every identification field is blank, fall back to the row id so
      // empty-ident rows don't all collapse into one bucket either.
      seen.add(sig === "||" ? `id:${g.id}` : sig);
    }
    return seen.size;
  }, [scanGrades]);

  const addedThisMonth = useMemo(() => {
    if (!cards) return 0;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    return cards
      .filter((c) => {
        if (!c.createdAt) return false;
        const d = new Date(c.createdAt as any);
        return !isNaN(d.getTime()) && d >= monthStart;
      })
      .reduce((acc, c) => acc + (c.estimatedValue ? Number(c.estimatedValue) : 0), 0);
  }, [cards]);

  // Most-valuable card — pulls from the same /api/stats/top-cards feed
  // Home already uses. We show the #1 card so collectors see their
  // crown-jewel card (not just its set) without a second hop.
  const { data: topCards } = useQuery<TopCard[]>({
    queryKey: ["/api/stats/top-cards"],
  });
  const topCard = topCards?.[0];

  // Sparkline geometry. Guards against degenerate cases where every
  // bucket is equal (e.g. single card, or no data yet).
  const W = 320;
  const H = 120;
  const values = points.map((p) => p.value);
  const hasPoints = points.length > 0 && values.some((v) => v > 0);
  const max = hasPoints ? Math.max(...values) : 1;
  const min = hasPoints ? Math.min(...values) : 0;
  const range = max - min || 1;
  const pts = points.map((p, i) => {
    const x = (i / Math.max(points.length - 1, 1)) * W;
    const y = hasPoints ? H - ((p.value - min) / range) * H : H;
    return [x, y] as [number, number];
  });
  const line = pts
    .map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`))
    .join(" ");
  const area = pts.length > 0 ? `${line} L${W},${H} L0,${H} Z` : "";

  const totalValue = summary?.totalValue ?? 0;
  // Growth shown next to the hero is from the first tick of the trimmed
  // window to "Now". When the window starts before any activity, the
  // first tick is $0 (or the pre-window baseline) so this reads as pure
  // growth rather than "value compared to 7 weeks ago".
  const growthSinceStart = hasPoints
    ? Math.max(values[values.length - 1] - values[0], 0)
    : 0;
  const startLabel = points[0]?.week ?? "start";

  return (
    <div className="pt-4 pb-6 space-y-5">
      {/* Page heading */}
      <div className="px-4">
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">
          Stats
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Track how your collection and pulls are performing.
        </p>
      </div>

      {/* Collection-value hero — dark pack-gradient card with sparkline. */}
      <section className="mx-4 rounded-3xl bg-pack text-white p-5 relative overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "radial-gradient(circle at 0% 100%, rgba(139,92,246,0.35), transparent 55%), radial-gradient(circle at 100% 0%, rgba(34,211,238,0.25), transparent 55%)",
          }}
        />
        <div className="relative">
          <p className="text-[11px] uppercase tracking-[0.14em] text-white/60">
            Collection value{points.length > 0 ? ` · ${points.length} weeks` : ""}
          </p>
          <p
            className="font-display text-[34px] font-semibold leading-none mt-2 tracking-tight"
            data-testid="text-collection-value"
          >
            {money(totalValue)}
          </p>
          {hasPoints && growthSinceStart > 0 ? (
            <p className="text-xs text-foil-green mt-1.5">
              ↑ {money(growthSinceStart)} since {startLabel}
            </p>
          ) : (
            <p className="text-xs text-white/50 mt-1.5">
              Add cards to grow the curve
            </p>
          )}

          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="mt-4 w-full h-[120px]"
            preserveAspectRatio="none"
            aria-hidden
          >
            <defs>
              <linearGradient id="statsAreaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(139,92,246,0.55)" />
                <stop offset="100%" stopColor="rgba(139,92,246,0)" />
              </linearGradient>
            </defs>
            {hasPoints && (
              <>
                <path d={area} fill="url(#statsAreaGrad)" />
                <path
                  d={line}
                  fill="none"
                  stroke="hsl(260 80% 68%)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {pts.map(([x, y], i) => (
                  <circle
                    key={i}
                    cx={x}
                    cy={y}
                    r={i === pts.length - 1 ? 3.5 : 2}
                    fill="hsl(260 80% 68%)"
                  />
                ))}
              </>
            )}
          </svg>
          <div className="flex justify-between text-[10px] text-white/50 mt-1">
            {points.length > 0
              ? points.map((p, i) => <span key={`${p.week}-${i}`}>{p.week}</span>)
              : Array.from({ length: 7 }).map((_, i) => (
                  <span key={i}>—</span>
                ))}
          </div>
        </div>
      </section>

      {/* KPI grid — 4 tiles, 2×2 on mobile. Each tile has a foil-tone
          accent swatch in the top-left and a big display number below. */}
      <section className="px-4 grid grid-cols-2 gap-2">
        <KpiCard
          icon={<Sparkles className="w-4 h-4" />}
          label="Scans · 30d"
          value={String(scans30d)}
          tone="violet"
          testId="kpi-scans-30d"
        />
        <KpiCard
          icon={<Award className="w-4 h-4" />}
          label="Avg grade"
          value={gradedCount > 0 ? avgGrade.toFixed(1) : "—"}
          tone="gold"
          testId="kpi-avg-grade"
        />
        <KpiCard
          icon={<TrendingUp className="w-4 h-4" />}
          label="Unique card scans"
          value={String(gradedCount)}
          tone="green"
          testId="kpi-graded-count"
        />
        <KpiCard
          icon={<DollarSign className="w-4 h-4" />}
          label="Added this month"
          value={money(addedThisMonth)}
          sub={summary ? `${summary.cardCount} cards total` : undefined}
          tone="cyan"
          testId="kpi-added-month"
        />
      </section>

      {/* Most valuable card — single row, gold-tinted swatch. Uses the
          top-cards feed so the label, year, and brand line up with what
          Home's "Most valuable card" strip already shows. */}
      <section
        className="mx-4 rounded-2xl bg-card border border-card-border p-4 flex items-center gap-3"
        data-testid="row-most-valuable-card"
      >
        <div className="w-10 h-10 rounded-full bg-foil-gold/15 flex items-center justify-center text-foil-gold">
          <Star className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500">
            Most valuable card
          </p>
          <p
            className="text-sm font-medium text-ink truncate"
            data-testid="text-most-valuable-card"
          >
            {topCard
              ? [
                  `${topCard.playerFirstName ?? ""} ${topCard.playerLastName ?? ""}`.trim() ||
                    "Untitled card",
                  topCard.year ? String(topCard.year) : null,
                  topCard.brand?.name ?? null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "—"}
          </p>
        </div>
        {topCard && (
          <p className="text-sm font-semibold text-ink tabular-nums">
            {money(Number(topCard.estimatedValue ?? 0))}
          </p>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* KpiCard — reused tile for the 2×2 grid. */

function KpiCard({
  icon,
  label,
  value,
  sub,
  tone,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone: "violet" | "gold" | "green" | "cyan";
  testId?: string;
}) {
  const tones = {
    violet: "text-foil-violet bg-foil-violet/10 ring-foil-violet/20",
    gold: "text-foil-gold bg-foil-gold/10 ring-foil-gold/20",
    green: "text-foil-green bg-foil-green/10 ring-foil-green/20",
    cyan: "text-foil-cyan bg-foil-cyan/10 ring-foil-cyan/20",
  }[tone];

  return (
    <div
      className="rounded-2xl bg-card border border-card-border p-4"
      data-testid={testId}
    >
      <div
        className={cn(
          "w-8 h-8 rounded-lg ring-1 flex items-center justify-center",
          tones,
        )}
      >
        {icon}
      </div>
      <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500 mt-3">
        {label}
      </p>
      <p className="font-display text-2xl font-semibold leading-none mt-1 text-ink">
        {value}
      </p>
      {sub && <p className="text-[10px] text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}
