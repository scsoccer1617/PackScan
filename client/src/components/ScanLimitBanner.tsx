import { AlertTriangle, Sparkles } from "lucide-react";
import { useScanQuota } from "@/hooks/use-scan-quota";
import { useAuth } from "@/hooks/use-auth";

interface ScanLimitBannerProps {
  /** When true, renders the warning state at any usage level >= 80%. */
  showWarning?: boolean;
  /** Optional extra copy to clarify what the user can still do. */
  helperText?: string;
}

/**
 * Shared "you've hit the beta scan cap" banner used by Single Scan and
 * Bulk Scan entry points. Renders nothing for unauthenticated users or
 * users without a quota provisioned (limit === 0).
 *
 * Two states:
 *   - exhausted (used >= limit) → blocking red banner asking the user to
 *     contact the admin.
 *   - approaching (used >= 80% of limit, opt-in via showWarning) → soft
 *     amber banner so dealers aren't surprised when the cap hits.
 *
 * The banner is intentionally informational — it does not, by itself,
 * disable the scan buttons. The server's 429 is the source of truth.
 * Disabling the entry tiles client-side is a UX nicety the calling page
 * can do based on `exhausted` from `useScanQuota`.
 */
export default function ScanLimitBanner({ showWarning = true, helperText }: ScanLimitBannerProps) {
  const { user } = useAuth();
  const { used, limit, exhausted, remaining } = useScanQuota();
  if (!user || limit === 0) return null;

  if (exhausted) {
    return (
      <div
        className="mx-4 mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-3"
        data-testid="banner-scan-limit-reached"
      >
        <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
        <div className="text-[13px] text-red-900 leading-snug">
          <div className="font-medium">Beta scan limit reached</div>
          <div className="mt-0.5 text-red-800">
            You've processed {used} of your {limit} cards. New scans will be blocked
            until you're granted more.{" "}
            {helperText ?? "Reach out to the dev to bump your quota."}
          </div>
        </div>
      </div>
    );
  }

  if (showWarning && limit > 0 && remaining <= Math.ceil(limit * 0.2)) {
    return (
      <div
        className="mx-4 mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 flex items-start gap-3"
        data-testid="banner-scan-limit-warning"
      >
        <Sparkles className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="text-[13px] text-amber-900 leading-snug">
          <span className="font-medium">{remaining} scans left</span>
          <span className="text-amber-800">
            {" "}— ping the dev when you're close so we can bump your beta quota.
          </span>
        </div>
      </div>
    );
  }

  return null;
}
