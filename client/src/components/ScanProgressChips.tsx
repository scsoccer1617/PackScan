import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// PR H — vertical stack of pill-shaped progress chips for the single-card
// scan flow. Each chip renders a status icon (animated spinner while the
// stage is in progress, green check once completed, dim dot while
// pending) on the left and the user-facing stage label to its right.
// Visual reference: Chrome DevTools AI assistant chip stack.

export type ChipStatus = "pending" | "in_progress" | "completed";

export interface ScanProgressChipStage {
  id: string;
  label: string;
  status: ChipStatus;
}

interface ScanProgressChipsProps {
  stages: ScanProgressChipStage[];
  /** When true the stack collapses with a fade after all chips complete.
   *  Defaults to false (stack stays visible). */
  collapseWhenAllComplete?: boolean;
}

export function ScanProgressChips({
  stages,
  collapseWhenAllComplete = true,
}: ScanProgressChipsProps) {
  const allComplete =
    stages.length > 0 && stages.every((s) => s.status === "completed");
  const hidden = collapseWhenAllComplete && allComplete;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 transition-opacity duration-500",
        hidden ? "opacity-0 pointer-events-none" : "opacity-100",
      )}
      data-testid="scan-progress-chips"
      aria-live="polite"
    >
      {stages.map((stage) => (
        <Chip key={stage.id} stage={stage} />
      ))}
    </div>
  );
}

function Chip({ stage }: { stage: ScanProgressChipStage }) {
  const { status, label } = stage;
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2.5 self-start",
        "rounded-full border px-3.5 py-2",
        "text-sm font-medium transition-colors duration-300",
        status === "completed"
          ? "bg-white text-ink border-slate-200"
          : status === "in_progress"
            ? "bg-white text-ink border-slate-200"
            : "bg-slate-50 text-slate-400 border-slate-200",
      )}
      data-testid={`scan-progress-chip-${stage.id}`}
      data-status={status}
    >
      <ChipIcon status={status} />
      <span>{label}</span>
    </div>
  );
}

function ChipIcon({ status }: { status: ChipStatus }) {
  if (status === "completed") {
    return (
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full",
          "bg-emerald-500 text-white",
        )}
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
    );
  }
  if (status === "in_progress") {
    return <Loader2 className="h-4 w-4 animate-spin text-slate-500" />;
  }
  return (
    <span className="flex h-4 w-4 items-center justify-center">
      <span className="h-2 w-2 rounded-full bg-slate-300" />
    </span>
  );
}

// Default 4-stage list for the single-card scan flow. Exported so callers
// can seed component state without restating the labels — the server
// emits matching stage ids from dualSideOCR.ts.
export const DEFAULT_SCAN_STAGES: ScanProgressChipStage[] = [
  { id: "analyzing_card", label: "Analyzing card", status: "pending" },
  { id: "detecting_parallel", label: "Detecting parallel", status: "pending" },
  { id: "verifying_with_ebay", label: "Looking for active eBay listings", status: "pending" },
  { id: "getting_price", label: "Getting price", status: "pending" },
];
