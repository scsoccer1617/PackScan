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
          <FolderRow
            label="Inbox"
            name={foldersData?.names.inbox || "Loading…"}
            folderId={foldersData?.folders.inboxFolderId ?? null}
            testId="row-inbox"
          />
          {foldersData?.folders.processedFolderId && (
            <FolderRow
              label="Processed"
              name={foldersData?.names.processed || "—"}
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
    </div>
  );
}

// ── Components ────────────────────────────────────────────────────────────

function FolderRow({
  label,
  name,
  folderId,
  testId,
}: {
  label: string;
  name: string;
  folderId: string | null;
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
        <p className="text-sm font-medium truncate">{name}</p>
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
  const created = formatRelative(batch.createdAt);
  const statusMeta = STATUS_META[batch.status];
  const hasReview = batch.reviewQueueCount > 0;

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
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-1" />
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
