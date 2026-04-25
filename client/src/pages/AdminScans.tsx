// ─── /admin/scans — User scan review ────────────────────────────────────────
//
// Admin-only page that lists every save event from the `user_scans` table.
// This is intentionally walled off from the curated `card_database` source
// of truth — the admin reviews these rows offline and (manually) decides
// what gets promoted to the reference catalog.
//
// Layout: header + filter bar + paginated table. Clicking a row opens a
// detail drawer with the full detected/final field comparison and back-side
// image. Filters: action (👍 / 👎 / plain save) and userId.
//
// Email-gated client-side via the route guard in App.tsx; server enforces
// the same email check on every /api/admin/scans route.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Loader2,
  ScanLine,
  RefreshCw,
  AlertCircle,
  ThumbsUp,
  ThumbsDown,
  Save as SaveIcon,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const PAGE_SIZE = 50;

type UserAction = "confirmed" | "declined_edited" | "saved_no_feedback";

interface ScanListRow {
  id: number;
  userId: number | null;
  userEmail: string | null;
  cardId: number | null;
  scannedAt: string;
  userAction: UserAction;
  fieldsChanged: string[];
  finalPlayerFirstName: string | null;
  finalPlayerLastName: string | null;
  finalBrand: string | null;
  finalYear: number | null;
  finalCardNumber: string | null;
  finalSet: string | null;
  finalCollection: string | null;
  finalVariant: string | null;
  finalTeam: string | null;
  finalCmpNumber: string | null;
  frontImage: string | null;
  scpScore: string | null;
  cardDbCorroborated: boolean | null;
}

interface ScanListResponse {
  scans: ScanListRow[];
  total: number;
  limit: number;
  offset: number;
}

interface ScanDetailRow extends ScanListRow {
  detectedSport: string | null;
  detectedPlayerFirstName: string | null;
  detectedPlayerLastName: string | null;
  detectedBrand: string | null;
  detectedCollection: string | null;
  detectedSet: string | null;
  detectedCardNumber: string | null;
  detectedYear: number | null;
  detectedVariant: string | null;
  detectedTeam: string | null;
  detectedCmpNumber: string | null;
  detectedSerialNumber: string | null;
  detectedFoilType: string | null;
  detectedIsRookie: boolean | null;
  detectedIsAuto: boolean | null;
  detectedIsNumbered: boolean | null;
  detectedIsFoil: boolean | null;
  finalSport: string | null;
  finalSerialNumber: string | null;
  finalFoilType: string | null;
  finalIsRookie: boolean | null;
  finalIsAuto: boolean | null;
  finalIsNumbered: boolean | null;
  finalIsFoil: boolean | null;
  backImage: string | null;
  scpMatchedTitle: string | null;
  analyzerVersion: string | null;
}

const actionLabel: Record<UserAction, string> = {
  confirmed: "Confirmed",
  declined_edited: "Edited",
  saved_no_feedback: "No feedback",
};

const actionIcon: Record<UserAction, JSX.Element> = {
  confirmed: <ThumbsUp className="w-3 h-3" />,
  declined_edited: <ThumbsDown className="w-3 h-3" />,
  saved_no_feedback: <SaveIcon className="w-3 h-3" />,
};

const actionTone: Record<UserAction, string> = {
  confirmed: "bg-green-50 text-green-700 border-green-200",
  declined_edited: "bg-amber-50 text-amber-700 border-amber-200",
  saved_no_feedback: "bg-slate-100 text-slate-600 border-slate-200",
};

export default function AdminScans() {
  const [actionFilter, setActionFilter] = useState<UserAction | "all">("all");
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(page * PAGE_SIZE));
    if (actionFilter !== "all") params.set("action", actionFilter);
    return params.toString();
  }, [actionFilter, page]);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<ScanListResponse>({
    queryKey: ["/api/admin/scans", queryParams],
    queryFn: async () => {
      const res = await fetch(`/api/admin/scans?${queryParams}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed to load scans (${res.status})`);
      return res.json();
    },
  });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="pt-4 pb-10 space-y-5">
      {/* Header */}
      <div className="px-4 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScanLine className="w-5 h-5 text-slate-700" />
          <div>
            <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">
              User scans
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Every save event across all users — review for catalog enrichment.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="shrink-0 w-10 h-10 rounded-xl border border-card-border bg-card flex items-center justify-center hover-elevate text-slate-600"
          aria-label="Refresh"
          data-testid="button-admin-scans-refresh"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Filter bar */}
      <section className="mx-4 rounded-2xl bg-card border border-card-border p-3 flex items-center gap-2 flex-wrap">
        <span className="text-[12px] text-slate-600 mr-1">Filter:</span>
        {(["all", "confirmed", "declined_edited", "saved_no_feedback"] as const).map((opt) => {
          const active = actionFilter === opt;
          const label = opt === "all" ? "All" : actionLabel[opt];
          return (
            <button
              key={opt}
              type="button"
              onClick={() => {
                setActionFilter(opt);
                setPage(0);
              }}
              className={`text-[12px] px-3 py-1.5 rounded-full border transition-colors ${
                active
                  ? "bg-ink text-white border-ink"
                  : "bg-white text-slate-700 border-card-border hover:bg-slate-50"
              }`}
              data-testid={`button-filter-${opt}`}
            >
              {label}
            </button>
          );
        })}
        <span className="ml-auto text-[12px] text-slate-500 tabular-nums">
          {total.toLocaleString()} {total === 1 ? "scan" : "scans"}
        </span>
      </section>

      {/* Scan table */}
      <section className="mx-4 rounded-2xl bg-card border border-card-border overflow-hidden">
        {isLoading && (
          <div className="px-4 py-10 flex items-center justify-center text-sm text-slate-500">
            <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading scans…
          </div>
        )}
        {isError && (
          <div className="px-4 py-10 flex items-start gap-2 text-sm text-red-700">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            Couldn't load scans. You may not be authorized — check that you're signed in as the admin.
          </div>
        )}
        {data?.scans && data.scans.length === 0 && (
          <div className="px-4 py-10 text-sm text-slate-500 text-center">
            No scans match this filter yet.
          </div>
        )}
        {data?.scans && data.scans.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">When</th>
                  <th className="text-left px-3 py-2 font-medium">User</th>
                  <th className="text-left px-3 py-2 font-medium">Action</th>
                  <th className="text-left px-3 py-2 font-medium">Card</th>
                  <th className="text-left px-3 py-2 font-medium">Edited</th>
                  <th className="text-right px-3 py-2 font-medium">SCP</th>
                  <th className="text-right px-3 py-2 font-medium">CardDB</th>
                </tr>
              </thead>
              <tbody>
                {data.scans.map((s) => (
                  <ScanRow key={s.id} scan={s} onOpen={() => setOpenId(s.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* Pagination */}
        {data?.scans && data.scans.length > 0 && (
          <div className="flex items-center justify-between border-t border-card-border px-3 py-2 text-[12px] text-slate-600">
            <span>
              Page {page + 1} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                data-testid="button-scans-prev"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
                data-testid="button-scans-next"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Detail drawer */}
      {openId !== null && <ScanDetail id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

interface ScanRowProps {
  scan: ScanListRow;
  onOpen: () => void;
}

function ScanRow({ scan, onOpen }: ScanRowProps) {
  const editedCount = scan.fieldsChanged?.length ?? 0;
  const card = formatCardSummary(scan);
  const userLabel = scan.userEmail || (scan.userId ? `user #${scan.userId}` : "—");

  return (
    <tr
      className="border-t border-card-border hover:bg-slate-50 cursor-pointer"
      onClick={onOpen}
      data-testid={`row-scan-${scan.id}`}
    >
      <td className="px-3 py-2.5 text-slate-600 tabular-nums whitespace-nowrap">
        {formatRelative(scan.scannedAt)}
      </td>
      <td className="px-3 py-2.5 truncate max-w-[200px] text-ink">{userLabel}</td>
      <td className="px-3 py-2.5">
        <span
          className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${
            actionTone[scan.userAction]
          }`}
        >
          {actionIcon[scan.userAction]}
          {actionLabel[scan.userAction]}
        </span>
      </td>
      <td className="px-3 py-2.5 truncate max-w-[260px] text-ink">{card}</td>
      <td className="px-3 py-2.5">
        {editedCount > 0 ? (
          <Badge variant="outline" className="text-[11px] tabular-nums">
            {editedCount} field{editedCount === 1 ? "" : "s"}
          </Badge>
        ) : (
          <span className="text-[12px] text-slate-400">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">
        {scan.scpScore ? Number(scan.scpScore).toFixed(0) : "—"}
      </td>
      <td className="px-3 py-2.5 text-right">
        {scan.cardDbCorroborated === true ? (
          <span className="text-green-700 text-[12px]">✓</span>
        ) : scan.cardDbCorroborated === false ? (
          <span className="text-slate-400 text-[12px]">·</span>
        ) : (
          <span className="text-slate-300 text-[12px]">—</span>
        )}
      </td>
    </tr>
  );
}

function formatCardSummary(s: ScanListRow): string {
  const player = [s.finalPlayerFirstName, s.finalPlayerLastName].filter(Boolean).join(" ");
  const meta = [
    s.finalYear ? String(s.finalYear) : null,
    s.finalBrand,
    s.finalCardNumber ? `#${s.finalCardNumber}` : null,
  ].filter(Boolean).join(" ");
  if (player && meta) return `${player} — ${meta}`;
  return player || meta || "Untitled scan";
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d`;
  return d.toLocaleDateString();
}

// ─── Detail drawer ──────────────────────────────────────────────────────────

interface ScanDetailProps {
  id: number;
  onClose: () => void;
}

function ScanDetail({ id, onClose }: ScanDetailProps) {
  const { data, isLoading, isError } = useQuery<{ scan: ScanDetailRow }>({
    queryKey: [`/api/admin/scans/${id}`],
    queryFn: async () => {
      const res = await fetch(`/api/admin/scans/${id}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed to load scan ${id}`);
      return res.json();
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-stretch justify-end"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-white h-full overflow-y-auto shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-card-border flex items-center justify-between">
          <h2 className="font-display text-[16px] font-semibold text-ink">
            Scan #{id}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-600"
            aria-label="Close"
            data-testid="button-scan-detail-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 p-4 space-y-4">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {isError && (
            <div className="text-sm text-red-700 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5" /> Couldn't load scan.
            </div>
          )}
          {data?.scan && <ScanDetailBody scan={data.scan} />}
        </div>
      </div>
    </div>
  );
}

function ScanDetailBody({ scan }: { scan: ScanDetailRow }) {
  const changed = new Set(scan.fieldsChanged || []);
  const rows: { key: string; label: string; detected: unknown; final: unknown }[] = [
    { key: "sport", label: "Sport", detected: scan.detectedSport, final: scan.finalSport },
    { key: "playerFirstName", label: "First name", detected: scan.detectedPlayerFirstName, final: scan.finalPlayerFirstName },
    { key: "playerLastName", label: "Last name", detected: scan.detectedPlayerLastName, final: scan.finalPlayerLastName },
    { key: "brand", label: "Brand", detected: scan.detectedBrand, final: scan.finalBrand },
    { key: "collection", label: "Collection", detected: scan.detectedCollection, final: scan.finalCollection },
    { key: "set", label: "Set", detected: scan.detectedSet, final: scan.finalSet },
    { key: "cardNumber", label: "Card #", detected: scan.detectedCardNumber, final: scan.finalCardNumber },
    { key: "year", label: "Year", detected: scan.detectedYear, final: scan.finalYear },
    { key: "variant", label: "Variant", detected: scan.detectedVariant, final: scan.finalVariant },
    { key: "team", label: "Team", detected: scan.detectedTeam, final: scan.finalTeam },
    { key: "cmpNumber", label: "CMP", detected: scan.detectedCmpNumber, final: scan.finalCmpNumber },
    { key: "serialNumber", label: "Serial", detected: scan.detectedSerialNumber, final: scan.finalSerialNumber },
    { key: "foilType", label: "Foil type", detected: scan.detectedFoilType, final: scan.finalFoilType },
    { key: "isRookie", label: "Rookie", detected: scan.detectedIsRookie, final: scan.finalIsRookie },
    { key: "isAuto", label: "Auto", detected: scan.detectedIsAuto, final: scan.finalIsAuto },
    { key: "isNumbered", label: "Numbered", detected: scan.detectedIsNumbered, final: scan.finalIsNumbered },
    { key: "isFoil", label: "Foil", detected: scan.detectedIsFoil, final: scan.finalIsFoil },
  ];

  return (
    <>
      {/* Summary */}
      <div className="rounded-xl border border-card-border bg-slate-50 px-3 py-2.5 text-[12px] text-slate-700 space-y-0.5">
        <div>
          <span className="text-slate-500">User: </span>
          <span className="text-ink">
            {scan.userEmail || (scan.userId ? `#${scan.userId}` : "—")}
          </span>
        </div>
        <div>
          <span className="text-slate-500">Action: </span>
          <span className="text-ink">{actionLabel[scan.userAction]}</span>
          <span className="text-slate-400"> · {scan.fieldsChanged.length} edited</span>
        </div>
        <div>
          <span className="text-slate-500">Scanned: </span>
          <span className="text-ink">{new Date(scan.scannedAt).toLocaleString()}</span>
        </div>
        {scan.scpMatchedTitle && (
          <div className="truncate">
            <span className="text-slate-500">SCP: </span>
            <span className="text-ink">{scan.scpMatchedTitle}</span>
            {scan.scpScore && (
              <span className="text-slate-400"> · {Number(scan.scpScore).toFixed(0)}</span>
            )}
          </div>
        )}
        {scan.analyzerVersion && (
          <div>
            <span className="text-slate-500">Analyzer: </span>
            <span className="text-ink">{scan.analyzerVersion}</span>
          </div>
        )}
      </div>

      {/* Images */}
      {(scan.frontImage || scan.backImage) && (
        <div className="grid grid-cols-2 gap-2">
          {scan.frontImage && (
            <div>
              <div className="text-[11px] text-slate-500 mb-1">Front</div>
              <img
                src={scan.frontImage}
                alt="Front scan"
                className="w-full rounded-lg border border-card-border bg-slate-50 object-contain"
              />
            </div>
          )}
          {scan.backImage && (
            <div>
              <div className="text-[11px] text-slate-500 mb-1">Back</div>
              <img
                src={scan.backImage}
                alt="Back scan"
                className="w-full rounded-lg border border-card-border bg-slate-50 object-contain"
              />
            </div>
          )}
        </div>
      )}

      {/* Field comparison */}
      <div className="rounded-xl border border-card-border overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="text-left px-2 py-1.5 font-medium">Field</th>
              <th className="text-left px-2 py-1.5 font-medium">Detected</th>
              <th className="text-left px-2 py-1.5 font-medium">Saved</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className={`border-t border-card-border ${
                  changed.has(r.key) ? "bg-amber-50/50" : ""
                }`}
              >
                <td className="px-2 py-1.5 text-slate-600">{r.label}</td>
                <td className="px-2 py-1.5 text-slate-700 truncate max-w-[150px]">
                  {formatVal(r.detected)}
                </td>
                <td
                  className={`px-2 py-1.5 truncate max-w-[150px] ${
                    changed.has(r.key) ? "text-amber-800 font-medium" : "text-slate-700"
                  }`}
                >
                  {formatVal(r.final)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function formatVal(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}
