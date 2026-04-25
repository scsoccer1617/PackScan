// ─── Beta scan quota hook ───────────────────────────────────────────────────
//
// Reads the signed-in user's scan quota from /api/user/scan-quota. Used by:
//   - The header usage indicator ("X / 50 cards used")
//   - Single Scan + Bulk Scan to render a "limit reached" empty state
//   - The admin page to verify changes propagate live
//
// Mirrors the ScanQuotaState shape returned by server/scanQuota.ts.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";

export interface ScanQuotaState {
  used: number;
  limit: number;
  exhausted: boolean;
  remaining: number;
}

export const SCAN_QUOTA_QUERY_KEY = ["/api/user/scan-quota"] as const;

/**
 * Fetch scan quota for the current user. Returns a stable shape (limit=0,
 * not exhausted) for unauthenticated callers so consumers can render
 * unconditionally without null-guarding.
 */
export function useScanQuota() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery<ScanQuotaState>({
    queryKey: SCAN_QUOTA_QUERY_KEY,
    enabled: !!user,
    // Refresh moderately often so the indicator feels live as scans
    // complete. 15s is a compromise: tight enough that the count visibly
    // ticks during a bulk batch, loose enough that idle users don't
    // hammer the API.
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
  const data = query.data ?? { used: 0, limit: 0, exhausted: false, remaining: 0 };
  return {
    ...data,
    isLoading: query.isLoading,
    /** Force a refresh after a known-mutating action (e.g. saving a card). */
    invalidate: () => queryClient.invalidateQueries({ queryKey: SCAN_QUOTA_QUERY_KEY }),
  };
}
