import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  FileSpreadsheet,
  Shield,
  HelpCircle,
  LogOut,
  ChevronRight,
  KeyRound,
  Mail,
  Check,
  X,
  Loader2,
  Database,
  Sparkles,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { usePreferences } from "@/hooks/use-preferences";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";

/**
 * Redesigned Account page (`/account`).
 *
 * Merges the prototype's Profile layout (hero identity card + settings
 * rows) with the real account-management features (change password,
 * Google connect, sign out). This also resolves the "Profile vs
 * AccountSettings" naming decision: the route stays /account and the
 * nav label stays "Account settings" for continuity, but the visual
 * structure matches the prototype.
 *
 * Real data wired in:
 *   - Hero: displayName, email, initials
 *   - Stats: cards (from /api/collection/summary), sheets count
 *     (from /api/sheets)
 *   - Password form: POST /api/auth/change-password (collapsed by
 *     default into an inline panel triggered from a settings row)
 *   - Google connect link: /api/auth/google/connect
 *   - Sign out: uses the logout() from useAuth
 */

type SheetsResponse = {
  sheets: { id: number }[];
  activeSheetId: number | null;
};
type CollectionSummary = { cardCount: number; totalValue: number };

export default function AccountSettings() {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const { data: summary } = useQuery<CollectionSummary>({
    queryKey: ["/api/collection/summary"],
    enabled: !!user,
  });

  const { data: sheetsData } = useQuery<SheetsResponse>({
    queryKey: ["/api/sheets"],
    enabled: !!user,
  });

  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Per-user app preferences (autoGrade, future keys). Loaded via React Query
  // and updated via PATCH; server is the source of truth so the scan route
  // can't be tricked by a stale client.
  const { preferences, update: updatePreferences, isUpdating: prefsUpdating } = usePreferences();
  const toggleAutoGrade = () => {
    updatePreferences(
      { autoGrade: !preferences.autoGrade },
      {
        onError: () => {
          toast({
            title: "Couldn't save setting",
            description: "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiRequest({
        url: "/api/auth/change-password",
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      toast({ title: "Password updated" });
      setCurrentPassword("");
      setNewPassword("");
      setPasswordOpen(false);
    } catch (err: any) {
      const msg = String(err?.message || "").replace(/^\d+:\s*/, "");
      let parsed = msg;
      try { parsed = JSON.parse(msg).error || msg; } catch {}
      toast({ title: "Update failed", description: parsed, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    await logout();
    setLocation("/login");
  };

  if (!user) {
    return (
      <div className="px-4 pt-6 pb-10 text-sm text-muted-foreground">
        Please sign in.
      </div>
    );
  }

  const initials = getInitials(user.displayName, user.email);
  const hasPassword = user.email && !user.googleId; // best-effort hint
  const sheetsCount = sheetsData?.sheets?.length ?? 0;
  const cardsCount = summary?.cardCount ?? 0;

  return (
    <div className="pt-4 pb-10 space-y-5">
      {/* Header */}
      <div className="px-4">
        <h1 className="font-display text-[22px] font-semibold tracking-tight">Account</h1>
      </div>

      {/* Hero identity card */}
      <section className="mx-4 rounded-3xl bg-pack text-white p-5 relative overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "radial-gradient(circle at 80% 0%, rgba(139,92,246,0.4), transparent 55%), radial-gradient(circle at 0% 100%, rgba(251,191,36,0.22), transparent 55%)",
          }}
        />
        <div className="relative flex items-center gap-4">
          <div
            className="w-14 h-14 rounded-full bg-foil text-white flex items-center justify-center font-display text-xl font-semibold"
            data-testid="avatar-initials"
          >
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-display text-lg font-semibold leading-tight truncate" data-testid="text-display-name">
              {user.displayName || user.email?.split("@")[0] || "Your account"}
            </p>
            <p className="text-xs text-white/70 truncate" data-testid="text-email">
              {user.email || "No email on file"}
            </p>
          </div>
        </div>
        <div className="relative mt-4 grid grid-cols-2 gap-2">
          <Stat label="Cards" value={cardsCount.toLocaleString()} testId="stat-cards" />
          <Stat label="Sheets" value={sheetsCount.toString()} testId="stat-sheets" />
        </div>
      </section>

      {/* Google connection card */}
      {user.googleConnected ? (
        <section className="mx-4 rounded-2xl bg-card border border-card-border p-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-foil-green/15 flex items-center justify-center text-foil-green">
            <Check className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Google connected</p>
            <p className="text-[11px] text-muted-foreground truncate">
              Cards sync to your Google Sheet automatically.
            </p>
          </div>
        </section>
      ) : (
        <section className="mx-4 rounded-2xl bg-card border border-card-border p-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center text-muted-foreground">
            <FileSpreadsheet className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Google not connected</p>
            <p className="text-[11px] text-muted-foreground">
              Connect to back up cards to Google Sheets.
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
      )}

      {/* Settings rows */}
      <section className="px-4 space-y-2">
        <SettingRow
          icon={<Sparkles className="w-4 h-4" />}
          label="Grade cards automatically"
          sub="Each scan will take a little longer"
          onClick={toggleAutoGrade}
          disabled={prefsUpdating}
          trailing={
            <Switch
              checked={preferences.autoGrade}
              onCheckedChange={toggleAutoGrade}
              disabled={prefsUpdating}
              onClick={(e) => e.stopPropagation()}
              aria-label="Grade cards automatically"
              data-testid="switch-auto-grade"
            />
          }
          testId="row-auto-grade"
        />
        <SettingRow
          icon={<FileSpreadsheet className="w-4 h-4" />}
          label="Google Sheets"
          sub={sheetsCount > 0 ? `${sheetsCount} sheet${sheetsCount === 1 ? "" : "s"} linked` : "No sheets yet"}
          href="/sheets"
          testId="row-sheets"
        />
        {user.email && (
          <SettingRow
            icon={<Mail className="w-4 h-4" />}
            label="Email"
            sub={user.email}
            trailing={
              user.emailVerifiedAt ? (
                <span className="text-[10px] font-semibold text-foil-green bg-foil-green/10 border border-foil-green/20 rounded-full px-2 py-0.5 uppercase tracking-wide">
                  Verified
                </span>
              ) : (
                <span className="text-[10px] font-semibold text-foil-amber bg-foil-amber/10 border border-foil-amber/20 rounded-full px-2 py-0.5 uppercase tracking-wide">
                  Unverified
                </span>
              )
            }
            testId="row-email"
          />
        )}
        <SettingRow
          icon={<KeyRound className="w-4 h-4" />}
          label="Change password"
          sub={hasPassword ? "Update your sign-in password" : "Set a password on your account"}
          onClick={() => setPasswordOpen((v) => !v)}
          trailing={
            <ChevronRight
              className={cn(
                "w-4 h-4 text-muted-foreground transition-transform",
                passwordOpen && "rotate-90"
              )}
            />
          }
          testId="row-password"
        />

        {/* Inline password form */}
        {passwordOpen && (
          <form
            onSubmit={submit}
            className="rounded-2xl bg-card border border-card-border p-4 space-y-3"
            data-testid="form-change-password"
          >
            <div>
              <label className="text-[11px] text-muted-foreground uppercase tracking-wide">
                Current password{" "}
                {!hasPassword && (
                  <span className="text-muted-foreground/70 normal-case tracking-normal">
                    (leave blank if none)
                  </span>
                )}
              </label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className={inputCls}
                data-testid="input-current-password"
              />
            </div>
            <div>
              <label className="text-[11px] text-muted-foreground uppercase tracking-wide">
                New password
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={inputCls}
                data-testid="input-new-password"
              />
              <p className="text-[10px] text-muted-foreground mt-1">At least 8 characters.</p>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={submitting}
                className="flex-1 h-10 rounded-xl bg-foil-violet text-white text-sm font-medium disabled:opacity-50 hover-elevate flex items-center justify-center gap-1.5"
                data-testid="button-submit-password"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Update password"
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPasswordOpen(false);
                  setCurrentPassword("");
                  setNewPassword("");
                }}
                className="h-10 w-10 rounded-xl border border-card-border flex items-center justify-center hover-elevate"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </form>
        )}

        {/* Admin — only rendered for the designated admin email. The server
            also enforces email + password on every admin route, so hiding
            this row from non-admins is purely UI polish, not security. */}
        {isAdmin(user?.email) && (
          <SettingRow
            icon={<Database className="w-4 h-4" />}
            label="Admin · Card database"
            sub="Upload CSVs and manage the catalog"
            href="/admin/card-database"
            testId="row-admin"
          />
        )}

        <SettingRow
          icon={<Shield className="w-4 h-4" />}
          label="Privacy & data"
          sub="Coming soon"
          testId="row-privacy"
          disabled
        />
        <SettingRow
          icon={<HelpCircle className="w-4 h-4" />}
          label="Help & feedback"
          sub="Coming soon"
          testId="row-help"
          disabled
        />
      </section>

      {/* Sign out */}
      <section className="px-4 pt-1">
        <button
          onClick={handleSignOut}
          className="w-full flex items-center gap-3 p-3 rounded-2xl bg-card border border-card-border hover-elevate text-left"
          data-testid="button-sign-out"
        >
          <div className="w-9 h-9 rounded-xl bg-foil-red/10 text-foil-red flex items-center justify-center">
            <LogOut className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foil-red">Sign out</p>
          </div>
        </button>
      </section>

      <p className="text-center text-[11px] text-muted-foreground pt-2">PackScan</p>
    </div>
  );
}

const inputCls =
  "mt-1 w-full h-11 rounded-xl bg-background border border-card-border px-3 text-sm outline-none focus:ring-2 focus:ring-foil-violet/30";

/**
 * Admin gate — email match only. Must match the server's ADMIN_EMAIL
 * (server/routes.ts). Kept in sync manually because the client has no
 * reason to fetch a dedicated "am I admin?" endpoint; the server is the
 * real enforcement point on every admin route.
 */
const ADMIN_EMAIL = "daniel.j.holley@gmail.com";
function isAdmin(email: string | null | undefined): boolean {
  return !!email && email.trim().toLowerCase() === ADMIN_EMAIL;
}

function getInitials(name: string | null, email: string | null): string {
  const source = name || email || "";
  const parts = source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return "·";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-xl bg-white/10 p-3" data-testid={testId}>
      <p className="font-display text-lg font-semibold leading-none">{value}</p>
      <p className="text-[10px] uppercase tracking-[0.14em] text-white/60 mt-1">{label}</p>
    </div>
  );
}

function SettingRow({
  icon,
  label,
  sub,
  href,
  onClick,
  trailing,
  disabled,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
  href?: string;
  onClick?: () => void;
  trailing?: React.ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  const inner = (
    <>
      <div className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center text-foreground shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className={cn("text-sm font-medium", disabled && "text-muted-foreground")}>{label}</p>
        {sub && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{sub}</p>}
      </div>
      {trailing ?? <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
    </>
  );

  const cls = cn(
    "flex items-center gap-3 p-3 rounded-2xl bg-card border border-card-border text-left w-full",
    !disabled && "hover-elevate",
    disabled && "opacity-60 cursor-not-allowed"
  );

  if (href && !disabled) {
    return (
      <Link href={href} className={cls} data-testid={testId}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cls} data-testid={testId}>
      {inner}
    </button>
  );
}
