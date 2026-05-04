import { cn } from "@/lib/utils";

// PR R Item 4 — streaming card-info header.
//
// Renders a result-style identity line ("2025 Topps · Base Set · #US49 ·
// Michael Petersen") above the chip stack while the scan is in flight.
// Fields populate as `analyzing_card:completed` lands its `data` payload;
// not-yet-known fields render as a neutral skeleton so the layout stays
// stable and the user can see what's still being identified.
//
// The component is intentionally read-only and side-effect free — the
// parent owns the streaming state. When the scan finishes the header can
// stay mounted (no re-mount flash) until navigation to /result.

export interface ScanInfoHeaderFields {
  year?: number | string | null;
  brand?: string | null;
  set?: string | null;
  cardNumber?: string | null;
  player?: string | null;
}

interface ScanInfoHeaderProps {
  fields: ScanInfoHeaderFields;
  /** When false, suppresses the skeletons and renders only the
   *  populated fields (used after the final result lands). */
  showSkeletons?: boolean;
}

function fieldOrSkeleton(
  value: string | number | null | undefined,
  width: string,
  showSkeletons: boolean,
  testId: string,
): JSX.Element {
  const str = value == null ? "" : String(value).trim();
  if (str) {
    return (
      <span data-testid={testId} className="text-ink">
        {str}
      </span>
    );
  }
  if (!showSkeletons) {
    return (
      <span data-testid={testId} className="text-slate-300">
        —
      </span>
    );
  }
  return (
    <span
      data-testid={`${testId}-skeleton`}
      className={cn(
        "inline-block align-middle rounded h-3.5",
        "bg-slate-200 animate-pulse",
        width,
      )}
      aria-hidden
    />
  );
}

export function ScanInfoHeader({
  fields,
  showSkeletons = true,
}: ScanInfoHeaderProps) {
  const { year, brand, set, cardNumber, player } = fields;
  const cardNumDisplay =
    cardNumber == null
      ? null
      : String(cardNumber).startsWith("#")
        ? String(cardNumber)
        : `#${cardNumber}`;

  return (
    <div
      data-testid="scan-info-header"
      className={cn(
        "rounded-2xl border border-slate-200 bg-white px-4 py-3",
        "scan-chip-mount",
      )}
    >
      <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1">
        Identifying card
      </p>
      <p className="font-display text-base font-semibold leading-snug">
        {fieldOrSkeleton(year, "w-10", showSkeletons, "scan-info-header-year")}{" "}
        {fieldOrSkeleton(
          brand,
          "w-16",
          showSkeletons,
          "scan-info-header-brand",
        )}{" "}
        <span className="text-slate-400">·</span>{" "}
        {fieldOrSkeleton(set, "w-20", showSkeletons, "scan-info-header-set")}{" "}
        <span className="text-slate-400">·</span>{" "}
        {fieldOrSkeleton(
          cardNumDisplay,
          "w-12",
          showSkeletons,
          "scan-info-header-card-number",
        )}{" "}
        <span className="text-slate-400">·</span>{" "}
        {fieldOrSkeleton(
          player,
          "w-32",
          showSkeletons,
          "scan-info-header-player",
        )}
      </p>
    </div>
  );
}
