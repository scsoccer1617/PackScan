// Bulk Scan settings — /bulk-scan/settings
//
// Per-user configuration for the Holo bulk-scan pipeline. Dealers point us
// at two Google Drive folders:
//
//   Inbox      — where their duplex scanner drops multi-page JPEG/PDF
//                scans. Any scanner that saves to Drive works.
//   Processed  — where the pipeline moves files after a pair is identified
//                and appended to the active Google Sheet.
//
// Review items stay in the inbox (not auto-moved) so the dealer can open
// them during review. After review the review/save endpoint flags the
// item processed — it's up to the dealer to tidy up residual review
// scans however they like.
//
// Folder IDs come from the Drive URL: .../folders/<id>. We accept a
// pasted URL or a raw ID and extract the ID server-side? No — keep it
// simple: extract client-side so we can preview and warn if the paste
// is obviously wrong before sending.

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { FolderOpen, Check, AlertTriangle, ExternalLink, Loader2, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

interface FoldersResponse {
  folders: {
    inboxFolderId: string | null;
    processedFolderId: string | null;
  };
  names: { inbox: string | null; processed: string | null };
}

/** Pull a folder id out of a Drive URL, or return the raw input if it already
 *  looks like an id. */
function extractFolderId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // URL forms: drive.google.com/drive/folders/<id>, drive.google.com/drive/u/0/folders/<id>
  const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // Already an id (Drive IDs are 20+ URL-safe chars).
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return trimmed; // Return as-is; the server will reject if invalid.
}

export default function BulkScanSettings() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const { data, isLoading } = useQuery<FoldersResponse>({
    queryKey: ["/api/bulk-scan/folders"],
    enabled: !!user,
  });

  const [inbox, setInbox] = useState("");
  const [processed, setProcessed] = useState("");
  // Persist the most recent error so a slow network or server 500 stays
  // visible on the page instead of flashing through a toast that's easy
  // to miss. Cleared on the next save attempt.
  const [saveError, setSaveError] = useState<string | null>(null);

  // Hydrate the inputs once data arrives. Only seed empty inputs so edits in
  // flight aren't clobbered by a background refetch. Re-open the page and we
  // want the saved ID visible, so we seed whenever the input is empty.
  useEffect(() => {
    if (!data) return;
    setInbox((prev) => (prev ? prev : data.folders.inboxFolderId ?? ""));
    setProcessed((prev) => (prev ? prev : data.folders.processedFolderId ?? ""));
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      setSaveError(null);
      const payload = {
        inboxFolderId: inbox ? extractFolderId(inbox) : null,
        processedFolderId: processed ? extractFolderId(processed) : null,
      };
      return apiRequest<FoldersResponse>({
        url: "/api/bulk-scan/folders",
        method: "PUT",
        body: payload,
      });
    },
    onSuccess: (resp) => {
      // Prime the cache with the server response so /bulk-scan sees the
      // saved folders instantly (including the human-readable names) — no
      // refetch race on the landing page.
      if (resp && resp.folders) {
        queryClient.setQueryData(["/api/bulk-scan/folders"], {
          folders: {
            inboxFolderId: resp.folders.inboxFolderId ?? null,
            processedFolderId: resp.folders.processedFolderId ?? null,
          },
          names: resp.names ?? { inbox: null, processed: null },
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/bulk-scan/folders"] });
      toast({ title: "Folders saved" });
      // Bounce back to /bulk-scan once the save succeeds — dealers want
      // to hit Sync next, not stay on the config screen.
      setLocation("/bulk-scan");
    },
    onError: (err: any) => {
      const raw = String(err?.message || "").replace(/^\d+:\s*/, "");
      // Server routes return JSON like `{ error: "..." }` — unwrap so the
      // inline banner shows the real reason (missing table, missing inbox,
      // Drive auth expired, etc.) instead of a raw JSON string.
      let msg = raw;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.error === "string") msg = parsed.error;
      } catch {}
      setSaveError(msg || "Unknown error");
      toast({ title: "Couldn't save folders", description: msg, variant: "destructive" });
    },
  });

  const googleConnected = !!user?.googleConnected;

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
      <div className="px-4">
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">
          Bulk scan folders
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Point Holo at the Drive folders your duplex scanner writes to.
        </p>
      </div>

      {/* Google connection status */}
      {!googleConnected ? (
        <section className="mx-4 rounded-2xl bg-card border border-card-border p-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-foil-amber/15 flex items-center justify-center text-foil-amber">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Google not connected</p>
            <p className="text-[11px] text-muted-foreground">
              Connect Google so Holo can read scans and move them when done.
            </p>
          </div>
          <a
            href="/api/auth/google/connect"
            className="shrink-0 h-9 px-3 rounded-xl bg-foil-violet text-white text-xs font-medium flex items-center hover-elevate"
            data-testid="link-connect-google"
          >
            Connect
          </a>
        </section>
      ) : (
        <section className="mx-4 rounded-2xl bg-card border border-card-border p-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-foil-green/15 flex items-center justify-center text-foil-green">
            <Check className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Google connected</p>
            <p className="text-[11px] text-muted-foreground truncate">
              Holo will read scans from Drive and log cards to your active sheet.
            </p>
          </div>
        </section>
      )}

      {/* How it works — short primer */}
      <section className="mx-4 rounded-2xl bg-muted/40 border border-card-border p-4 text-[12px] text-slate-600 space-y-1.5">
        <p className="font-medium text-ink text-sm">How Holo bulk scan works</p>
        <p>
          <span className="font-medium text-ink">1.</span> Scan a stack with your duplex
          scanner; save the multi-page JPEG or PDF to the inbox folder below.
        </p>
        <p>
          <span className="font-medium text-ink">2.</span> Tap <em>Sync</em> on
          the Bulk Scan page. Holo pairs fronts + backs, identifies each card,
          and adds high-confidence hits straight to your active sheet.
        </p>
        <p>
          <span className="font-medium text-ink">3.</span> Anything the model
          isn't sure about lands in a short review queue — confirm or skip.
        </p>
      </section>

      {/* Inputs */}
      <section className="mx-4 space-y-4">
        <FolderInput
          label="Inbox folder"
          sub="Where your scanner saves new scans."
          value={inbox}
          onChange={setInbox}
          currentName={data?.names.inbox ?? null}
          savedId={data?.folders.inboxFolderId ?? null}
          loading={isLoading}
          testId="input-inbox-folder"
        />
        <FolderInput
          label="Processed folder"
          sub="Holo moves scans here after they're saved to your sheet."
          value={processed}
          onChange={setProcessed}
          currentName={data?.names.processed ?? null}
          savedId={data?.folders.processedFolderId ?? null}
          loading={isLoading}
          testId="input-processed-folder"
          optional
        />
      </section>

      {/* Error banner — stays visible so the user isn't relying on a
          ~3s toast to notice that save failed. Covers the common causes:
          DB tables not migrated yet, Drive auth expired, missing inbox. */}
      {saveError && (
        <section className="mx-4 rounded-2xl bg-foil-red/5 border border-foil-red/25 p-4 flex items-start gap-3" data-testid="banner-save-error">
          <div className="w-9 h-9 rounded-xl bg-foil-red/15 text-foil-red flex items-center justify-center shrink-0">
            <XCircle className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foil-red">Couldn't save folders</p>
            <p className="text-[12px] text-slate-700 mt-0.5 break-words">{saveError}</p>
            {/relation.*does not exist|scan_batches|google_drive_folders/i.test(saveError) && (
              <p className="text-[11px] text-slate-600 mt-2">
                The bulk-scan tables haven't been created yet. Run{" "}
                <span className="font-mono bg-muted px-1 rounded">npm run db:push</span>{" "}
                on the server once, then try again.
              </p>
            )}
          </div>
        </section>
      )}

      {/* Save */}
      <section className="px-4 pt-1">
        <button
          type="button"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || !googleConnected}
          className={cn(
            "w-full h-12 rounded-2xl font-display font-semibold text-sm flex items-center justify-center gap-2 transition",
            !saveMutation.isPending && googleConnected
              ? "bg-foil-violet text-white hover-elevate"
              : "bg-slate-100 text-slate-400 cursor-not-allowed",
          )}
          data-testid="button-save-folders"
        >
          {saveMutation.isPending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> Saving…
            </>
          ) : (
            "Save folders"
          )}
        </button>
        <p className="text-[11px] text-slate-500 text-center mt-2">
          You can update these any time — we only read the folder you pick.
        </p>
      </section>
    </div>
  );
}

function FolderInput({
  label,
  sub,
  value,
  onChange,
  currentName,
  savedId,
  loading,
  testId,
  optional,
}: {
  label: string;
  sub: string;
  value: string;
  onChange: (v: string) => void;
  currentName: string | null;
  savedId: string | null;
  loading?: boolean;
  testId?: string;
  optional?: boolean;
}) {
  const extracted = value ? extractFolderId(value) : "";
  const showPreview = !!extracted && extracted !== value.trim();
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <label className="text-[11px] text-muted-foreground uppercase tracking-wide">
          {label} {optional && <span className="normal-case tracking-normal text-muted-foreground/70">(optional)</span>}
        </label>
        {currentName && !loading && (
          <span className="text-[11px] text-foil-green flex items-center gap-1">
            <FolderOpen className="w-3 h-3" /> {currentName}
          </span>
        )}
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste the Drive folder URL or ID"
        className="w-full h-11 rounded-xl bg-background border border-card-border px-3 text-sm outline-none focus:ring-2 focus:ring-foil-violet/30"
        data-testid={testId}
        autoComplete="off"
        spellCheck={false}
      />
      <p className="text-[11px] text-slate-500 mt-1">{sub}</p>
      {/* Show the saved id on the server regardless of the current input
          value — this makes "is this folder actually persisted?" obvious at
          a glance, and prevents the "I saved it but it didn't stick" panic
          when a dealer reopens the page. */}
      {savedId && (
        <p className="text-[11px] text-foil-green mt-1 flex items-center gap-1 font-mono" data-testid={`${testId}-saved`}>
          <Check className="w-3 h-3" /> Saved: <span className="truncate">{savedId}</span>
        </p>
      )}
      {showPreview && extracted !== savedId && (
        <p className="text-[11px] text-slate-600 mt-1 flex items-center gap-1 font-mono">
          <ExternalLink className="w-3 h-3" /> Folder ID: <span className="truncate">{extracted}</span>
        </p>
      )}
    </div>
  );
}
