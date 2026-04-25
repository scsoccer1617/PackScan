// Bulk Scan page — /bulk-scan
//
// Entry point for the Holo bulk-scan pipeline. Dealers drop multi-page
// JPEGs/PDFs from their duplex scanner into their configured Drive inbox,
// then tap Sync here. We kick off a batch, poll it while it runs, and show
// a timeline of recent runs with a "Review" hand-off when the confidence
// gate flagged cards for human sign-off.
//
// This page is intentionally thin — the heavy lifting (pairing, OCR,
// confidence gate, Drive moves, sheet append) all lives on the server.

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  ArrowUpFromLine,
  CheckCircle2,
  ChevronRight,
  Clock,
  Folder,
  Loader2,
  AlertTriangle,
  Inbox,
  ListChecks,
  Settings as SettingsIcon,
  Beaker,
  FileSpreadsheet,
  ExternalLink,
  HelpCircle,
  ChevronDown,
  FileQuestion,
  Trash2,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

interface ScanBatch {
  id: number;
  userId: number;
  status: "queued" | "running" | "completed" | "failed";
  sourceFolderId: string | null;
  processedFolderId: string | null;
  fileCount: number;
  processedCount: number;
  reviewQueueCount: number;
  errorMessage: string | null;
  dryRun: boolean;
  createdAt: string;
  completedAt: string | null;
}
interface BatchesResponse {
  batches: ScanBatch[];
}
interface FoldersResponse {
  folders: {
    inboxFolderId: string | null;
    processedFolderId: string | null;
  };
  names: { inbox: string | null; processed: string | null };
}
interface UserSheet {
  id: number;
  googleSheetId: string;
  title: string;
  isDefault: boolean;
}
interface SheetsResponse {
  sheets: UserSheet[];
  activeSheetId: number | null;
}

type InboxFileDisposition =
  | "auto_saved_but_not_moved"
  | "review"
  | "skipped"
  | "failed"
  | "pending_or_processing"
  | "wrong_mimetype"
  | "unknown";
interface InboxDiagnosticDetail {
  ocr: {
    playerName: string | null;
    year: number | null;
    brand: string | null;
    cardNumber: string | null;
    collection: string | null;
    set: string | null;
    foilType: string | null;
    ambiguityFlags: string[];
  };
  scp: {
    status: "hit" | "miss" | "threw" | "skipped" | "unknown";
    reason: string | null;
    matchScore: number | null;
    query: Record<string, string | number | null> | null;
    topCandidates: Array<{ productName: string; consoleName: string; score: number }>;
  };
  ocrText: { front: string | null; back: string | null };
}
interface InboxDiagnosticFile {
  fileId: string;
  name: string;
  mimeType: string;
  size: number | null;
  createdTime: string;
  disposition: InboxFileDisposition;
  reason: string | null;
  itemId: number | null;
  batchId: number | null;
  detail: InboxDiagnosticDetail | null;
}
interface InboxDiagnosticResponse {
  inboxFolderId: string;
  totalFiles: number;
  files: InboxDiagnosticFile[];
}

export default function BulkScan() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [dryRun, setDryRun] = useState(false);

  // Folder config (required before Sync can kick off).
  const { data: foldersData } = useQuery<FoldersResponse>({
    queryKey: ["/api/bulk-scan/folders"],
    enabled: !!user,
  });

  // Active sheet — the destination for both auto-saved rows and review
  // saves. Dealers asked to see which sheet they're writing to before
  // kicking off a batch so there's no "wait, where did my cards go?"
  // moment.
  const { data: sheetsData } = useQuery<SheetsResponse>({
    queryKey: ["/api/sheets"],
    enabled: !!user,
  });
  const activeSheet = sheetsData?.sheets.find(
    (s) => s.id === sheetsData.activeSheetId,
  ) ?? null;

  // Recent batches. Poll while any batch is active so the dealer sees
  // live progress without mashing refresh.
  const { data: batchesData, isLoading } = useQuery<BatchesResponse>({
    queryKey: ["/api/bulk-scan/batches"],
    enabled: !!user,
  });

  const batches = batchesData?.batches ?? [];
  const anyActive = useMemo(
    () => batches.some((b) => b.status === "queued" || b.status === "running"),
    [batches],
  );

  // Keep the batch list fresh while something is running. We invalidate the
  // query on a 3s tick — cheap query, and the user expects visible movement.
  useEffect(() => {
    if (!anyActive) return;
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/bulk-scan/batches"] });
    }, 3000);
    return () => clearInterval(interval);
  }, [anyActive]);

  const syncMutation = useMutation({
    mutationFn: async () =>
      apiRequest<{ batch: ScanBatch }>({
        url: "/api/bulk-scan/sync",
        method: "POST",
        body: { dryRun },
      }),
    onSuccess: (data) => {
      toast({
        title: dryRun ? "Dry-run batch started" : "Batch started",
        description: `Holo is processing ${data.batch.fileCount || "your"} scan${
          data.batch.fileCount === 1 ? "" : "s"
        }.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/bulk-scan/batches"] });
    },
    onError: (err: any) => {
      const raw = String(err?.message || "").replace(/^\d+:\s*/, "");
      let msg = raw;
      try {
        msg = JSON.parse(raw).error || raw;
      } catch {}
      toast({ title: "Couldn't start sync", description: msg, variant: "destructive" });
    },
  });

  const inboxConfigured = !!foldersData?.folders.inboxFolderId;
  const googleConnected = !!user?.googleConnected;
  const canSync = googleConnected && inboxConfigured && !syncMutation.isPending;

  if (!user) {
    return (
      <div className="px-4 pt-6 pb-10 text-sm text-muted-foreground">
        Please sign in.
      </div>
    );
  }

  return (
    <div className="pt-4 pb-10 space-y-5">
      {/* Header */}
      <div className="px-4 flex items-start justify-between gap-2">
        <div>
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">
            Bulk scan
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Pull scans from Drive, identify and price cards in one pass.
          </p>
        </div>
        <Link
          href="/bulk-scan/settings"
          className="shrink-0 w-10 h-10 rounded-xl border border-card-border bg-card flex items-center justify-center hover-elevate"
          data-testid="link-bulk-scan-settings"
          aria-label="Bulk scan settings"
        >
          <SettingsIcon className="w-4 h-4 text-slate-600" />
        </Link>
      </div>

      {/* Setup-incomplete banners */}
      {!googleConnected && (
        <SetupBanner
          tone="amber"
          title="Google not connected"
          body="Connect Google so Holo can read your Drive scans and save cards."
          cta={{ label: "Connect", href: "/api/auth/google/connect" }}
          testId="banner-google-missing"
        />
      )}
      {googleConnected && !inboxConfigured && (
        <SetupBanner
          tone="amber"
          title="Pick an inbox folder"
          body="Point Holo at the Drive folder your scanner writes to."
          cta={{ label: "Open settings", href: "/bulk-scan/settings" }}
          testId="banner-inbox-missing"
        />
      )}

      {/* Folder status */}
      {inboxConfigured && (
        <section className="mx-4 rounded-2xl bg-card border border-card-border p-4 space-y-2">
          {/* When the folder name fails to resolve (Drive scope mismatch,
              folder shared from another account, etc.) we fall back to the
              raw id rather than "Loading…" so the dealer can at least see
              something is configured — and the ExternalLink chevron lets
              them tap through to verify the folder in Drive. */}
          <FolderRow
            label="Inbox"
            name={foldersData?.names.inbox || foldersData?.folders.inboxFolderId || "Not set"}
            unresolved={!foldersData?.names.inbox && !!foldersData?.folders.inboxFolderId}
            folderId={foldersData?.folders.inboxFolderId ?? null}
            testId="row-inbox"
          />
          {foldersData?.folders.processedFolderId && (
            <FolderRow
              label="Processed"
              name={foldersData?.names.processed || foldersData?.folders.processedFolderId || "—"}
              unresolved={!foldersData?.names.processed && !!foldersData?.folders.processedFolderId}
              folderId={foldersData?.folders.processedFolderId ?? null}
              testId="row-processed"
            />
          )}
        </section>
      )}

      {/* Destination sheet — where identified cards land. Tapping opens the
          /sheets tab so the dealer can pick a different sheet if needed. */}
      {googleConnected && (
        <section className="mx-4 rounded-2xl bg-card border border-card-border p-4">
          {activeSheet ? (
            <Link
              href="/sheets"
              className="flex items-center gap-3 hover-elevate -mx-4 -my-4 px-4 py-4 rounded-2xl"
              data-testid="link-active-sheet"
            >
              <div className="w-8 h-8 rounded-xl bg-foil-green/15 flex items-center justify-center text-foil-green shrink-0">
                <FileSpreadsheet className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Saving to sheet
                </p>
                <p className="text-sm font-medium truncate">{activeSheet.title}</p>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
            </Link>
          ) : (
            <div className="flex items-center gap-3" data-testid="row-no-sheet">
              <div className="w-8 h-8 rounded-xl bg-foil-amber/15 flex items-center justify-center text-foil-amber shrink-0">
                <AlertTriangle className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">No active sheet</p>
                <p className="text-[11px] text-muted-foreground">
                  Pick a sheet so Holo knows where to save cards.
                </p>
              </div>
              <Link
                href="/sheets"
                className="shrink-0 h-9 px-3 rounded-xl bg-foil-violet text-white text-xs font-medium flex items-center hover-elevate"
              >
                Open
              </Link>
            </div>
          )}
        </section>
      )}

      {/* Sync trigger */}
      <section className="mx-4 rounded-3xl bg-pack text-white p-5 relative overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "radial-gradient(circle at 80% 0%, rgba(139,92,246,0.4), transparent 55%), radial-gradient(circle at 0% 100%, rgba(251,191,36,0.22), transparent 55%)",
          }}
        />
        <div className="relative">
          <p className="font-display text-lg font-semibold leading-tight">
            Ready when you are
          </p>
          <p className="text-xs text-white/70 mt-0.5">
            Holo will pair fronts + backs, identify each card, and add
            high-confidence hits straight to your active sheet.
          </p>

          {/* Dry-run toggle + Sync */}
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDryRun((v) => !v)}
              className={cn(
                "h-10 px-3 rounded-xl text-xs font-medium border flex items-center gap-1.5 transition",
                dryRun
                  ? "bg-white/15 border-white/30 text-white"
                  : "bg-transparent border-white/25 text-white/70",
              )}
              data-testid="button-toggle-dry-run"
              aria-pressed={dryRun}
            >
              <Beaker className="w-3.5 h-3.5" />
              Dry-run
            </button>
            <button
              type="button"
              onClick={() => syncMutation.mutate()}
              disabled={!canSync}
              className={cn(
                "flex-1 h-12 rounded-2xl font-display font-semibold text-sm flex items-center justify-center gap-2 transition",
                canSync
                  ? "bg-foil text-white grade-halo"
                  : "bg-white/20 text-white/50 cursor-not-allowed",
              )}
              data-testid="button-sync"
            >
              {syncMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Starting…
                </>
              ) : (
                <>
                  <ArrowUpFromLine className="w-4 h-4" /> Sync from Drive
                </>
              )}
            </button>
          </div>

          {dryRun && (
            <p className="text-[11px] text-white/70 mt-2">
              Dry-run processes scans but doesn't write to your sheet or move files.
            </p>
          )}
        </div>
      </section>

      {/* Batches */}
      <section className="mx-4 space-y-2">
        <div className="flex items-baseline justify-between px-1">
          <h2 className="font-display text-sm font-semibold tracking-tight text-ink">
            Recent batches
          </h2>
          {anyActive && (
            <span className="text-[11px] text-foil-violet flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Live
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-2">
            <div className="h-20 rounded-2xl bg-muted/40 animate-pulse" />
            <div className="h-20 rounded-2xl bg-muted/30 animate-pulse" />
          </div>
        ) : batches.length === 0 ? (
          <EmptyState configured={inboxConfigured} />
        ) : (
          <div className="space-y-2">
            {batches.map((b) => (
              <BatchCard key={b.id} batch={b} />
            ))}
          </div>
        )}
      </section>

      {/* Inbox diagnostic — lazy-loaded, only when the dealer wants to know
          why files are still sitting in the inbox after a sync. */}
      {inboxConfigured && batches.length > 0 && <InboxDiagnostic />}
    </div>
  );
}

// ── Inbox diagnostic ───────────────────────────────────────────────────
function InboxDiagnostic() {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<InboxDiagnosticResponse>({
    queryKey: ["/api/bulk-scan/inbox-diagnostic"],
    enabled: open,
  });
  return (
    <section className="mx-4 rounded-2xl bg-card border border-card-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 hover-elevate rounded-2xl text-left"
        data-testid="button-toggle-inbox-diagnostic"
        aria-expanded={open}
      >
        <div className="w-8 h-8 rounded-xl bg-muted flex items-center justify-center text-slate-600 shrink-0">
          <HelpCircle className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Why are some files still in the inbox?</p>
          <p className="text-[11px] text-muted-foreground">
            See the disposition of every file in your Drive inbox folder.
          </p>
        </div>
        <ChevronDown
          className={cn(
            "w-4 h-4 text-muted-foreground shrink-0 transition",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="border-t border-card-border px-4 py-3 space-y-2">
          {isLoading ? (
            <div className="space-y-2">
              <div className="h-12 rounded-xl bg-muted/40 animate-pulse" />
              <div className="h-12 rounded-xl bg-muted/30 animate-pulse" />
            </div>
          ) : isError ? (
            <p className="text-xs text-destructive" data-testid="text-inbox-diagnostic-error">
              Couldn't load inbox: {(error as any)?.message || "unknown error"}
            </p>
          ) : !data || data.files.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Inbox is empty — every file moved to processed.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {data.totalFiles} file{data.totalFiles === 1 ? "" : "s"} in inbox
                </p>
                <button
                  type="button"
                  onClick={() => refetch()}
                  disabled={isFetching}
                  className="text-[11px] text-foil-violet hover:underline disabled:opacity-50"
                  data-testid="button-refresh-inbox-diagnostic"
                >
                  {isFetching ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              <ul className="space-y-1.5">
                {data.files.map((f) => (
                  <InboxDiagnosticRow key={f.fileId} file={f} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function InboxDiagnosticRow({ file }: { file: InboxDiagnosticFile }) {
  const { toast } = useToast();
  // Reprocess = drop the scan_batch_items row so the next sync rediscovers
  // and re-pairs this file. Useful after the dealer fixes something
  // upstream (renames the file, edits a Card DB row, etc.) and wants the
  // analyzer to take another pass without manually moving files around.
  // Server blocks auto_saved items with 409 — they already wrote a sheet
  // row and reprocessing would silently double-write.
  const reprocessMutation = useMutation({
    mutationFn: async () => {
      if (file.itemId == null) throw new Error('No item id');
      return apiRequest<{ ok: true }>({
        url: `/api/bulk-scan/items/${file.itemId}/reprocess`,
        method: 'POST',
      });
    },
    onSuccess: () => {
      toast({
        title: 'Queued for reprocessing',
        description: 'Run Sync to pick this file up again.',
      });
      queryClient.invalidateQueries({ queryKey: ['/api/bulk-scan/inbox-diagnostic'] });
      queryClient.invalidateQueries({ queryKey: ['/api/bulk-scan/batches'] });
    },
    onError: (err: any) => {
      const raw = String(err?.message || '').replace(/^\d+:\s*/, '');
      let msg = raw;
      try {
        msg = JSON.parse(raw).message || JSON.parse(raw).error || raw;
      } catch {}
      toast({ title: "Couldn't reprocess", description: msg, variant: 'destructive' });
    },
  });
  // Auto-saved items already wrote a sheet row — server returns 409 if we
  // try, so don't even show the button. wrong_mimetype / unknown rows
  // never had a scan_batch_items row, so file.itemId is null.
  const canReprocess =
    file.itemId != null && file.disposition !== 'auto_saved_but_not_moved';
  const dispLabel: Record<InboxFileDisposition, string> = {
    auto_saved_but_not_moved: "Saved but not moved",
    review: "In review",
    skipped: "Skipped",
    failed: "Analyzer failed",
    pending_or_processing: "Still processing",
    wrong_mimetype: "Wrong file type",
    unknown: "Not seen by sync",
  };
  const dispTone: Record<InboxFileDisposition, string> = {
    auto_saved_but_not_moved: "bg-foil-amber/15 text-foil-amber",
    review: "bg-foil-violet/15 text-foil-violet",
    skipped: "bg-muted text-muted-foreground",
    failed: "bg-destructive/15 text-destructive",
    pending_or_processing: "bg-foil-amber/15 text-foil-amber",
    wrong_mimetype: "bg-destructive/15 text-destructive",
    unknown: "bg-muted text-muted-foreground",
  };
  // Only items the analyzer actually processed have a detail payload —
  // wrong_mimetype / unknown files were never read, so there's nothing to
  // expand and we render the original compact row.
  const hasDetail = !!file.detail;
  const [expanded, setExpanded] = useState(false);
  return (
    <li
      className="rounded-xl border border-card-border bg-background"
      data-testid={`row-inbox-file-${file.fileId}`}
    >
      <div className="px-3 py-2 flex items-start gap-2">
        <FileQuestion className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs font-medium truncate max-w-[220px]" title={file.name}>
              {file.name}
            </p>
            <span
              className={cn(
                "inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-medium",
                dispTone[file.disposition],
              )}
              data-testid={`badge-disposition-${file.fileId}`}
            >
              {dispLabel[file.disposition]}
            </span>
          </div>
          {file.reason && (
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {file.reason}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {canReprocess && (
            <button
              type="button"
              onClick={() => reprocessMutation.mutate()}
              disabled={reprocessMutation.isPending}
              className="text-[10px] font-medium text-muted-foreground hover:text-foreground hover-elevate px-1.5 py-0.5 rounded-md disabled:opacity-50 disabled:pointer-events-none"
              data-testid={`button-reprocess-${file.fileId}`}
              title="Drop this row so the next Sync rediscovers and re-analyzes the file."
            >
              {reprocessMutation.isPending ? 'Queuing\u2026' : 'Reprocess'}
            </button>
          )}
          {hasDetail && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-[10px] font-medium text-muted-foreground hover:text-foreground hover-elevate px-1.5 py-0.5 rounded-md flex items-center gap-1"
              data-testid={`button-toggle-detail-${file.fileId}`}
              aria-expanded={expanded}
            >
              {expanded ? "Hide" : "Why?"}
              <ChevronDown
                className={cn(
                  "w-3 h-3 transition-transform",
                  expanded ? "rotate-180" : "rotate-0",
                )}
              />
            </button>
          )}
        </div>
      </div>
      {hasDetail && expanded && file.detail && (
        <InboxDiagnosticDetailPanel
          detail={file.detail}
          fileId={file.fileId}
        />
      )}
    </li>
  );
}

// Human-readable label for each ambiguity flag the confidence gate
// surfaces. Mirrors server/bulkScan/confidenceGate.ts — if a new flag
// is added there, add it here so the dealer sees a friendly label
// instead of the raw snake_case key.
const AMBIGUITY_FLAG_LABELS: Record<string, string> = {
  card_number_low_confidence:
    "Card # was hard to read or missing — OCR couldn't lock onto a clear value.",
  variation_ambiguous:
    "Card DB had multiple parallel/variation rows for this brand+year+#; the gate can't pick one.",
  collection_ambiguous:
    "Card DB had multiple collections for this brand+year+#; the gate can't pick one.",
  year_from_back_only:
    "Year came from the back of the card only — weaker signal than a front-of-card year.",
  year_from_copyright:
    "Year was inferred from a copyright line, which can be a year off from the card year.",
  year_from_bare_fallback:
    "Year was a bare 4-digit fallback — lowest-confidence year extraction.",
};

// Human-readable label for each SCP miss reason. The reason strings are
// the canonical CatalogMissReason union from server/sportscardspro.
const SCP_REASON_LABELS: Record<string, string> = {
  no_query:
    "No query was built — the OCR-extracted fields were too sparse to even ask SCP.",
  no_results:
    "SCP returned zero candidates for this query — the player+year+brand combination isn't in their catalog.",
  below_threshold:
    "SCP returned candidates but none scored high enough to be a confident match.",
  api_error:
    "SCP's API errored or timed out — the lookup never produced a clean answer.",
  not_configured:
    "SCP integration isn't configured (missing API token) — SCP-first was skipped.",
};

function InboxDiagnosticDetailPanel({
  detail,
  fileId,
}: {
  detail: InboxDiagnosticDetail;
  fileId: string;
}) {
  const ocrFields: Array<{ label: string; value: string | number | null }> = [
    { label: "Player", value: detail.ocr.playerName },
    { label: "Year", value: detail.ocr.year },
    { label: "Brand", value: detail.ocr.brand },
    { label: "Card #", value: detail.ocr.cardNumber },
    { label: "Collection", value: detail.ocr.collection },
    { label: "Set", value: detail.ocr.set },
    { label: "Foil", value: detail.ocr.foilType },
  ];
  const scpStatusLabel: Record<InboxDiagnosticDetail["scp"]["status"], string> = {
    hit: "Hit",
    miss: "Miss",
    threw: "Threw",
    skipped: "Skipped",
    unknown: "Unknown",
  };
  const scpStatusTone: Record<InboxDiagnosticDetail["scp"]["status"], string> = {
    hit: "bg-foil-emerald/15 text-foil-emerald",
    miss: "bg-foil-amber/15 text-foil-amber",
    threw: "bg-destructive/15 text-destructive",
    skipped: "bg-muted text-muted-foreground",
    unknown: "bg-muted text-muted-foreground",
  };
  // Pretty-print the SCP miss reason. The server may have wrapped an
  // api_error message into the reason like "api_error: <msg>"; in that
  // case show the canonical label and append the message.
  let scpReasonText: string | null = null;
  if (detail.scp.reason) {
    const [base, ...rest] = detail.scp.reason.split(":");
    const label = SCP_REASON_LABELS[base.trim()] ?? null;
    const tail = rest.join(":").trim();
    scpReasonText = label ? (tail ? `${label} (${tail})` : label) : detail.scp.reason;
  }
  return (
    <div
      className="border-t border-card-border bg-muted/30 px-3 py-3 space-y-3"
      data-testid={`detail-panel-${fileId}`}
    >
      {/* OCR-extracted fields */}
      <div>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
          What OCR extracted
        </p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          {ocrFields.map((f) => (
            <div key={f.label} className="flex items-baseline gap-1.5 min-w-0">
              <dt className="text-[10px] text-muted-foreground shrink-0">{f.label}:</dt>
              <dd
                className={cn(
                  "text-[11px] font-medium truncate",
                  f.value == null || f.value === "" ? "text-muted-foreground italic" : "",
                )}
                title={f.value == null ? "none" : String(f.value)}
              >
                {f.value == null || f.value === "" ? "none" : String(f.value)}
              </dd>
            </div>
          ))}
        </dl>
        {detail.ocr.ambiguityFlags.length > 0 && (
          <ul className="mt-2 space-y-1">
            {detail.ocr.ambiguityFlags.map((flag) => (
              <li
                key={flag}
                className="text-[11px] text-foil-amber flex items-start gap-1.5"
                data-testid={`flag-${fileId}-${flag}`}
              >
                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                <span>{AMBIGUITY_FLAG_LABELS[flag] ?? flag}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* SCP probe outcome */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            SportsCardsPro lookup
          </p>
          <span
            className={cn(
              "inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-medium",
              scpStatusTone[detail.scp.status],
            )}
            data-testid={`scp-status-${fileId}`}
          >
            {scpStatusLabel[detail.scp.status]}
            {detail.scp.matchScore != null
              ? ` · score ${detail.scp.matchScore.toFixed(0)}`
              : ""}
          </span>
        </div>
        {detail.scp.query && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 mb-1.5">
            {([
              ["Player", detail.scp.query.playerName],
              ["Year", detail.scp.query.year],
              ["Brand", detail.scp.query.brand],
              ["Card #", detail.scp.query.cardNumber],
              ["Parallel", detail.scp.query.parallel],
              ["Set", detail.scp.query.setName],
            ] as Array<[string, string | number | null | undefined]>).map(
              ([label, value]) => (
                <div key={label} className="flex items-baseline gap-1.5 min-w-0">
                  <dt className="text-[10px] text-muted-foreground shrink-0">
                    {label}:
                  </dt>
                  <dd
                    className={cn(
                      "text-[11px] font-medium truncate",
                      value == null || value === "" ? "text-muted-foreground italic" : "",
                    )}
                    title={value == null ? "none" : String(value)}
                  >
                    {value == null || value === "" ? "none" : String(value)}
                  </dd>
                </div>
              ),
            )}
          </dl>
        )}
        {scpReasonText && (
          <p className="text-[11px] text-muted-foreground">{scpReasonText}</p>
        )}
        {detail.scp.topCandidates.length > 0 && (
          <div className="mt-1.5">
            <p className="text-[10px] text-muted-foreground mb-1">
              Top below-threshold candidates:
            </p>
            <ul className="space-y-1">
              {detail.scp.topCandidates.map((c, i) => (
                <li
                  key={`${c.productName}-${i}`}
                  className="text-[11px] flex items-start gap-1.5 min-w-0"
                  data-testid={`scp-candidate-${fileId}-${i}`}
                >
                  <span className="text-foil-amber font-mono shrink-0">
                    {c.score.toFixed(0)}
                  </span>
                  <span className="truncate" title={`${c.productName} — ${c.consoleName}`}>
                    {c.productName}
                    <span className="text-muted-foreground">
                      {" — "}
                      {c.consoleName}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Raw OCR text — collapsed by default within the panel since it's
          long. We show first ~300 chars per side as a quick sanity check
          and let the dealer expand for the full read. */}
      {(detail.ocrText.front || detail.ocrText.back) && (
        <RawOcrTextSection ocrText={detail.ocrText} fileId={fileId} />
      )}
    </div>
  );
}

function RawOcrTextSection({
  ocrText,
  fileId,
}: {
  ocrText: { front: string | null; back: string | null };
  fileId: string;
}) {
  const [showFull, setShowFull] = useState(false);
  const PREVIEW_CHARS = 240;
  const renderSide = (label: string, text: string | null) => {
    if (!text) {
      return (
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
            {label}
          </p>
          <p className="text-[11px] text-muted-foreground italic">No text</p>
        </div>
      );
    }
    const truncated = !showFull && text.length > PREVIEW_CHARS;
    const display = truncated ? text.slice(0, PREVIEW_CHARS) + "…" : text;
    return (
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
          {label}
        </p>
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-words bg-background border border-card-border rounded-md p-2 max-h-48 overflow-y-auto">
          {display}
        </pre>
      </div>
    );
  };
  const longEnough =
    (ocrText.front?.length ?? 0) > PREVIEW_CHARS ||
    (ocrText.back?.length ?? 0) > PREVIEW_CHARS;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Raw OCR text
        </p>
        {longEnough && (
          <button
            type="button"
            onClick={() => setShowFull((v) => !v)}
            className="text-[10px] text-muted-foreground hover:text-foreground hover-elevate px-1 py-0.5 rounded-md"
            data-testid={`button-toggle-ocr-text-${fileId}`}
          >
            {showFull ? "Show less" : "Show full"}
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {renderSide("Front", ocrText.front)}
        {renderSide("Back", ocrText.back)}
      </div>
    </div>
  );
}

// ── Components ────────────────────────────────────────────────────────────

function FolderRow({
  label,
  name,
  folderId,
  unresolved,
  testId,
}: {
  label: string;
  name: string;
  folderId: string | null;
  unresolved?: boolean;
  testId?: string;
}) {
  const content = (
    <>
      <div className="w-8 h-8 rounded-xl bg-muted flex items-center justify-center text-slate-600 shrink-0">
        <Folder className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className={`text-sm font-medium truncate ${unresolved ? "font-mono text-[12px] text-foil-amber" : ""}`}>
          {name}
        </p>
        {unresolved && (
          <p className="text-[10px] text-foil-amber/80 mt-0.5">
            Reconnect Google to grant Drive access
          </p>
        )}
      </div>
      {folderId && (
        <ExternalLink className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      )}
    </>
  );
  if (folderId) {
    return (
      <a
        href={`https://drive.google.com/drive/folders/${folderId}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 hover-elevate -mx-2 -my-1 px-2 py-1 rounded-lg"
        data-testid={testId}
      >
        {content}
      </a>
    );
  }
  return (
    <div className="flex items-center gap-3" data-testid={testId}>
      {content}
    </div>
  );
}

function BatchCard({ batch }: { batch: ScanBatch }) {
  const { toast } = useToast();
  const created = formatRelative(batch.createdAt);
  const statusMeta = STATUS_META[batch.status];
  const hasReview = batch.reviewQueueCount > 0;
  // Server blocks deletion while running so the worker doesn't update
  // rows that just got dropped underneath it. Hide the button entirely
  // for those rather than render a guaranteed-409 click target.
  const canDelete = batch.status !== 'running';
  const deleteMutation = useMutation({
    mutationFn: async () =>
      apiRequest<{ ok: true }>({
        url: `/api/bulk-scan/batches/${batch.id}`,
        method: 'DELETE',
      }),
    onSuccess: () => {
      toast({
        title: `Batch #${batch.id} deleted`,
        description: 'Drive files and sheet rows were not touched.',
      });
      queryClient.invalidateQueries({ queryKey: ['/api/bulk-scan/batches'] });
      queryClient.invalidateQueries({ queryKey: ['/api/bulk-scan/inbox-diagnostic'] });
    },
    onError: (err: any) => {
      const raw = String(err?.message || '').replace(/^\d+:\s*/, '');
      let msg = raw;
      try {
        msg = JSON.parse(raw).message || JSON.parse(raw).error || raw;
      } catch {}
      toast({ title: "Couldn't delete batch", description: msg, variant: 'destructive' });
    },
  });
  const handleDelete = (e: React.MouseEvent) => {
    // The whole card is a <Link> so any click bubbles up to navigation;
    // the delete button needs to short-circuit both the link and any
    // accidental hover-elevate parent handlers.
    e.preventDefault();
    e.stopPropagation();
    const warn =
      batch.processedCount > 0
        ? " Any cards already saved to your sheet will stay there \u2014 delete those rows manually if you want a true reset."
        : '';
    const ok = window.confirm(
      `Delete batch #${batch.id}? This removes the batch and its review queue from Holo.${warn}`,
    );
    if (!ok) return;
    deleteMutation.mutate();
  };

  return (
    <Link
      href={`/bulk-scan/batches/${batch.id}`}
      className="block rounded-2xl bg-card border border-card-border p-4 hover-elevate"
      data-testid={`card-batch-${batch.id}`}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "w-10 h-10 rounded-xl flex items-center justify-center shrink-0",
            statusMeta.bubbleClass,
          )}
        >
          {statusMeta.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-display text-sm font-semibold text-ink">
              Batch #{batch.id}
            </p>
            <span
              className={cn(
                "text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border",
                statusMeta.chipClass,
              )}
            >
              {statusMeta.label}
            </span>
            {batch.dryRun && (
              <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border border-foil-violet/30 bg-foil-violet/10 text-foil-violet">
                Dry-run
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">{created}</p>
          <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
            <Counter label="Files" value={batch.fileCount} />
            <Counter label="Processed" value={batch.processedCount} />
            <Counter
              label="Review"
              value={batch.reviewQueueCount}
              tone={hasReview ? "violet" : "neutral"}
            />
          </div>
          {batch.status === "failed" && batch.errorMessage && (
            <p className="mt-2 text-[11px] text-foil-red bg-foil-red/5 border border-foil-red/20 rounded-lg px-2 py-1">
              {batch.errorMessage}
            </p>
          )}
          {hasReview && batch.status !== "queued" && (
            <div className="mt-2 text-[11px] text-foil-violet font-medium flex items-center gap-1">
              <ListChecks className="w-3 h-3" /> {batch.reviewQueueCount} to
              review
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <ChevronRight className="w-4 h-4 text-muted-foreground mt-1" />
          {canDelete && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="text-muted-foreground hover:text-destructive hover-elevate p-1.5 rounded-md disabled:opacity-50"
              data-testid={`button-delete-batch-${batch.id}`}
              aria-label={`Delete batch #${batch.id}`}
              title="Delete this batch"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
            </button>
          )}
        </div>
      </div>
    </Link>
  );
}

function Counter({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "violet";
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-card-border px-2 py-1",
        tone === "violet" && value > 0 && "bg-foil-violet/5 border-foil-violet/20",
      )}
    >
      <p
        className={cn(
          "font-display text-sm font-semibold leading-none",
          tone === "violet" && value > 0 && "text-foil-violet",
        )}
      >
        {value}
      </p>
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground mt-0.5">
        {label}
      </p>
    </div>
  );
}

function EmptyState({ configured }: { configured: boolean }) {
  return (
    <div className="rounded-2xl border border-dashed border-card-border bg-muted/20 p-6 text-center">
      <div className="w-10 h-10 rounded-xl bg-muted mx-auto flex items-center justify-center text-slate-500">
        <Inbox className="w-5 h-5" />
      </div>
      <p className="mt-2 text-sm font-medium text-ink">No batches yet</p>
      <p className="text-[12px] text-slate-500 mt-1 max-w-xs mx-auto">
        {configured
          ? "Drop a stack into your inbox folder and tap Sync."
          : "Set your inbox folder in settings to run your first batch."}
      </p>
    </div>
  );
}

function SetupBanner({
  tone,
  title,
  body,
  cta,
  testId,
}: {
  tone: "amber" | "violet";
  title: string;
  body: string;
  cta: { label: string; href: string };
  testId?: string;
}) {
  const toneClass =
    tone === "amber"
      ? "bg-foil-amber/10 border-foil-amber/25 text-foil-amber"
      : "bg-foil-violet/10 border-foil-violet/25 text-foil-violet";
  return (
    <section
      className="mx-4 rounded-2xl bg-card border border-card-border p-4 flex items-center gap-3"
      data-testid={testId}
    >
      <div
        className={cn(
          "w-9 h-9 rounded-xl flex items-center justify-center",
          toneClass,
        )}
      >
        <AlertTriangle className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-[11px] text-muted-foreground">{body}</p>
      </div>
      <a
        href={cta.href}
        className="shrink-0 h-9 px-3 rounded-xl bg-foil-violet text-white text-xs font-medium flex items-center hover-elevate"
      >
        {cta.label}
      </a>
    </section>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

const STATUS_META: Record<
  ScanBatch["status"],
  { label: string; icon: JSX.Element; bubbleClass: string; chipClass: string }
> = {
  queued: {
    label: "Queued",
    icon: <Clock className="w-5 h-5" />,
    bubbleClass: "bg-muted text-slate-500",
    chipClass: "border-slate-200 bg-slate-50 text-slate-600",
  },
  running: {
    label: "Running",
    icon: <Loader2 className="w-5 h-5 animate-spin" />,
    bubbleClass: "bg-foil-violet/10 text-foil-violet",
    chipClass: "border-foil-violet/30 bg-foil-violet/10 text-foil-violet",
  },
  completed: {
    label: "Done",
    icon: <CheckCircle2 className="w-5 h-5" />,
    bubbleClass: "bg-foil-green/10 text-foil-green",
    chipClass: "border-foil-green/30 bg-foil-green/10 text-foil-green",
  },
  failed: {
    label: "Failed",
    icon: <AlertTriangle className="w-5 h-5" />,
    bubbleClass: "bg-foil-red/10 text-foil-red",
    chipClass: "border-foil-red/30 bg-foil-red/10 text-foil-red",
  },
};

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
