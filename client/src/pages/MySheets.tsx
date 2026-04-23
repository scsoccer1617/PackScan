import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  FileSpreadsheet,
  Plus,
  ExternalLink,
  RefreshCw,
  Check,
  Star,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

/**
 * Redesigned MySheets page.
 *
 * Visual direction follows the redesign prototype (packscan-redesign/Sheets):
 *   - Header with subtitle explaining the "you own the data" value prop.
 *   - Connection status card (Google connected chip with user email).
 *   - Sheets list with sheet-icon tile, name, meta, star (set active),
 *     open-in-Google, rename, unlink.
 *   - Inline "New sheet" composer that appears when the user taps +.
 *   - Empty state that invites first sheet creation.
 *
 * Data stays on the existing endpoints — no backend changes required.
 *
 *   GET    /api/sheets                  -> { sheets, activeSheetId }
 *   POST   /api/sheets                  -> create new sheet
 *   POST   /api/sheets/:id/active       -> set active sheet
 *   PATCH  /api/sheets/:id              -> rename
 *   DELETE /api/sheets/:id              -> unlink
 *
 * Note: cards are not tracked per-sheet (all cards write to the active
 * sheet), so we show "Active" + card count only on the active sheet,
 * and a neutral "Linked" label on others.
 */

interface Sheet {
  id: number;
  userId: number;
  googleSheetId: string;
  title: string;
  isDefault: boolean;
  createdAt: string;
}
interface SheetsResponse { sheets: Sheet[]; activeSheetId: number | null; }
type CollectionSummary = { cardCount: number; totalValue: number };

export default function MySheets() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const { data, isLoading } = useQuery<SheetsResponse>({
    queryKey: ["/api/sheets"],
    enabled: !!user,
  });

  const { data: summary } = useQuery<CollectionSummary>({
    queryKey: ["/api/collection/summary"],
    enabled: !!user,
  });

  const createMutation = useMutation({
    mutationFn: async (title: string) =>
      apiRequest({ url: "/api/sheets", method: "POST", body: JSON.stringify({ title }) }),
    onSuccess: () => {
      setNewTitle("");
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ["/api/sheets"] });
      toast({ title: "Sheet created" });
    },
    onError: (err: any) => {
      const msg = String(err?.message || "").replace(/^\d+:\s*/, "");
      let parsed = msg;
      try { parsed = JSON.parse(msg).error || msg; } catch {}
      if (parsed.includes("Connect Google")) {
        toast({ title: "Google not connected", description: "Connect Google to create sheets.", variant: "destructive" });
      } else {
        toast({ title: "Failed to create sheet", description: parsed, variant: "destructive" });
      }
    },
  });

  const setActive = useMutation({
    mutationFn: async (id: number) => apiRequest({ url: `/api/sheets/${id}/active`, method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sheets"] });
      toast({ title: "Active sheet changed" });
    },
  });

  const renameSheet = useMutation({
    mutationFn: async ({ id, title }: { id: number; title: string }) =>
      apiRequest({ url: `/api/sheets/${id}`, method: "PATCH", body: JSON.stringify({ title }) }),
    onSuccess: () => {
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/sheets"] });
    },
  });

  const unlinkSheet = useMutation({
    mutationFn: async (id: number) => apiRequest({ url: `/api/sheets/${id}`, method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sheets"] });
      toast({ title: "Sheet unlinked" });
    },
  });

  if (!user) {
    return (
      <div className="px-4 pt-6 pb-10 text-sm text-muted-foreground">
        Please sign in to manage your sheets.
      </div>
    );
  }

  const sheets = data?.sheets || [];
  const activeId = data?.activeSheetId ?? null;
  const needsGoogle = !user.googleConnected;

  return (
    <div className="pt-4 pb-10 space-y-4">
      {/* Header */}
      <div className="px-4">
        <h1 className="font-display text-[22px] font-semibold tracking-tight">My Sheets</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Every card backed up to your own spreadsheet. You own the data.
        </p>
      </div>

      {/* Connection status */}
      <ConnectionCard user={user} needsGoogle={needsGoogle} />

      {/* Sheets list */}
      <section className="px-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Your sheets</h2>
          {!needsGoogle && !creating && (
            <button
              className="text-xs text-foil-violet font-medium flex items-center gap-1 h-8 px-2 rounded-lg hover-elevate"
              onClick={() => setCreating(true)}
              data-testid="button-new-sheet"
            >
              <Plus className="w-3.5 h-3.5" /> New sheet
            </button>
          )}
        </div>

        {/* Inline composer */}
        {creating && (
          <div className="mb-2 rounded-2xl bg-card border border-card-border p-3">
            <label className="text-[11px] text-muted-foreground uppercase tracking-wide">New sheet name</label>
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g. 2026 PC Baseball"
              className="mt-1 w-full h-10 rounded-xl bg-background border border-card-border px-3 text-sm outline-none focus:ring-2 focus:ring-foil-violet/30"
              data-testid="input-new-sheet-title"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newTitle.trim()) createMutation.mutate(newTitle.trim());
                if (e.key === "Escape") { setCreating(false); setNewTitle(""); }
              }}
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => createMutation.mutate(newTitle.trim())}
                disabled={!newTitle.trim() || createMutation.isPending}
                className="flex-1 h-10 rounded-xl bg-foil-violet text-white text-sm font-medium disabled:opacity-50 hover-elevate"
                data-testid="button-create-sheet"
              >
                {createMutation.isPending ? "Creating…" : "Create"}
              </button>
              <button
                onClick={() => { setCreating(false); setNewTitle(""); }}
                className="h-10 px-4 rounded-xl border border-card-border text-sm hover-elevate"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* List */}
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-[68px] rounded-2xl bg-card border border-card-border animate-pulse" />
            ))}
          </div>
        ) : sheets.length === 0 ? (
          <EmptyState
            needsGoogle={needsGoogle}
            onCreate={() => setCreating(true)}
          />
        ) : (
          <div className="space-y-2">
            {sheets.map((s) => {
              const isActive = s.id === activeId;
              const isEditing = editingId === s.id;
              return (
                <div
                  key={s.id}
                  className={cn(
                    "rounded-2xl bg-card border p-3",
                    isActive ? "border-foil-green/40 ring-1 ring-foil-green/20" : "border-card-border",
                    !isEditing && "hover-elevate"
                  )}
                  data-testid={`sheet-${s.id}`}
                >
                  {isEditing ? (
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="flex-1 h-10 rounded-xl bg-background border border-card-border px-3 text-sm outline-none focus:ring-2 focus:ring-foil-violet/30"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && editTitle.trim()) renameSheet.mutate({ id: s.id, title: editTitle.trim() });
                          if (e.key === "Escape") setEditingId(null);
                        }}
                      />
                      <button
                        onClick={() => renameSheet.mutate({ id: s.id, title: editTitle.trim() })}
                        disabled={!editTitle.trim() || renameSheet.isPending}
                        className="h-10 px-3 rounded-xl bg-foil-violet text-white text-sm font-medium disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="h-10 w-10 rounded-xl border border-card-border flex items-center justify-center"
                        aria-label="Cancel"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          "w-10 h-10 rounded-xl flex items-center justify-center shrink-0",
                          isActive ? "bg-foil-green/15" : "bg-muted"
                        )}
                      >
                        <FileSpreadsheet
                          className={cn("w-5 h-5", isActive ? "text-foil-green" : "text-muted-foreground")}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <p className="text-sm font-medium leading-tight truncate">{s.title}</p>
                          {isActive && (
                            <span className="shrink-0 text-[10px] font-semibold text-foil-green bg-foil-green/10 border border-foil-green/20 rounded-full px-2 py-0.5 uppercase tracking-wide">
                              Active
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                          {isActive
                            ? `${summary?.cardCount ?? 0} cards · Syncing now`
                            : "Linked to Google Sheets"}
                        </p>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {!isActive && (
                          <button
                            onClick={() => setActive.mutate(s.id)}
                            disabled={setActive.isPending}
                            className="w-8 h-8 rounded-lg hover-elevate flex items-center justify-center text-muted-foreground"
                            aria-label="Set as active"
                            title="Set as active"
                            data-testid={`button-set-active-${s.id}`}
                          >
                            <Star className="w-4 h-4" />
                          </button>
                        )}
                        <a
                          href={`https://docs.google.com/spreadsheets/d/${s.googleSheetId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-8 h-8 rounded-lg hover-elevate flex items-center justify-center text-muted-foreground"
                          aria-label="Open in Google Sheets"
                          title="Open in Google Sheets"
                          data-testid={`link-open-sheet-${s.id}`}
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                        <button
                          onClick={() => { setEditingId(s.id); setEditTitle(s.title); }}
                          className="w-8 h-8 rounded-lg hover-elevate flex items-center justify-center text-muted-foreground"
                          aria-label="Rename"
                          title="Rename"
                          data-testid={`button-rename-sheet-${s.id}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm(`Unlink "${s.title}"? The Google Sheet will not be deleted.`)) {
                              unlinkSheet.mutate(s.id);
                            }
                          }}
                          className="w-8 h-8 rounded-lg hover-elevate flex items-center justify-center text-muted-foreground"
                          aria-label="Unlink"
                          title="Unlink"
                          data-testid={`button-unlink-sheet-${s.id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function ConnectionCard({
  user,
  needsGoogle,
}: {
  user: { email: string | null; displayName: string | null };
  needsGoogle: boolean;
}) {
  if (needsGoogle) {
    return (
      <div className="mx-4 rounded-2xl bg-card border border-card-border p-4 flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
          <FileSpreadsheet className="w-5 h-5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Google not connected</p>
          <p className="text-[11px] text-muted-foreground truncate">
            Connect Google to create and sync Sheets.
          </p>
        </div>
        <a
          href="/api/auth/google/connect"
          className="shrink-0 h-9 px-3 rounded-xl bg-foil-violet text-white text-xs font-medium flex items-center hover-elevate"
          data-testid="link-connect-google"
        >
          Connect
        </a>
      </div>
    );
  }

  return (
    <div className="mx-4 rounded-2xl bg-card border border-card-border p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-full bg-foil-green/15 flex items-center justify-center">
        <Check className="w-5 h-5 text-foil-green" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">
          Connected as {user.displayName || user.email?.split("@")[0] || "you"}
        </p>
        <p className="text-[11px] text-muted-foreground truncate">{user.email}</p>
      </div>
      <button
        onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/sheets"] })}
        className="text-xs text-muted-foreground flex items-center gap-1 h-8 px-2 rounded-lg hover-elevate shrink-0"
        data-testid="button-sync-now"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        Sync
      </button>
    </div>
  );
}

function EmptyState({
  needsGoogle,
  onCreate,
}: {
  needsGoogle: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="rounded-2xl bg-card border border-card-border p-6 flex flex-col items-center text-center">
      <div className="w-14 h-14 rounded-2xl bg-foil-green/10 flex items-center justify-center mb-3">
        <FileSpreadsheet className="w-7 h-7 text-foil-green" />
      </div>
      <p className="text-sm font-medium">No sheets yet</p>
      <p className="text-xs text-muted-foreground mt-1 max-w-[260px]">
        {needsGoogle
          ? "Connect Google above, then create your first sheet to start backing up cards."
          : "Create your first sheet and every scan will sync to Google Sheets automatically."}
      </p>
      {!needsGoogle && (
        <button
          onClick={onCreate}
          className="mt-4 h-10 px-4 rounded-xl bg-foil-violet text-white text-sm font-medium flex items-center gap-1.5 hover-elevate"
          data-testid="button-create-first-sheet"
        >
          <Plus className="w-4 h-4" /> Create first sheet
        </button>
      )}
    </div>
  );
}
