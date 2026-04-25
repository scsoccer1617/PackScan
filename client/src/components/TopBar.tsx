import { Link, useLocation } from "wouter";
import { User as UserIcon, ShieldCheck } from "lucide-react";
import Logo from "./Logo";
import { useAuth } from "@/hooks/use-auth";
import ScanUsagePill from "./ScanUsagePill";
import FeedbackButton from "./FeedbackModal";

const ADMIN_EMAIL = "daniel.j.holley@gmail.com";

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
          {/* Beta scan usage pill — hidden on phones to keep the header tight,
              visible from `sm` up. Renders only when the user has a quota. */}
          <ScanUsagePill />
          {/* Feedback replaces the placeholder Notifications bell during beta.
              Wires into /api/feedback → Google Sheet. We can bring Bell back
              as a real notifications surface post-beta. */}
          <FeedbackButton />
          {user?.email?.trim().toLowerCase() === ADMIN_EMAIL && (
            <button
              onClick={() => setLocation("/admin")}
              className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-ink hover:bg-slate-200 transition-colors"
              aria-label="Admin"
              title="Admin"
              data-testid="button-admin"
            >
              <ShieldCheck className="w-[18px] h-[18px]" />
            </button>
          )}
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
