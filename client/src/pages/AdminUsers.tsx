// ─── /admin — Beta tester management ───────────────────────────────────────
//
// Email-gated (server: requireAdminUser, client: route guard in App.tsx).
// Lets the admin (daniel.j.holley@gmail.com during beta) see every user's
// scan usage, change a single user's cap, reset a user's count, and bump
// every user's cap by an arbitrary delta in one shot. The shared admin
// password gate from /admin/card-database is intentionally NOT applied
// here — see server/routes.ts beta-launch section for rationale.
//
// We keep the layout minimal (table + small toolbar). The beta tester
// roster is ~6-7 users; sortable columns / pagination would be overkill.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Users, RefreshCw, AlertCircle, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface AdminUser {
  id: number;
  email: string | null;
  username: string | null;
  scanLimit: number;
  scanCount: number;
  createdAt: string;
}

interface UsersResponse {
  users: AdminUser[];
}

const ADMIN_USERS_KEY = ["/api/admin/users"] as const;

export default function AdminUsers() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [bumpDelta, setBumpDelta] = useState(50);

  const { data, isLoading, isError, refetch } = useQuery<UsersResponse>({
    queryKey: ADMIN_USERS_KEY,
  });

  const patchUser = useMutation({
    mutationFn: async (vars: { id: number; body: { scanLimit?: number; resetCount?: boolean } }) => {
      return apiRequest({
        url: `/api/admin/users/${vars.id}`,
        method: "PATCH",
        body: vars.body,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY });
    },
    onError: (err: any) => {
      toast({
        title: "Update failed",
        description: err?.message || "Could not update user.",
        variant: "destructive",
      });
    },
  });

  const bumpAll = useMutation({
    mutationFn: async (delta: number) => {
      return apiRequest<{ updated: number; delta: number }>({
        url: "/api/admin/users/bump-all",
        method: "POST",
        body: { delta },
      });
    },
    onSuccess: (res) => {
      toast({
        title: `Bumped ${res?.updated ?? "?"} users`,
        description: `Added ${res?.delta ?? 0} to every user's scan limit.`,
      });
      queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY });
    },
    onError: (err: any) => {
      toast({
        title: "Bump failed",
        description: err?.message || "Could not bump limits.",
        variant: "destructive",
      });
    },
  });

  return (
    <div className="pt-4 pb-10 space-y-5">
      {/* Header */}
      <div className="px-4 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-slate-700" />
          <div>
            <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">
              Beta users
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Manage scan caps and counts for everyone in the beta cohort.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="shrink-0 w-10 h-10 rounded-xl border border-card-border bg-card flex items-center justify-center hover-elevate text-slate-600"
          aria-label="Refresh"
          data-testid="button-admin-refresh"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Bump-all toolbar. Default delta is +50 to match the per-user beta
          quota; admin can edit before clicking. Negative values are
          allowed by the server (clamped at 0) for the rare course-correct
          case but we don't surface a "subtract" affordance here — the
          admin can type a negative number if needed. */}
      <section className="mx-4 rounded-2xl bg-card border border-card-border p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-[180px]">
            <Label htmlFor="bump-delta" className="text-[12px] text-slate-600">
              Bump every user's scan limit by
            </Label>
            <Input
              id="bump-delta"
              type="number"
              value={bumpDelta}
              onChange={(e) => setBumpDelta(parseInt(e.target.value || "0", 10) || 0)}
              className="mt-1"
              data-testid="input-bump-delta"
            />
          </div>
          <Button
            onClick={() => bumpAll.mutate(bumpDelta)}
            disabled={bumpAll.isPending || bumpDelta === 0}
            data-testid="button-bump-all"
            className="self-end"
          >
            {bumpAll.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Bumping…
              </>
            ) : (
              <>
                <ArrowUp className="w-4 h-4 mr-1.5" />
                Apply to all users
              </>
            )}
          </Button>
        </div>
        <p className="text-[11px] text-slate-500">
          Adds the value to every user's <code>scan_limit</code>. Limits are clamped at 0 — to
          revoke access, edit a user inline below.
        </p>
      </section>

      {/* User table */}
      <section className="mx-4 rounded-2xl bg-card border border-card-border overflow-hidden">
        {isLoading && (
          <div className="px-4 py-10 flex items-center justify-center text-sm text-slate-500">
            <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading users…
          </div>
        )}
        {isError && (
          <div className="px-4 py-10 flex items-start gap-2 text-sm text-red-700">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            Couldn't load users. You may not be authorized — check that you're signed in as the admin.
          </div>
        )}
        {data?.users && data.users.length === 0 && (
          <div className="px-4 py-10 text-sm text-slate-500 text-center">
            No users yet.
          </div>
        )}
        {data?.users && data.users.length > 0 && (
          <table className="w-full text-[13px]">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="text-left px-3 py-2 font-medium">User</th>
                <th className="text-right px-3 py-2 font-medium">Used</th>
                <th className="text-right px-3 py-2 font-medium">Limit</th>
                <th className="text-right px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  onSave={(scanLimit) => patchUser.mutate({ id: u.id, body: { scanLimit } })}
                  onReset={() => patchUser.mutate({ id: u.id, body: { resetCount: true } })}
                  saving={patchUser.isPending && patchUser.variables?.id === u.id}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

interface UserRowProps {
  user: AdminUser;
  onSave: (scanLimit: number) => void;
  onReset: () => void;
  saving: boolean;
}

// One row per beta user. Editing the limit is inline — typing into the
// input enables Save; pressing Save (or hitting Enter) calls PATCH. We
// keep the input local-state-only so the table doesn't re-render the
// whole row tree on every keystroke.
function UserRow({ user, onSave, onReset, saving }: UserRowProps) {
  const [draft, setDraft] = useState<string>(String(user.scanLimit));
  const dirty = draft !== String(user.scanLimit);

  // Visual cue when a user is at/over their cap so the admin can spot
  // who's blocked at a glance.
  const exhausted = user.scanCount >= user.scanLimit;
  const usedClass = exhausted ? "text-red-600 font-semibold" : "tabular-nums";

  const submit = () => {
    const n = parseInt(draft, 10);
    if (!Number.isFinite(n) || n < 0) return;
    onSave(n);
  };

  return (
    <tr className="border-t border-card-border">
      <td className="px-3 py-2.5">
        <div className="font-medium text-ink truncate max-w-[260px]" data-testid={`text-user-email-${user.id}`}>
          {user.email || user.username || `user #${user.id}`}
        </div>
        {user.email && user.username && user.username !== user.email && (
          <div className="text-[11px] text-slate-500 truncate">{user.username}</div>
        )}
      </td>
      <td className={`px-3 py-2.5 text-right ${usedClass}`} data-testid={`text-user-count-${user.id}`}>
        {user.scanCount}
      </td>
      <td className="px-3 py-2.5 text-right">
        <Input
          type="number"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          className="h-8 w-24 ml-auto text-right tabular-nums"
          data-testid={`input-user-limit-${user.id}`}
        />
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center justify-end gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={onReset}
            disabled={saving || user.scanCount === 0}
            data-testid={`button-user-reset-${user.id}`}
          >
            Reset
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={saving || !dirty}
            data-testid={`button-user-save-${user.id}`}
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
          </Button>
        </div>
      </td>
    </tr>
  );
}
