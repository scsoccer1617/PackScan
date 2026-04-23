import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Award, Layers, DollarSign, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CardWithRelations } from "@shared/schema";

/**
 * Redesigned Stats page.
 *
 * Visual direction from packscan-redesign/client/src/pages/Stats.tsx:
 *   - Dark "pack" gradient hero with the collection's current value, a
 *     small "since W1" delta line, and an SVG sparkline of weekly value.
 *   - 4 KPI tiles in a 2×2 grid with foil-tone accent swatches.
 *   - A single "Most valuable set" row at the bottom.
 *
 * Data comes entirely from existing endpoints — no backend work:
 *   /api/collection/summary   → { cardCount, totalValue }
 *   /api/cards                → every card (for weekly-value sparkline,
 *                               monthly-added KPI, and set rollup).
 *   /api/scan-grades?limit=100→ recent Holo grades (for avg-grade and
 *                               scan-count KPIs).
 *
 * KPI mapping vs. prototype (the prototype had mock-only metrics that
 * don't have a real backend counterpart):
 *   - "Pull rate"     → "Scans · 30d"       (count of scans in last 30d)
 *   - "Avg grade"     → unchanged (mean of overall grade across scans)
 *   - "Graded cards"  → unchanged (total scans with a Holo grade on file)
 *   - "This month"    → "Added this month" (sum of estimatedValue for
 *                       cards with createdAt in the current calendar month)
 *
 * Sparkline strategy: bucket every card by the ISO week of its createdAt,
 * cumulatively sum estimatedValue over the most recent 7 weeks (W1 … W7
 * with W7 = this week). That gives a real "collection value over time"
 * line instead of the prototype's mock graphPoints[].
 */

type CollectionSummary = { cardCount: number; totalValue: number };

type ScanGrade = {
  id: number;
  cardId?: number | null;
  overall: number;
  label: string;
  createdAt: string | Date;
};

type ScanGradesResponse = {
  success: boolean;
  grades: ScanGrade[];
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
 * Build a 7-week cumulative-value sparkline.
 *
 * Buckets every card by the week it was createdAt, then returns the
 * running total of estimatedValue at the end of each of the last 7
 * weeks (oldest first). The hero shows W1 … W7 ticks under the line.
 */
function buildSparkline(cards: CardWithRelations[] | undefined) {
  if (!cards || cards.length === 0) return [] as Array<{ week: string; value: number }>;

  const now = new Date();
  const currentWeek = weekStart(now);
  // 7 buckets, index 0 = oldest (6 weeks ago), index 6 = this week
  const buckets: number[] = Array(7).fill(0);
  const weekOffsets: Date[] = [];
  for (let i = 6; i >= 0; i--) {
    const w = new Date(currentWeek);
    w.setDate(currentWeek.getDate() - i * 7);
    weekOffsets.push(w);
  }

  // Running total of cards added <= end of bucket i.
  // Simpler: compute per-week delta, then cumulatively sum.
  const deltas = Array(7).fill(0);
  for (const c of cards) {
    const created = c.createdAt ? new Date(c.createdAt as any) : null;
    if (!created || isNaN(created.getTime())) continue;
    const cw = weekStart(created);
    // Find which bucket this falls into. Anything before the 7-week
    // window folds into bucket 0 so older cards still contribute to
    // the baseline total.
    let idx = 0;
    for (let i = 0; i < 7; i++) {
      if (cw >= weekOffsets[i]) idx = i;
    }
    // But if the card's week is strictly before weekOffsets[0], still
    // bucket 0 (baseline). Above loop already handles that.
    const v = c.estimatedValue ? Number(c.estimatedValue) : 0;
    deltas[idx] += v;
  }
  let run = 0;
  for (let i = 0; i < 7; i++) {
    run += deltas[i];
    buckets[i] = run;
  }
  return weekOffsets.map((_, i) => ({ week: `W${i + 1}`, value: buckets[i] }));
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

  const gradedCount = scanGrades?.grades?.length ?? 0;

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

  // Most-valuable set — group by "collection" (falls back to brand name
  // when collection is blank so we still show something meaningful for
  // cards that only have a brand tagged).
  const mostValuableSet = useMemo(() => {
    if (!cards || cards.length === 0) return null;
    const totals = new Map<string, number>();
    for (const c of cards) {
      const brandName =
        (c as any).brand && typeof (c as any).brand === "object" && "name" in (c as any).brand
          ? ((c as any).brand.name as string)
          : "";
      const key = c.collection?.trim() || brandName || "Untagged";
      const v = c.estimatedValue ? Number(c.estimatedValue) : 0;
      totals.set(key, (totals.get(key) ?? 0) + v);
    }
    let best: { name: string; value: number } | null = null;
    for (const [name, value] of totals.entries()) {
      if (value <= 0) continue;
      if (!best || value > best.value) best = { name, value };
    }
    return best;
  }, [cards]);

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
  const sinceW1 = hasPoints ? Math.max(values[values.length - 1] - values[0], 0) : 0;

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
            Collection value · 7 weeks
          </p>
          <p
            className="font-display text-[34px] font-semibold leading-none mt-2 tracking-tight"
            data-testid="text-collection-value"
          >
            {money(totalValue)}
          </p>
          {hasPoints && sinceW1 > 0 ? (
            <p className="text-xs text-foil-green mt-1.5">
              ↑ {money(sinceW1)} since W1
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
              ? points.map((p) => <span key={p.week}>{p.week}</span>)
              : Array.from({ length: 7 }).map((_, i) => (
                  <span key={i}>W{i + 1}</span>
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
          label="Graded cards"
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

      {/* Most valuable set — single row, gold-tinted swatch matches
          the prototype's treatment. */}
      <section
        className="mx-4 rounded-2xl bg-card border border-card-border p-4 flex items-center gap-3"
        data-testid="row-most-valuable-set"
      >
        <div className="w-10 h-10 rounded-full bg-foil-gold/15 flex items-center justify-center text-foil-gold">
          <Layers className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500">
            Most valuable set
          </p>
          <p className="text-sm font-medium text-ink truncate">
            {mostValuableSet?.name ?? "—"}
          </p>
        </div>
        {mostValuableSet && (
          <p className="text-sm font-semibold text-ink tabular-nums">
            {money(mostValuableSet.value)}
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
