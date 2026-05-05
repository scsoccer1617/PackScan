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
import { Link, useLocation, useRoute } from "wouter";
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
  Trash2,
  RefreshCw,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { postScanCorrections } from "@/lib/scanCorrections";
import { cn } from "@/lib/utils";
import type { Player } from "@shared/players";
import {
  computeConfirmationDiff,
  logScanConfirmation,
  type PredictedFields,
} from "@/lib/scanConfirmation";

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
  // pairCount: number of pairs the worker is or will be processing.
  // phase1Done: Phase 1 (file discovery + pairing) finished. Both come
  // from the server via /api/bulk-scan/batches/:id and let the UI show
  // forward motion during the +25s Phase 1 window where processedCount
  // is still 0 but the worker is actively probing files.
  pairCount?: number;
  phase1Done?: boolean;
}

// Action-oriented labels for the flags the confidence gate emits — wording
// tells the dealer WHAT TO DO to self-correct, not just what's wrong.
const REASON_LABELS: Record<string, string> = {
  // Identity / OCR
  vlm_empty_identity: "Couldn't read card — try a sharper photo",
  player_name_missing: "Add player name",
  missing_player_name: "Add player name", // legacy alias
  card_number_missing: "Add card number",
  card_number_low_confidence: "Verify card number",
  brand_missing: "Add brand",
  year_missing: "Add year",
  variation_ambiguous: "Pick the correct parallel/variation",
  collection_ambiguous: "Pick the correct set",

  // Pricing
  low_scp_match: "Verify card details — weak price match",
  no_scp_match: "Verify card details — no price match found",
  card_db_uncorroborated: "Verify card — not found in database",

  // Pairing
  pair_classifier_same_side_front: "Both pages look like fronts — re-pair",
  pair_classifier_same_side_back: "Both pages look like backs — re-pair",
  pair_classifier_unknown: "Confirm front/back order",
  pair_unpaired_trailing_page: "Missing matching front/back — re-scan",
  unpaired_trailing_page: "Missing matching front/back — re-scan", // legacy alias

  // Operational
  quota_exhausted: "Daily scan limit reached — try again tomorrow",
};

function reasonLabel(r: string): string {
  if (REASON_LABELS[r]) return REASON_LABELS[r];
  if (r.startsWith("sheet_append_failed")) {
    return "Couldn't save to spreadsheet — check connection and retry";
  }
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
  const pairCount = data?.pairCount ?? 0;
  const phase1Done = data?.phase1Done ?? false;

  // Stage chip text — drives the "forward motion" indicator while the
  // worker is mid-batch. Phase 1 (file discovery) takes ~25s on a 74-file
  // batch with no per-card progress to show; Phase 2 streams pair
  // completions but the user wants to see N of M counters, not just a
  // spinner.
  const stageStatus = (() => {
    if (!batch) return null;
    if (batch.status === "completed") {
      return `Done — ${batch.processedCount} cards processed, ${batch.reviewQueueCount} flagged for review`;
    }
    if (batch.status === "failed") return null;
    if (!phase1Done) {
      // Phase 1 in flight. fileCount may be 0 until the recorder logs
      // listInboxImagesMs, so fall back to the inbox file count from
      // the running worker once present.
      const fc = batch.fileCount || 0;
      if (fc > 0) {
        return `Reading ${fc} files — finding pairs…`;
      }
      return "Scanning Drive inbox…";
    }
    if (pairCount === 0) {
      return "Phase 1 done — preparing pairs…";
    }
    if (batch.processedCount < pairCount) {
      return `Found ${batch.fileCount} files → ${pairCount} pairs queued · processing pair ${batch.processedCount + 1} of ${pairCount}…`;
    }
    return `Wrapping up ${pairCount} pairs…`;
  })();

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

  // Delete the entire batch and its items. The server blocks while
  // status='running'; we additionally hide the button in that case so
  // the user never sees a guaranteed-409 click target. On success we
  // bounce back to the batch list — the current detail view points to
  // a batch that no longer exists.
  const [, setLocation] = useLocation();
  const deleteBatchMutation = useMutation({
    mutationFn: async () =>
      apiRequest<{ ok: true }>({
        url: `/api/bulk-scan/batches/${batchId}`,
        method: "DELETE",
      }),
    onSuccess: () => {
      toast({
        title: `Batch #${batchId} deleted`,
        description: "Drive files and sheet rows were not touched.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/bulk-scan/batches"] });
      queryClient.invalidateQueries({
        queryKey: ["/api/bulk-scan/inbox-diagnostic"],
      });
      setLocation("/bulk-scan");
    },
    onError: (err: any) => {
      const raw = String(err?.message || "").replace(/^\d+:\s*/, "");
      let msg = raw;
      try {
        msg = JSON.parse(raw).message || JSON.parse(raw).error || raw;
      } catch {}
      toast({
        title: "Couldn't delete batch",
        description: msg,
        variant: "destructive",
      });
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
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[20px] font-semibold tracking-tight text-ink truncate">
            Batch #{batch.id}
          </h1>
          <p className="text-xs text-slate-500">
            {active ? "Processing…" : "Complete"} ·{" "}
            {new Date(batch.createdAt).toLocaleString()}
          </p>
        </div>
        {batch.status !== "running" && (
          <button
            type="button"
            onClick={() => {
              const warn =
                batch.processedCount > 0
                  ? " Any cards already saved to your sheet will stay there \u2014 delete those rows manually if you want a true reset."
                  : "";
              const ok = window.confirm(
                `Delete batch #${batch.id}? This removes the batch and its review queue from Holo.${warn}`,
              );
              if (!ok) return;
              deleteBatchMutation.mutate();
            }}
            disabled={deleteBatchMutation.isPending}
            className="w-10 h-10 rounded-xl border border-card-border bg-card flex items-center justify-center text-muted-foreground hover:text-destructive hover-elevate disabled:opacity-50"
            data-testid="button-delete-batch"
            aria-label="Delete this batch"
            title="Delete this batch"
          >
            {deleteBatchMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
          </button>
        )}
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
        {stageStatus && (
          <p
            className="mt-3 text-[12px] text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 flex items-center gap-2"
            data-testid="text-stage-status"
          >
            {active && (
              <Loader2 className="w-3 h-3 animate-spin text-slate-500 shrink-0" />
            )}
            <span className="truncate">{stageStatus}</span>
          </p>
        )}
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

/**
 * Re-price preview shape returned by POST /api/bulk-scan/review/:itemId/reprice.
 * Mirrors `CompsSummary` from server/ebayCompsSummary.ts plus the rebuilt
 * outbound URL. Used to update the visible price/listings when the dealer
 * clicks Save or "Analyze & Price" — the freshly-priced mean is then passed
 * back in the /save payload as `estimatedValue` so the Sheet column matches.
 */
interface RepriceResponse {
  ok: true;
  itemId: number;
  summary: {
    mean: number | null;
    median: number | null;
    count: number;
    query: string;
    listings: Array<RepriceListing>;
  };
  // PR AE (Bug 3a): top-level listings array — same pool as
  // summary.listings, the ≤10 newest BIN comps the mean was computed
  // from. The dealer-visible reprice strip renders these so initial
  // scan and re-analyze produce identical listings + identical mean.
  listings: Array<RepriceListing>;
  pickerActive?: Array<RepriceListing>;
  ebaySearchUrl: string | null;
  query: string;
}

interface RepriceListing {
  title: string;
  price: number;
  currency?: string;
  url: string;
  imageUrl?: string;
  condition?: string;
}

// PR AE: title-based detector for graded slabs. Mirrors the negatives
// PICKER_EXCLUSION_CHAIN now appends server-side; this is a belt-and-
// suspenders visual flag in case eBay's keyword match still lets a
// PSA/BGS/SGC/CGC/graded/slabbed listing through into the rendered pool.
const GRADED_TITLE_RE = /\b(PSA|BGS|SGC|CGC|graded|slabbed)\b/i;
function isGradedTitle(title: string): boolean {
  return GRADED_TITLE_RE.test(title || "");
}

// PR AE: "Fresh" badge window — 30s after a successful reprice we render
// a small green chip on the listings strip so the dealer knows the comps
// they're staring at came from a *just-now* fetch (bypassCache: true on
// the server) rather than a 60s-cached pool from before their edits.
const FRESH_BADGE_MS = 30_000;

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
  // Full sheet-schema-aligned editable state. Booleans stay as booleans;
  // numerics stay as strings while typing so we can re-empty them.
  const [player, setPlayer] = useState("");
  const [year, setYear] = useState("");
  const [brand, setBrand] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const [variant, setVariant] = useState("");
  const [sport, setSport] = useState("");
  const [collection, setCollection] = useState("");
  const [setName, setSetName] = useState("");
  const [cmpNumber, setCmpNumber] = useState("");
  const [foilType, setFoilType] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [estimatedValue, setEstimatedValue] = useState("");
  const [isRookieCard, setIsRookieCard] = useState(false);
  const [isAutographed, setIsAutographed] = useState(false);
  const [isNumbered, setIsNumbered] = useState(false);

  // When the item changes (user navigates between review items) reset edits
  // back to the analyzer snapshot. Keep this in one place — if we miss a
  // field we'd carry stale state across items.
  // Multi-player snapshots: render the joined "First Last / First Last"
  // string in the editable input so the dealer sees both names. When the
  // text is left unchanged on save, we forward snapshot.players[] verbatim
  // so vintage subset cards (1984 Topps Living Legends, N.L. Strikeout
  // Leaders, etc.) keep both players through review-save.
  const snapshotPlayers: Player[] | null = Array.isArray(snapshot.players) && snapshot.players.length > 0
    ? (snapshot.players as Player[])
    : null;
  const seededPlayerText = snapshotPlayers && snapshotPlayers.length > 1
    ? snapshotPlayers
        .map((p) => [p.firstName?.trim() ?? "", p.lastName?.trim() ?? ""].filter(Boolean).join(" "))
        .filter(Boolean)
        .join(" / ")
    : [snapshot.playerFirstName, snapshot.playerLastName].filter(Boolean).join(" ");

  useEffect(() => {
    setPlayer(seededPlayerText);
    setYear(typeof snapshot.year === "number" ? String(snapshot.year) : snapshot.year || "");
    setBrand(snapshot.brand || "");
    setCardNumber(snapshot.cardNumber || "");
    setVariant(snapshot.variant || "");
    setSport(snapshot.sport || "");
    setCollection(snapshot.collection || "");
    setSetName(snapshot.set || "");
    setCmpNumber(snapshot.cmpNumber || "");
    setFoilType(snapshot.foilType || "");
    setSerialNumber(snapshot.serialNumber || "");
    setEstimatedValue(
      typeof snapshot.estimatedValue === "number" ? snapshot.estimatedValue.toFixed(2) : "",
    );
    setIsRookieCard(!!snapshot.isRookieCard);
    setIsAutographed(!!snapshot.isAutographed);
    setIsNumbered(!!snapshot.isNumbered);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // PR Y: review-flow re-price. Save auto-runs this with the edited
  // identity, then immediately commits the row carrying the fresh mean.
  // The "Analyze & Price" button calls the same path but stops at the
  // preview — useful when the dealer wants to inspect the new comps
  // before deciding to save.
  const { toast: rcToast } = useToast();
  const [repricedSummary, setRepricedSummary] = useState<RepriceResponse | null>(null);
  // PR AE: timestamp of the most recent successful reprice. Drives the
  // "Fresh" chip on the listings strip — within FRESH_BADGE_MS we render
  // it so the dealer knows the displayed pool is post-edit (bypassCache).
  const [lastReprisedAt, setLastReprisedAt] = useState<number | null>(null);
  const [freshNow, setFreshNow] = useState(false);
  useEffect(() => {
    if (lastReprisedAt == null) {
      setFreshNow(false);
      return;
    }
    setFreshNow(true);
    const tid = window.setTimeout(() => setFreshNow(false), FRESH_BADGE_MS);
    return () => window.clearTimeout(tid);
  }, [lastReprisedAt]);
  const repriceMutation = useMutation({
    mutationFn: async (edits: Record<string, any>): Promise<RepriceResponse> =>
      apiRequest({
        url: `/api/bulk-scan/review/${item.id}/reprice`,
        method: "POST",
        body: edits,
      }),
    onSuccess: (data) => {
      setRepricedSummary(data);
      setLastReprisedAt(Date.now());
      // Reflect the fresh mean in the editable price field so the dealer
      // sees what's about to be written. Trust the user — they can still
      // manually overwrite this before Save.
      const mean = data?.summary?.mean;
      if (typeof mean === "number" && Number.isFinite(mean)) {
        setEstimatedValue(mean.toFixed(2));
      } else if (data?.summary?.count === 0) {
        setEstimatedValue("0.00");
      }
    },
    onError: (err: any) => {
      const msg = String(err?.message || "").replace(/^\d+:\s*/, "");
      rcToast({ title: "Re-price failed", description: msg, variant: "destructive" });
    },
  });

  // Build the edited-identity payload for either /reprice or /save.
  // Single source of truth — save and analyze both run against the same
  // shape so the preview pool matches what /save persists.
  const buildEdits = (overrides?: Record<string, any>): Record<string, any> => {
    const trimmed = player.trim();
    const dealerEditedPlayer = trimmed !== seededPlayerText.trim();
    const playersToForward: Player[] | undefined = !dealerEditedPlayer && snapshotPlayers && snapshotPlayers.length > 1
      ? snapshotPlayers
      : undefined;
    const [first, ...rest] = trimmed.split(/\s+/).filter(Boolean);
    const last = rest.join(" ");
    const parsedYear = year ? Number(year) : null;
    const parsedValue = estimatedValue ? Number(estimatedValue) : null;
    return {
      playerFirstName: playersToForward
        ? (playersToForward[0]?.firstName || null)
        : (first || null),
      playerLastName: playersToForward
        ? (playersToForward[0]?.lastName || null)
        : (last || null),
      ...(playersToForward ? { players: playersToForward } : {}),
      year: Number.isFinite(parsedYear) ? parsedYear : null,
      brand: brand || null,
      cardNumber: cardNumber || null,
      variant: variant || null,
      sport: sport || null,
      collection: collection || null,
      set: setName || null,
      cmpNumber: cmpNumber || null,
      foilType: foilType || null,
      serialNumber: serialNumber || null,
      estimatedValue: Number.isFinite(parsedValue) ? parsedValue : null,
      isRookieCard,
      isAutographed,
      isNumbered,
      ...(overrides || {}),
    };
  };

  /**
   * Inline validation — empty required fields can't produce a usable
   * picker query, and we'd rather surface the gap immediately than burn
   * an eBay round-trip to learn it. Mirrors the server's
   * `incomplete_identity` 422 path so the UX stays consistent if the
   * server check fires anyway.
   */
  const validateRequired = (): string | null => {
    if (!brand.trim()) return "Brand is required";
    if (!year.trim() || !Number.isFinite(Number(year))) return "Year is required";
    if (!cardNumber.trim()) return "Card # is required";
    if (!player.trim() && (!snapshotPlayers || snapshotPlayers.length === 0)) {
      return "Player is required";
    }
    return null;
  };

  const handleAnalyze = () => {
    const err = validateRequired();
    if (err) {
      rcToast({ title: "Cannot analyze", description: err, variant: "destructive" });
      return;
    }
    repriceMutation.mutate(buildEdits());
  };

  // PR Y: Save now auto-runs re-price first, then commits the row with
  // the FRESH mean. This collapses the old two-click flow (Analyze &
  // Price → wait → Save) into a single button. The button label
  // sequences "Re-pricing…" → "Saving…" so the dealer sees both steps.
  // Re-price uses the edited identity (Year/Set/etc as the dealer typed
  // them), so a stale auto-extracted price never lands in the sheet
  // when the dealer corrected the year or variant first.
  const handleSave = () => {
    const err = validateRequired();
    if (err) {
      rcToast({ title: "Cannot save", description: err, variant: "destructive" });
      return;
    }
    const edits = buildEdits();
    // PR Z + PR AA hybrid: every Save logs ONE event for ML training.
    // - Empty diff (analyzer was correct, dealer just clicked Save) →
    //   POST /api/scan-confirmations (PR AA, positive label).
    // - Non-empty diff (dealer corrected one or more fields) →
    //   POST /api/scan-corrections (PR Z, per-field corrections).
    // Both calls are fire-and-forget; they never block save, never throw.
    const original: PredictedFields = {
      player: seededPlayerText,
      year: typeof snapshot.year === "number" ? snapshot.year : (snapshot.year ?? null),
      brand: snapshot.brand ?? null,
      set: snapshot.set ?? null,
      collection: snapshot.collection ?? null,
      cardNumber: snapshot.cardNumber ?? null,
      variant: snapshot.variant ?? null,
      potentialVariant: snapshot.potentialVariant ?? null,
    };
    const editedFields: PredictedFields = {
      player: [edits.playerFirstName, edits.playerLastName].filter(Boolean).join(" "),
      year: edits.year ?? null,
      brand: edits.brand ?? null,
      set: edits.set ?? null,
      collection: edits.collection ?? null,
      cardNumber: edits.cardNumber ?? null,
      variant: edits.variant ?? null,
      potentialVariant: snapshot.potentialVariant ?? null,
    };
    if (computeConfirmationDiff(original, editedFields).length === 0) {
      void logScanConfirmation({
        scanId: `bulk-${item.batchId}-${item.id}`,
        source: "bulk_review",
        predicted: original,
        originalConfidence:
          item.confidenceScore != null ? Number(item.confidenceScore) : null,
      });
    } else {
      void postScanCorrections({
        scanId: `bulk-${item.batchId}-${item.id}`,
        source: "bulk_review",
        original: {
          player: seededPlayerText,
          year: snapshot.year,
          brand: snapshot.brand,
          set: snapshot.set,
          collection: snapshot.collection,
          cardNumber: snapshot.cardNumber,
          parallel: snapshot.variant,
          team: snapshot.team,
          manufacturer: snapshot.manufacturer,
          rookie: !!snapshot.isRookieCard,
          autograph: !!snapshot.isAutographed,
          memorabilia: !!snapshot.isMemorabilia,
          serialNumber: snapshot.serialNumber,
          foilType: snapshot.foilType,
        },
        edited: {
          player,
          year,
          brand,
          set: setName,
          collection,
          cardNumber,
          parallel: variant,
          team: snapshot.team,
          manufacturer: snapshot.manufacturer,
          rookie: isRookieCard,
          autograph: isAutographed,
          memorabilia: snapshot.isMemorabilia,
          serialNumber,
          foilType,
        },
        frontImageUrl: item.frontFileId
          ? `/api/bulk-scan/items/${item.id}/image/front`
          : null,
        backImageUrl: item.backFileId
          ? `/api/bulk-scan/items/${item.id}/image/back`
          : null,
        originalConfidence:
          item.confidenceScore != null ? Number(item.confidenceScore) : null,
      });
    }
    repriceMutation.mutate(edits, {
      onSuccess: (data) => {
        // Pass the fresh mean as estimatedValue so /save writes column P
        // with the same number the user just saw in the preview. Empty
        // pool → 0 so the sheet renders the "No active listings" sentinel
        // (PR E) instead of carrying the stale snapshot price forward.
        const mean = data?.summary?.mean;
        const fresh = typeof mean === "number" && Number.isFinite(mean) ? mean : 0;
        onSave({ ...edits, estimatedValue: fresh });
      },
      onError: () => {
        // Re-price failure already toasted by mutation onError. Don't
        // commit a partial row — leave the dealer in place to retry.
      },
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

      {/* Front + back side-by-side preview — dealers asked for visual
          context next to the editable fields. Pulls via the proxy endpoint
          which authenticates against the user's Drive. Falls back to a
          placeholder div if the file can't be loaded. */}
      <CardImageStrip itemId={item.id} hasFront={!!item.frontFileId} hasBack={!!item.backFileId} />

      {/* Editable fields — mirrors every column written to Google Sheets so
          a dealer can save a fully-shaped row from review without bouncing
          to /add-card. */}
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
          label="Sport"
          value={sport}
          onChange={setSport}
          testId="input-review-sport"
        />
        <EditField
          label="Brand"
          value={brand}
          onChange={setBrand}
          testId="input-review-brand"
        />
        <EditField
          label="Set"
          value={setName}
          onChange={setSetName}
          testId="input-review-set"
        />
        <EditField
          label="Collection"
          value={collection}
          onChange={setCollection}
          testId="input-review-collection"
        />
        <EditField
          label="Card #"
          value={cardNumber}
          onChange={setCardNumber}
          testId="input-review-card-number"
        />
        <EditField
          label="CMP #"
          value={cmpNumber}
          onChange={setCmpNumber}
          testId="input-review-cmp"
        />
        <EditField
          label="Foil"
          value={foilType}
          onChange={setFoilType}
          testId="input-review-foil"
        />
        <EditField
          label="Variation"
          value={variant}
          onChange={setVariant}
          testId="input-review-variant"
        />
        <EditField
          label="Serial #"
          value={serialNumber}
          onChange={setSerialNumber}
          testId="input-review-serial"
        />
        <EditField
          label="Avg. price ($)"
          value={estimatedValue}
          onChange={setEstimatedValue}
          inputMode="numeric"
          testId="input-review-value"
        />
      </div>

      {/* Boolean toggles laid out side-by-side so a dealer can flip them
          quickly during review. Default to whatever the OCR pulled. */}
      <div className="grid grid-cols-3 gap-2">
        <ToggleChip
          label="Rookie"
          on={isRookieCard}
          onChange={setIsRookieCard}
          testId="toggle-review-rookie"
        />
        <ToggleChip
          label="Auto"
          on={isAutographed}
          onChange={setIsAutographed}
          testId="toggle-review-auto"
        />
        <ToggleChip
          label="Numbered"
          on={isNumbered}
          onChange={setIsNumbered}
          testId="toggle-review-numbered"
        />
      </div>

      {/* PR Y: re-price preview readout. Renders only after the dealer
          clicks Analyze & Price so we don't shadow the snapshot price
          the user already sees in the editable Avg Price field. Empty
          pool (count=0) is surfaced explicitly — PR E's sheet sentinel
          will write "No active listings" when this row saves. */}
      {repricedSummary && (
        <div
          className="rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-[12px] text-emerald-900 flex flex-col gap-2"
          data-testid="text-review-reprice-preview"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex items-center gap-2">
              {repricedSummary.summary.count > 0 ? (
                <>
                  <span className="font-semibold">
                    ${(repricedSummary.summary.mean ?? 0).toFixed(2)}
                  </span>{" "}
                  <span className="text-emerald-700">
                    · {repricedSummary.summary.count} listing
                    {repricedSummary.summary.count === 1 ? "" : "s"}
                  </span>
                </>
              ) : (
                <span className="text-emerald-700">No active listings</span>
              )}
              {/* PR AE: Fresh badge — bypassCache=true on this reprice, so
                  for FRESH_BADGE_MS the dealer knows these comps came
                  from a just-now Browse fetch, not the 60s cache. */}
              {freshNow && (
                <span
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-600 text-white"
                  data-testid="badge-reprice-fresh"
                >
                  Fresh
                </span>
              )}
            </div>
            {repricedSummary.ebaySearchUrl && (
              <a
                href={repricedSummary.ebaySearchUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[11px] text-emerald-800 underline shrink-0"
                data-testid="link-review-reprice-ebay"
              >
                View on eBay
              </a>
            )}
          </div>

          {/* PR AE (Bug 3a): per-listing strip — same scored pool that
              drove the mean above. Belt-and-suspenders Graded chip on
              any title that still mentions PSA/BGS/SGC/CGC/graded/
              slabbed (the server-side PICKER_EXCLUSION_CHAIN now
              negates those, but eBay's keyword match is fuzzy). */}
          {Array.isArray(repricedSummary.listings) && repricedSummary.listings.length > 0 && (
            <ul
              className="flex flex-col gap-1 border-t border-emerald-200 pt-2"
              data-testid="list-reprice-listings"
            >
              {repricedSummary.listings.slice(0, 5).map((listing, idx) => {
                const graded = isGradedTitle(listing.title);
                return (
                  <li
                    key={`${listing.url}-${idx}`}
                    className="flex items-center justify-between gap-2 text-[11px]"
                    data-testid={`reprice-listing-${idx}`}
                  >
                    <a
                      href={listing.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="truncate text-emerald-900 hover:underline flex-1 min-w-0"
                      title={listing.title}
                    >
                      {listing.title}
                    </a>
                    {graded && (
                      <span
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800 border border-amber-200 shrink-0"
                        data-testid={`badge-reprice-graded-${idx}`}
                      >
                        Graded
                      </span>
                    )}
                    <span className="font-semibold tabular-nums shrink-0">
                      ${(listing.price ?? 0).toFixed(2)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Actions */}
      {/* PR Y: Save (primary) auto-runs re-price → save in one click using
          the dealer's edited identity. Analyze & Price (secondary) runs
          re-price only and stops at the preview so the dealer can sanity-
          check the new pool before committing. Both share the same
          mutation; the button-level loading state distinguishes which
          path is in flight. */}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || skipping || repriceMutation.isPending}
          className={cn(
            "flex-1 h-11 rounded-xl font-display font-semibold text-sm flex items-center justify-center gap-1.5 transition",
            "bg-foil-violet text-white hover-elevate disabled:opacity-50",
          )}
          data-testid="button-review-save"
        >
          {repriceMutation.isPending && !saving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Re-pricing…
            </>
          ) : saving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              Save to sheet
            </>
          )}
        </button>
        <button
          type="button"
          onClick={handleAnalyze}
          disabled={saving || skipping || repriceMutation.isPending}
          className="h-11 px-3 rounded-xl border border-card-border bg-card text-xs font-medium hover-elevate disabled:opacity-50 flex items-center gap-1.5"
          data-testid="button-review-analyze"
          title="Re-price using current edits (preview only — does not save)"
        >
          {repriceMutation.isPending && !saving ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Analyze & Price
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={saving || skipping || repriceMutation.isPending}
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

function CardImageStrip({
  itemId,
  hasFront,
  hasBack,
}: {
  itemId: number;
  hasFront: boolean;
  hasBack: boolean;
}) {
  if (!hasFront && !hasBack) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      <CardImage
        side="front"
        itemId={itemId}
        present={hasFront}
        testId={`review-image-front-${itemId}`}
      />
      <CardImage
        side="back"
        itemId={itemId}
        present={hasBack}
        testId={`review-image-back-${itemId}`}
      />
    </div>
  );
}

function CardImage({
  side,
  itemId,
  present,
  testId,
}: {
  side: "front" | "back";
  itemId: number;
  present: boolean;
  testId?: string;
}) {
  const [errored, setErrored] = useState(false);
  // Reset error state if the item changes — otherwise the next item's
  // image won't get a chance to load.
  useEffect(() => {
    setErrored(false);
  }, [itemId]);
  return (
    <div
      className="relative aspect-[2/3] rounded-xl bg-muted/50 border border-card-border overflow-hidden"
      data-testid={testId}
    >
      {present && !errored ? (
        <img
          src={`/api/bulk-scan/items/${itemId}/image/${side}`}
          alt={`${side} of card`}
          className="absolute inset-0 w-full h-full object-contain"
          onError={() => setErrored(true)}
          loading="lazy"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-3 text-center">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {side}
          </span>
          {present && errored ? (
            <span className="text-[10px] text-destructive">
              image failed to load
            </span>
          ) : !present ? (
            <span className="text-[10px] text-muted-foreground">
              no file id
            </span>
          ) : null}
        </div>
      )}
      <span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded-md bg-black/60 text-white text-[9px] font-medium uppercase tracking-wide">
        {side}
      </span>
    </div>
  );
}

function ToggleChip({
  label,
  on,
  onChange,
  testId,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={cn(
        "h-9 rounded-xl text-[11px] font-medium border transition",
        on
          ? "bg-foil-violet text-white border-foil-violet"
          : "bg-card text-slate-600 border-card-border hover-elevate",
      )}
      data-testid={testId}
      aria-pressed={on}
    >
      {label}
    </button>
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
