import { useScanQuota } from "@/hooks/use-scan-quota";
import { useAuth } from "@/hooks/use-auth";

/**
 * Compact pill that shows beta scan usage in the TopBar — "12 / 50".
 *
 * Renders nothing for:
 *   - Anonymous users (auth gate)
 *   - Users whose limit hasn't been provisioned yet (limit === 0)
 *   - The very first frame before the query resolves (avoids a flash)
 *
 * Color cue:
 *   - Default: muted slate
 *   - >= 80% used: amber (warn the dealer to ask for a bump)
 *   - Exhausted: red
 *
 * The pill is intentionally not interactive — admin actions live on
 * /admin, and tap-to-buy will live elsewhere when monetization ships.
 */
export default function ScanUsagePill() {
  const { user } = useAuth();
  const { used, limit, exhausted, isLoading } = useScanQuota();

  if (!user || isLoading || limit === 0) return null;

  const pct = limit > 0 ? used / limit : 0;
  const tone = exhausted
    ? "bg-red-50 text-red-700 border-red-200"
    : pct >= 0.8
      ? "bg-amber-50 text-amber-700 border-amber-200"
      : "bg-slate-50 text-slate-600 border-slate-200";

  return (
    <span
      className={`hidden sm:inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-full border ${tone}`}
      data-testid="text-scan-usage"
      title={exhausted ? "Beta scan limit reached — contact admin to continue" : "Beta scan usage"}
    >
      <span className="tabular-nums">{used}</span>
      <span className="opacity-60">/</span>
      <span className="tabular-nums">{limit}</span>
    </span>
  );
}
