import { Link, useLocation } from "wouter";
import { Bell, User as UserIcon } from "lucide-react";
import Logo from "./Logo";
import { useAuth } from "@/hooks/use-auth";

/**
 * Redesign TopBar. Renders the Holo-P tile logo + wordmark, a notifications
 * button, and a profile button. On Home/Scan the bar also shows a compact
 * "Signed in as …" line so the active account is always visible at a glance.
 *
 * This replaces Header.tsx for the new shell. Header.tsx is still used by
 * legacy pages that haven't been rebuilt yet; they render their own layout.
 */
export default function TopBar() {
  const [location, setLocation] = useLocation();
  const { user } = useAuth();
  const isScan = location === "/" || location === "/scan";

  return (
    <header className="sticky top-0 z-30 bg-paper/85 backdrop-blur border-b border-card-border">
      <div className="mx-auto max-w-lg flex items-center justify-between px-4 h-14">
        <Link
          href="/"
          className="flex items-center gap-2 text-ink"
          data-testid="link-home"
        >
          <Logo className="h-7 w-7" tile />
          <span className="font-display font-semibold text-[17px] tracking-tight">
            PackScan
          </span>
        </Link>
        <div className="flex items-center gap-1">
          <button
            className="w-9 h-9 rounded-full hover:bg-muted flex items-center justify-center text-slate-500 transition-colors"
            aria-label="Notifications"
            data-testid="button-notifications"
          >
            <Bell className="w-[18px] h-[18px]" />
          </button>
          <button
            onClick={() => setLocation("/account")}
            className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-ink hover:bg-slate-200 transition-colors"
            aria-label="Profile"
            data-testid="button-profile"
          >
            <UserIcon className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>
      {isScan && user?.email && (
        <div className="mx-auto max-w-lg px-4 pb-2 text-xs text-slate-500">
          Signed in as <span className="text-ink font-medium">{user.email}</span>
        </div>
      )}
    </header>
  );
}
