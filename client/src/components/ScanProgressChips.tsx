import { Check, Loader2 } from "lucide-react";
import { forwardRef, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

// PR H — vertical stack of pill-shaped progress chips for the single-card
// scan flow. Each chip renders a status icon (animated spinner while the
// stage is in progress, green check once completed, dim dot while
// pending) on the left and the user-facing stage label to its right.
// Visual reference: Chrome DevTools AI assistant chip stack.
//
// PR P — chips now mount progressively as their stage starts (pending
// chips are no longer pre-rendered). On mount each chip fades+slides in
// and, when allowed, calls scrollIntoView({block:'nearest'}) so the
// active chip stays visible. The auto-scroll trigger is gated by the
// caller's `userScrolledManually` flag — if the user has manually
// scrolled during this scan the caller suppresses auto-scroll for the
// rest of the scan.

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
  /** PR P — when true the chip that just mounted scrolls into view via
   *  `scrollIntoView({block:'nearest'})`. The parent is responsible for
   *  flipping this off if the user manually scrolls during the scan; we
   *  only honor the latest value at chip-mount time.
   *
   *  Optional. Default true preserves the natural reading flow on the
   *  Scan page; tests / non-scrolling contexts can pass false. */
  autoScrollEnabled?: boolean;
  /** PR P — invoked just before the chip calls scrollIntoView, so the
   *  parent can flip a `programmaticScrolling` flag and ignore the
   *  resulting scroll event in its user-scroll detector. */
  onBeforeAutoScroll?: () => void;
}

export function ScanProgressChips({
  stages,
  collapseWhenAllComplete = true,
  autoScrollEnabled = true,
  onBeforeAutoScroll,
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
        <Chip
          key={stage.id}
          stage={stage}
          autoScrollEnabled={autoScrollEnabled}
          onBeforeAutoScroll={onBeforeAutoScroll}
        />
      ))}
    </div>
  );
}

interface ChipProps {
  stage: ScanProgressChipStage;
  autoScrollEnabled: boolean;
  onBeforeAutoScroll?: () => void;
}

const Chip = forwardRef<HTMLDivElement, ChipProps>(function Chip(
  { stage, autoScrollEnabled, onBeforeAutoScroll },
  _outerRef,
) {
  const { status, label } = stage;
  const ref = useRef<HTMLDivElement | null>(null);
  const mountedAutoScrolledRef = useRef(false);

  useEffect(() => {
    // Auto-scroll fires exactly once — when the chip first mounts. We
    // intentionally do NOT re-scroll on status transitions (in_progress
    // → completed) since the user already saw the chip enter view.
    if (mountedAutoScrolledRef.current) return;
    mountedAutoScrolledRef.current = true;
    if (!autoScrollEnabled) return;
    const node = ref.current;
    if (!node || typeof node.scrollIntoView !== "function") return;
    try {
      onBeforeAutoScroll?.();
      node.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch {
      // Older browsers may throw on the options object — fall back to
      // the no-arg form so the chip is at least scrolled into the
      // nearest ancestor's visible area.
      try {
        node.scrollIntoView();
      } catch {
        /* ignore — auto-scroll is best effort */
      }
    }
  }, [autoScrollEnabled, onBeforeAutoScroll]);

  return (
    <div
      ref={ref}
      className={cn(
        "inline-flex items-center gap-2.5 self-start",
        "rounded-full border px-3.5 py-2",
        "text-sm font-medium transition-colors duration-300",
        // PR P — fade + small Y translate on mount. Tailwind's built-in
        // `animate-in` (tw-animate plugin) is used elsewhere in this
        // app; falling back to inline keyframes via animation utility
        // classes keeps the motion vocabulary consistent.
        "scan-chip-mount",
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
});

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
//
// PR P — the Scan page no longer pre-renders this whole array as
// `pending` chips. Chips mount progressively as `{stage, status:
// 'in_progress'}` events arrive. The constant is kept for tests and
// for callers that want to render the full stack up front.
export const DEFAULT_SCAN_STAGES: ScanProgressChipStage[] = [
  { id: "analyzing_card", label: "Analyzing card", status: "pending" },
  { id: "detecting_parallel", label: "Detecting parallel", status: "pending" },
  { id: "verifying_with_ebay", label: "Looking for active eBay listings", status: "pending" },
  { id: "getting_price", label: "Getting price", status: "pending" },
];

// PR P — id → label map used by the Scan page when minting a chip from
// the first `in_progress` event. Stable to the labels above so the
// progressive reveal renders the same wording the original static list
// used.
export const SCAN_STAGE_LABELS: Record<string, string> = {
  analyzing_card: "Analyzing card",
  detecting_parallel: "Detecting parallel",
  verifying_with_ebay: "Looking for active eBay listings",
  getting_price: "Getting price",
};
