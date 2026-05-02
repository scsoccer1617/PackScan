import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useRoute } from "wouter";
import { ArrowLeft, Camera, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

/**
 * Per-scan detail page reachable from Home → Recent Scans.
 *
 * Read-only inspection of one `scan_grades` row: front+back images,
 * identification, Holo grade (when present), cached price. Action buttons
 * link out to the existing Collection deep-link (when the scan was saved)
 * and to a fresh capture flow. Intentionally does NOT seed `useScanFlow`
 * or call `runPostScanFlow` — `/result` keeps that responsibility.
 */

type ScanGrade = {
  id: number;
  cardId?: number | null;
  overall: number;
  label: string;
  model: string;
  createdAt: string | Date;
  centering: { score: number };
  centeringBack: { score: number } | null;
  corners: { score: number };
  edges: { score: number };
  surface: { score: number };
  notes: string[];
  confidence: number;
  identification: null | {
    player?: string | null;
    year?: number | null;
    brand?: string | null;
    setName?: string | null;
    cardNumber?: string | null;
    variant?: string | null;
    foilType?: string | null;
    isRookieCard?: boolean | null;
  };
  frontImage?: string | null;
  backImage?: string | null;
  cachedPrice?: number | null;
};

type ScanGradeResponse = { success: boolean; grade: ScanGrade };

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

function dash(v: string | number | null | undefined): string {
  if (v == null) return "—";
  const s = typeof v === "number" ? String(v) : v.trim();
  return s.length === 0 ? "—" : s;
}

function IdentRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="text-ink font-medium text-right truncate" data-testid={`text-ident-${label.toLowerCase().replace(/\s+/g, "-")}`}>
        {value}
      </span>
    </div>
  );
}

function SubScore({ label, score }: { label: string; score: number }) {
  return (
    <div className="rounded-xl border border-card-border bg-white px-3 py-2">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="text-lg font-semibold text-ink mt-0.5">{score.toFixed(1)}</p>
    </div>
  );
}

export default function ScanDetail() {
  const [, params] = useRoute<{ id: string }>("/scans/:id");
  const [, setLocation] = useLocation();
  const id = params ? Number(params.id) : NaN;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, error } = useQuery<ScanGradeResponse>({
    queryKey: ["/api/scan-grades", { id }],
    queryFn: async () => {
      const res = await fetch(`/api/scan-grades/${id}`, { credentials: "include" });
      if (res.status === 404) {
        const err = new Error("Not found");
        (err as any).status = 404;
        throw err;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: Number.isFinite(id) && id > 0,
    retry: (failureCount, err: any) => err?.status !== 404 && failureCount < 2,
  });

  // Re-runs the eBay lookup against the existing identification and
  // updates scan_grades.estimated_value. The button on this page used to
  // route into the camera capture flow — repurposed here so users can
  // refresh stale prices without re-photographing the card.
  const refreshPrice = useMutation<{
    success: boolean;
    estimatedValue: number | null;
    query: string;
    resultCount: number;
  }>({
    mutationFn: async () => {
      return apiRequest({
        url: `/api/scan-grades/${id}/refresh-price`,
        method: "POST",
      });
    },
    onSuccess: (res) => {
      if (res.estimatedValue != null && res.estimatedValue > 0) {
        // Refetch the detail row so the price tile re-renders with the
        // new value (server already persisted it).
        queryClient.invalidateQueries({ queryKey: ["/api/scan-grades", { id }] });
        toast({
          title: "Price refreshed",
          description: `Updated to ${money(res.estimatedValue, 2)}.`,
        });
      } else {
        toast({
          title: "No new listings found",
          description: "Price unchanged.",
        });
      }
    },
    onError: (err: any) => {
      toast({
        title: "Refresh failed",
        description: err?.message || "Could not refresh price.",
        variant: "destructive",
      });
    },
  });

  const goBack = () => {
    if (window.history.length > 1) window.history.back();
    else setLocation("/");
  };

  const notFound = (error as any)?.status === 404;

  return (
    <div className="space-y-4 pt-4 pb-8">
      {/* Header — back button + page title */}
      <div className="px-4 flex items-center gap-3">
        <button
          type="button"
          onClick={goBack}
          aria-label="Go back"
          className="-ml-1 p-2 rounded-full hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
          data-testid="button-back"
        >
          <ArrowLeft className="w-5 h-5 text-ink" strokeWidth={2.25} />
        </button>
        <h1 className="font-display text-xl font-semibold text-ink">Scan details</h1>
      </div>

      {isLoading && (
        <div className="px-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="aspect-[3/4] bg-slate-100 rounded-2xl animate-pulse" />
            <div className="aspect-[3/4] bg-slate-100 rounded-2xl animate-pulse" />
          </div>
          <div className="h-32 bg-slate-100 rounded-2xl animate-pulse" />
          <div className="h-24 bg-slate-100 rounded-2xl animate-pulse" />
        </div>
      )}

      {notFound && (
        <div className="px-4">
          <div className="rounded-2xl border border-card-border bg-white p-6 text-center">
            <p className="font-display text-lg text-ink">Scan not found</p>
            <p className="text-sm text-slate-500 mt-1">
              This scan may have been removed or it belongs to a different account.
            </p>
            <Link
              href="/"
              className="inline-flex items-center gap-1 text-sm text-ink mt-4 underline"
              data-testid="link-back-home"
            >
              Back to Home
            </Link>
          </div>
        </div>
      )}

      {!!data?.grade && (() => {
        const g = data.grade;
        const id = g.identification;
        const player = id?.player?.trim() || "Card scan";
        const subtitleParts = [id?.year, id?.brand].filter(Boolean) as Array<string | number>;
        const subtitle = subtitleParts.join(" ");
        const isGraded = g.model !== "none" && g.label !== "UNGRADED";
        const tone = gradeTone(g.overall);
        const hasPrice = typeof g.cachedPrice === "number" && g.cachedPrice > 0;
        const hasBack = !!g.backImage;

        return (
          <>
            {/* Title block */}
            <div className="px-4">
              <p className="font-display text-2xl font-semibold text-ink leading-tight" data-testid="text-scan-player">
                {player}
              </p>
              {subtitle && (
                <p className="text-sm text-slate-500 mt-0.5" data-testid="text-scan-subtitle">
                  {subtitle}
                </p>
              )}
              <p className="text-xs text-slate-500 mt-1">{relativeTime(g.createdAt)}</p>
            </div>

            {/* Hero — front + back images */}
            <div className="px-4">
              <div className={cn("grid gap-3", hasBack ? "grid-cols-2" : "grid-cols-1")}>
                <ImageTile src={g.frontImage ?? null} alt={`${player} front`} testId="img-scan-front" />
                {hasBack && (
                  <ImageTile src={g.backImage!} alt={`${player} back`} testId="img-scan-back" />
                )}
              </div>
            </div>

            {/* Identification */}
            <div className="px-4">
              <div className="rounded-2xl border border-card-border bg-white p-4">
                <p className="text-xs uppercase tracking-[0.12em] text-slate-500 font-medium mb-2">
                  Identification
                </p>
                <div className="divide-y divide-slate-100">
                  <IdentRow label="Player" value={dash(id?.player)} />
                  <IdentRow label="Brand" value={dash(id?.brand)} />
                  <IdentRow label="Set" value={dash(id?.setName)} />
                  <IdentRow label="Year" value={dash(id?.year)} />
                  <IdentRow label="Card #" value={dash(id?.cardNumber)} />
                  <IdentRow label="Variant" value={dash(id?.variant)} />
                  <IdentRow label="Foil" value={dash(id?.foilType)} />
                </div>
              </div>
            </div>

            {/* Grade — only when there's a real grade */}
            {isGraded && (
              <div className="px-4">
                <div className="rounded-2xl border border-card-border bg-white p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.12em] text-slate-500 font-medium">
                        Holo grade
                      </p>
                      <p className="text-sm text-slate-500 mt-0.5">{g.label}</p>
                    </div>
                    <span
                      className={cn(
                        "px-3 py-1 rounded-full text-base font-semibold ring-1",
                        tone.bg,
                        tone.text,
                        tone.ring,
                      )}
                      data-testid="text-scan-overall"
                    >
                      {g.overall.toFixed(1)}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <SubScore label="Centering" score={g.centering.score} />
                    {g.centeringBack && (
                      <SubScore label="Centering (back)" score={g.centeringBack.score} />
                    )}
                    <SubScore label="Corners" score={g.corners.score} />
                    <SubScore label="Edges" score={g.edges.score} />
                    <SubScore label="Surface" score={g.surface.score} />
                  </div>
                  {g.notes.length > 0 && (
                    <details className="mt-3 group">
                      <summary className="cursor-pointer text-xs text-slate-500 hover:text-ink select-none">
                        Notes ({g.notes.length})
                      </summary>
                      <ul className="mt-2 space-y-1 text-sm text-ink list-disc pl-5">
                        {g.notes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              </div>
            )}

            {/* Price */}
            <div className="px-4">
              <div className="rounded-2xl border border-card-border bg-white p-4">
                <p className="text-xs uppercase tracking-[0.12em] text-slate-500 font-medium">
                  Estimated value
                </p>
                <p
                  className="font-display text-2xl font-semibold text-ink mt-1"
                  data-testid="text-scan-price"
                >
                  {hasPrice ? money(g.cachedPrice as number, 2) : "No active listings"}
                </p>
              </div>
            </div>

            {/* Actions */}
            <div className="px-4 space-y-2">
              {g.cardId != null && (
                <Link
                  href={`/collection?card=${g.cardId}`}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-ink text-white text-sm font-semibold py-3 hover:bg-ink/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                  data-testid="button-view-in-collection"
                >
                  <ExternalLink className="w-4 h-4" />
                  View in Collection
                </Link>
              )}
              <button
                type="button"
                onClick={() => refreshPrice.mutate()}
                disabled={refreshPrice.isPending}
                aria-label="Refresh price"
                className="w-full inline-flex items-center justify-center gap-2 rounded-2xl border border-card-border bg-white text-ink text-sm font-semibold py-3 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-60 disabled:cursor-not-allowed"
                data-testid="button-refresh-price"
              >
                {refreshPrice.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Refreshing price…
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4" />
                    Refresh price
                  </>
                )}
              </button>
            </div>
          </>
        );
      })()}
    </div>
  );
}

function ImageTile({
  src,
  alt,
  testId,
}: {
  src: string | null;
  alt: string;
  testId: string;
}) {
  return (
    <div className="aspect-[3/4] bg-muted rounded-2xl border border-card-border overflow-hidden relative flex items-center justify-center">
      {src ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover"
          data-testid={testId}
        />
      ) : (
        <Camera className="w-8 h-8 text-slate-300" strokeWidth={1.5} />
      )}
    </div>
  );
}
