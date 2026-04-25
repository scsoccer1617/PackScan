// Bulk Scan batch detail + review queue — /bulk-scan/batches/:id
//
// One screen per batch. Top-of-page summary shows status + counters. Below
// that, items are grouped into three sections:
//
//   1. Review queue (highest priority, expanded by default)
//      Walk through flagged items one at a time. Show what the analyzer
//      extracted, why the confidence gate flagged it, and give Save /
//      Skip actions. Save accepts small inline edits to the key fields so
//      the dealer doesn't have to bounce to /add-card for common misreads.
//
//   2. Auto-saved (collapsed by default, for confidence)
//
//   3. Failed / skipped (collapsed)
//
// Polls while the batch is still processing so new items land in the
// review queue without a manual refresh.

import { useEffect, useMemo, useState } from "react";
import { Link, useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Loader2,
  Save,
  SkipForward,
  ChevronDown,
  ChevronUp,
  Info,
  ListChecks,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

type ItemStatus = "pending" | "processing" | "auto_saved" | "review" | "skipped" | "failed";

interface ScanBatch {
  id: number;
  status: "queued" | "running" | "completed" | "failed";
  fileCount: number;
  processedCount: number;
  reviewQueueCount: number;
  errorMessage: string | null;
  dryRun: boolean;
  createdAt: string;
  completedAt: string | null;
}

interface ScanBatchItem {
  id: number;
  batchId: number;
  position: number;
  backFileId: string | null;
  backFileName: string | null;
  frontFileId: string | null;
  frontFileName: string | null;
  status: ItemStatus;
  confidenceScore: string | null;
  analysisResult: Record<string, any> | null;
  reviewReasons: string[] | null;
  errorMessage: string | null;
}

interface BatchResponse {
  batch: ScanBatch;
  items: ScanBatchItem[];
}

// Human-friendly labels for the flags the confidence gate emits.
const REASON_LABELS: Record<string, string> = {
  missing_player_name: "Player name missing",
  variation_ambiguous: "Ambiguous variation",
  collection_ambiguous: "Ambiguous collection",
  card_number_low_confidence: "Card number unsure",
  low_scp_match: "Low SportsCardsPro match",
  no_scp_match: "No SportsCardsPro match",
  unpaired_trailing_page: "Unpaired page",
  pair_classifier_same_side_front: "Both pages look like fronts",
  pair_classifier_same_side_back: "Both pages look like backs",
  pair_unpaired_trailing_page: "Unpaired page",
};

function reasonLabel(r: string): string {
  if (REASON_LABELS[r]) return REASON_LABELS[r];
  // Best-effort humanize for anything new.
  return r.replace(/[_:]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function BulkScanBatch() {
  const [, params] = useRoute<{ id: string }>("/bulk-scan/batches/:id");
  const batchId = params ? parseInt(params.id, 10) : NaN;
  const { toast } = useToast();

  // The default queryFn only uses `queryKey[0]` as the URL, so we override
  // here to compose the detail path from the batch id. Without this we
  // were silently hitting the LIST endpoint and treating the response as a
  // detail → "Couldn't load batch #N".
  const { data, isLoading, error } = useQuery<BatchResponse>({
    queryKey: ["/api/bulk-scan/batches", batchId],
    queryFn: async () => {
      const res = await fetch(`/api/bulk-scan/batches/${batchId}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    },
    enabled: Number.isFinite(batchId),
  });

  const batch = data?.batch;
  const items = data?.items ?? [];

  const reviewItems = useMemo(
    () => items.filter((i) => i.status === "review"),
    [items],
  );
  const savedItems = useMemo(
    () => items.filter((i) => i.status === "auto_saved"),
    [items],
  );
  const otherItems = useMemo(
    () =>
      items.filter(
        (i) => i.status === "failed" || i.status === "skipped",
      ),
    [items],
  );
  const pendingItems = useMemo(
    () => items.filter((i) => i.status === "pending" || i.status === "processing"),
    [items],
  );

  // Live polling while anything is still moving.
  const active =
    batch?.status === "queued" ||
    batch?.status === "running" ||
    pendingItems.length > 0;
  useEffect(() => {
    if (!active || !Number.isFinite(batchId)) return;
    const t = setInterval(() => {
      queryClient.invalidateQueries({
        queryKey: ["/api/bulk-scan/batches", batchId],
      });
    }, 3000);
    return () => clearInterval(t);
  }, [active, batchId]);

  // Collapsed sections — auto-saved and failed start collapsed because the
  // review queue is what the dealer actually needs to act on.
  const [savedOpen, setSavedOpen] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);

  // Current review pointer so the dealer walks through flagged items one at
  // a time. Clamps when items move out of review (e.g. user taps Save).
  const [reviewCursor, setReviewCursor] = useState(0);
  useEffect(() => {
    if (reviewCursor >= reviewItems.length && reviewItems.length > 0) {
      setReviewCursor(reviewItems.length - 1);
    }
  }, [reviewItems.length, reviewCursor]);

  const saveMutation = useMutation({
    mutationFn: async ({
      itemId,
      edits,
    }: {
      itemId: number;
      edits: Record<string, any>;
    }) =>
      apiRequest({
        url: `/api/bulk-scan/review/${itemId}/save`,
        method: "POST",
        body: edits,
      }),
    onSuccess: () => {
      toast({ title: "Saved to sheet" });
      queryClient.invalidateQueries({
        queryKey: ["/api/bulk-scan/batches", batchId],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/bulk-scan/batches"],
      });
    },
    onError: (err: any) => {
      const msg = String(err?.message || "").replace(/^\d+:\s*/, "");
      toast({ title: "Save failed", description: msg, variant: "destructive" });
    },
  });

  const skipMutation = useMutation({
    mutationFn: async (itemId: number) =>
      apiRequest({
        url: `/api/bulk-scan/review/${itemId}/skip`,
        method: "POST",
      }),
    onSuccess: () => {
      toast({ title: "Skipped" });
      queryClient.invalidateQueries({
        queryKey: ["/api/bulk-scan/batches", batchId],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/bulk-scan/batches"],
      });
    },
    onError: (err: any) => {
      const msg = String(err?.message || "").replace(/^\d+:\s*/, "");
      toast({ title: "Skip failed", description: msg, variant: "destructive" });
    },
  });

  if (!Number.isFinite(batchId)) {
    return <div className="p-4 text-sm text-muted-foreground">Invalid batch.</div>;
  }
  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        <div className="h-24 rounded-2xl bg-muted/40 animate-pulse" />
        <div className="h-40 rounded-2xl bg-muted/30 animate-pulse" />
      </div>
    );
  }
  if (error || !batch) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Couldn't load batch #{batchId}.
      </div>
    );
  }

  return (
    <div className="pt-4 pb-10 space-y-4">
      {/* Header with back link */}
      <div className="px-4 flex items-center gap-2">
        <Link
          href="/bulk-scan"
          className="w-10 h-10 rounded-xl border border-card-border bg-card flex items-center justify-center hover-elevate"
          data-testid="link-back"
          aria-label="Back to bulk scan"
        >
          <ArrowLeft className="w-4 h-4 text-slate-600" />
        </Link>
        <div className="min-w-0">
          <h1 className="font-display text-[20px] font-semibold tracking-tight text-ink truncate">
            Batch #{batch.id}
          </h1>
          <p className="text-xs text-slate-500">
            {active ? "Processing…" : "Complete"} ·{" "}
            {new Date(batch.createdAt).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Summary card */}
      <section className="mx-4 rounded-2xl bg-card border border-card-border p-4">
        <div className="grid grid-cols-4 gap-2">
          <SummaryStat label="Files" value={batch.fileCount} />
          <SummaryStat label="Processed" value={batch.processedCount} />
          <SummaryStat label="Saved" value={savedItems.length} tone="green" />
          <SummaryStat
            label="Review"
            value={batch.reviewQueueCount}
            tone={batch.reviewQueueCount > 0 ? "violet" : "neutral"}
          />
        </div>
        {batch.dryRun && (
          <p className="mt-3 text-[11px] text-foil-violet bg-foil-violet/10 border border-foil-violet/20 rounded-lg px-2 py-1.5">
            Dry-run — no rows written to your sheet, no files moved.
          </p>
        )}
        {batch.status === "failed" && batch.errorMessage && (
          <p className="mt-3 text-[12px] text-foil-red bg-foil-red/5 border border-foil-red/20 rounded-lg px-2 py-1.5">
            {batch.errorMessage}
          </p>
        )}
      </section>

      {/* Review queue */}
      {reviewItems.length > 0 && (
        <section className="mx-4 space-y-2">
          <div className="flex items-baseline justify-between px-1">
            <h2 className="font-display text-sm font-semibold tracking-tight text-ink flex items-center gap-1.5">
              <ListChecks className="w-4 h-4 text-foil-violet" />
              Review queue
            </h2>
            <span className="text-[11px] text-muted-foreground">
              {reviewCursor + 1} of {reviewItems.length}
            </span>
          </div>

          <ReviewCard
            key={reviewItems[reviewCursor]?.id ?? "none"}
            item={reviewItems[reviewCursor]!}
            onSave={(edits) => {
              const currentId = reviewItems[reviewCursor].id;
              saveMutation.mutate(
                { itemId: currentId, edits },
                {
                  onSuccess: () => {
                    // Keep cursor in place — the list will shrink and the
                    // clamp effect will snap us to the next item.
                  },
                },
              );
            }}
            onSkip={() => {
              const currentId = reviewItems[reviewCursor].id;
              skipMutation.mutate(currentId);
            }}
            saving={saveMutation.isPending}
            skipping={skipMutation.isPending}
          />

          {reviewItems.length > 1 && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setReviewCursor((c) => Math.max(0, c - 1))}
                disabled={reviewCursor === 0}
                className="flex-1 h-10 rounded-xl border border-card-border bg-card text-xs font-medium hover-elevate disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="button-review-prev"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() =>
                  setReviewCursor((c) =>
                    Math.min(reviewItems.length - 1, c + 1),
                  )
                }
                disabled={reviewCursor >= reviewItems.length - 1}
                className="flex-1 h-10 rounded-xl border border-card-border bg-card text-xs font-medium hover-elevate disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="button-review-next"
              >
                Next
              </button>
            </div>
          )}
        </section>
      )}

      {/* Pending activity hint */}
      {pendingItems.length > 0 && (
        <section className="mx-4 rounded-2xl border border-dashed border-card-border bg-muted/30 p-3 flex items-center gap-2 text-[12px] text-slate-600">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-foil-violet" />
          {pendingItems.length} more to process.
        </section>
      )}

      {/* Review empty state (batch done, nothing to review) */}
      {reviewItems.length === 0 && batch.status === "completed" && (
        <section className="mx-4 rounded-2xl bg-foil-green/5 border border-foil-green/20 p-4 flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-foil-green" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-ink">
              All clear
            </p>
            <p className="text-[11px] text-muted-foreground">
              Nothing needs your review from this batch.
            </p>
          </div>
        </section>
      )}

      {/* Collapsible: auto-saved */}
      {savedItems.length > 0 && (
        <CollapsibleSection
          title={`Auto-saved (${savedItems.length})`}
          icon={<CheckCircle2 className="w-4 h-4 text-foil-green" />}
          open={savedOpen}
          setOpen={setSavedOpen}
        >
          <div className="space-y-2 px-1">
            {savedItems.map((item) => (
              <ItemSummaryRow key={item.id} item={item} tone="green" />
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Collapsible: failed + skipped */}
      {otherItems.length > 0 && (
        <CollapsibleSection
          title={`Skipped / failed (${otherItems.length})`}
          icon={<AlertTriangle className="w-4 h-4 text-foil-amber" />}
          open={otherOpen}
          setOpen={setOtherOpen}
        >
          <div className="space-y-2 px-1">
            {otherItems.map((item) => (
              <ItemSummaryRow
                key={item.id}
                item={item}
                tone={item.status === "failed" ? "red" : "neutral"}
              />
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

// ── Review card ───────────────────────────────────────────────────────────

function ReviewCard({
  item,
  onSave,
  onSkip,
  saving,
  skipping,
}: {
  item: ScanBatchItem;
  onSave: (edits: Record<string, any>) => void;
  onSkip: () => void;
  saving: boolean;
  skipping: boolean;
}) {
  const snapshot = (item.analysisResult || {}) as Record<string, any>;
  const [player, setPlayer] = useState(
    [snapshot.playerFirstName, snapshot.playerLastName].filter(Boolean).join(" "),
  );
  const [year, setYear] = useState(
    typeof snapshot.year === "number" ? String(snapshot.year) : snapshot.year || "",
  );
  const [brand, setBrand] = useState(snapshot.brand || "");
  const [cardNumber, setCardNumber] = useState(snapshot.cardNumber || "");
  const [variant, setVariant] = useState(snapshot.variant || "");

  // When the item changes (user navigates between review items) reset edits.
  useEffect(() => {
    setPlayer(
      [snapshot.playerFirstName, snapshot.playerLastName].filter(Boolean).join(" "),
    );
    setYear(
      typeof snapshot.year === "number" ? String(snapshot.year) : snapshot.year || "",
    );
    setBrand(snapshot.brand || "");
    setCardNumber(snapshot.cardNumber || "");
    setVariant(snapshot.variant || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const handleSave = () => {
    const trimmed = player.trim();
    const [first, ...rest] = trimmed.split(/\s+/).filter(Boolean);
    const last = rest.join(" ");
    onSave({
      playerFirstName: first || null,
      playerLastName: last || null,
      year: year ? Number(year) : null,
      brand: brand || null,
      cardNumber: cardNumber || null,
      variant: variant || null,
    });
  };

  const score = item.confidenceScore ? Math.round(Number(item.confidenceScore)) : null;
  const reasons = item.reviewReasons ?? [];

  return (
    <div
      className="rounded-2xl bg-card border border-card-border p-4 space-y-3"
      data-testid={`review-card-${item.id}`}
    >
      {/* Header: page + confidence */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Pair #{item.position}
          </p>
          <p className="text-xs text-slate-600 truncate">
            {item.frontFileName || "—"}
            {item.frontFileName && item.backFileName && " / "}
            {item.backFileName || (item.frontFileName ? "" : "—")}
          </p>
        </div>
        {score != null && (
          <span
            className={cn(
              "text-[11px] font-semibold rounded-full px-2 py-0.5 border shrink-0",
              score >= 65
                ? "bg-foil-amber/10 border-foil-amber/30 text-foil-amber"
                : "bg-foil-red/5 border-foil-red/20 text-foil-red",
            )}
            aria-label={`Confidence ${score}`}
          >
            {score}% conf.
          </span>
        )}
      </div>

      {/* Reasons */}
      {reasons.length > 0 && (
        <div className="rounded-xl bg-foil-violet/5 border border-foil-violet/15 px-3 py-2 flex items-start gap-2">
          <Info className="w-3.5 h-3.5 text-foil-violet mt-0.5 shrink-0" />
          <div className="text-[11px] text-slate-700 space-y-0.5">
            {reasons.slice(0, 4).map((r) => (
              <div key={r}>{reasonLabel(r)}</div>
            ))}
            {reasons.length > 4 && (
              <div className="text-muted-foreground">
                +{reasons.length - 4} more
              </div>
            )}
          </div>
        </div>
      )}

      {/* Editable fields (inline — the full /add-card editor is still there
          if a dealer wants everything). */}
      <div className="grid grid-cols-2 gap-2">
        <EditField
          label="Player"
          value={player}
          onChange={setPlayer}
          className="col-span-2"
          testId="input-review-player"
        />
        <EditField
          label="Year"
          value={year}
          onChange={setYear}
          inputMode="numeric"
          testId="input-review-year"
        />
        <EditField
          label="Card #"
          value={cardNumber}
          onChange={setCardNumber}
          testId="input-review-card-number"
        />
        <EditField
          label="Brand"
          value={brand}
          onChange={setBrand}
          testId="input-review-brand"
        />
        <EditField
          label="Variation"
          value={variant}
          onChange={setVariant}
          testId="input-review-variant"
        />
      </div>

      {/* Estimated value read-only */}
      {typeof snapshot.estimatedValue === "number" && (
        <div className="text-[11px] text-slate-600">
          Analyzer estimate:{" "}
          <span className="font-medium text-ink">
            ${snapshot.estimatedValue.toFixed(2)}
          </span>
          {snapshot.set && (
            <>
              {" "}· <span className="font-medium text-ink">{snapshot.set}</span>
            </>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || skipping}
          className={cn(
            "flex-1 h-11 rounded-xl font-display font-semibold text-sm flex items-center justify-center gap-1.5 transition",
            "bg-foil-violet text-white hover-elevate disabled:opacity-50",
          )}
          data-testid="button-review-save"
        >
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          Save to sheet
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={saving || skipping}
          className="h-11 px-3 rounded-xl border border-card-border bg-card text-xs font-medium hover-elevate disabled:opacity-50 flex items-center gap-1.5"
          data-testid="button-review-skip"
        >
          {skipping ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <SkipForward className="w-3.5 h-3.5" />
          )}
          Skip
        </button>
      </div>
    </div>
  );
}

function EditField({
  label,
  value,
  onChange,
  className,
  inputMode,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
  inputMode?: "text" | "numeric";
  testId?: string;
}) {
  return (
    <div className={className}>
      <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <input
        type="text"
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full h-10 rounded-xl bg-background border border-card-border px-2.5 text-sm outline-none focus:ring-2 focus:ring-foil-violet/30"
        data-testid={testId}
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}

// ── Summary row (auto-saved + skipped/failed lists) ───────────────────────

function ItemSummaryRow({
  item,
  tone,
}: {
  item: ScanBatchItem;
  tone: "green" | "red" | "neutral";
}) {
  const snapshot = (item.analysisResult || {}) as Record<string, any>;
  const label =
    [snapshot.year, snapshot.brand, snapshot.playerLastName]
      .filter(Boolean)
      .join(" ") ||
    item.frontFileName ||
    item.backFileName ||
    `Pair #${item.position}`;
  const toneBubble =
    tone === "green"
      ? "bg-foil-green/10 text-foil-green"
      : tone === "red"
      ? "bg-foil-red/10 text-foil-red"
      : "bg-muted text-slate-500";
  const icon =
    tone === "green" ? (
      <CheckCircle2 className="w-4 h-4" />
    ) : tone === "red" ? (
      <AlertTriangle className="w-4 h-4" />
    ) : (
      <Clock className="w-4 h-4" />
    );

  return (
    <div className="rounded-xl bg-card border border-card-border px-3 py-2 flex items-center gap-3">
      <div
        className={cn(
          "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
          toneBubble,
        )}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-ink truncate">{label}</p>
        <p className="text-[11px] text-muted-foreground truncate">
          {snapshot.cardNumber && `#${snapshot.cardNumber}`}
          {snapshot.cardNumber && snapshot.set && " · "}
          {snapshot.set || ""}
          {item.status === "failed" && item.errorMessage && ` · ${item.errorMessage}`}
        </p>
      </div>
      {item.confidenceScore && (
        <span className="text-[11px] text-muted-foreground shrink-0">
          {Math.round(Number(item.confidenceScore))}%
        </span>
      )}
    </div>
  );
}

// ── Collapsible wrapper ───────────────────────────────────────────────────

function CollapsibleSection({
  title,
  icon,
  open,
  setOpen,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  open: boolean;
  setOpen: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="mx-4 space-y-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-1 py-1.5 rounded-lg hover-elevate"
        data-testid={`toggle-${title.split(" ")[0].toLowerCase()}`}
      >
        {icon}
        <span className="font-display text-sm font-semibold tracking-tight text-ink">
          {title}
        </span>
        <span className="ml-auto text-muted-foreground">
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </button>
      {open && children}
    </section>
  );
}

// ── Summary stat ──────────────────────────────────────────────────────────

function SummaryStat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "green" | "violet";
}) {
  const color =
    tone === "green"
      ? "text-foil-green"
      : tone === "violet"
      ? "text-foil-violet"
      : "text-ink";
  return (
    <div className="text-center">
      <p className={cn("font-display text-lg font-semibold leading-none", color)}>
        {value}
      </p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mt-1">
        {label}
      </p>
    </div>
  );
}
