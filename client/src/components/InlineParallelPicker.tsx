import { forwardRef, useEffect, useRef } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

// PR Q — Inline pre-result variant preview. Renders as soon as the
// streaming SSE stage 2 ("Detecting parallel") completes, BEFORE
// stages 3/4 (eBay listings + price) finish. The user gets immediate
// confirmation that the variant has been detected; the post-completion
// full picker on /result is unchanged.
//
// Spec (locked):
// - ALWAYS show on detection, even when variant is null/empty (we render
//   "Base" so the user has feedback that detection finished).
// - If a later stage corrects the identity (search-verify), the parent
//   updates `variant` and the picker mutates in place — same DOM node,
//   no flash/remount.
// - Same fade+translate motion vocabulary as the chip stack
//   (`scan-chip-mount` honors `prefers-reduced-motion`).

export interface InlineParallelPickerProps {
  /** Detected variant / parallel name from the SSE
   *  detecting_parallel:completed event. Null/empty renders as "Base". */
  variant: string | null;
  /** Visual foil type, when set. Display-only — variant takes
   *  precedence when both are present. */
  foilType?: string | null;
  /** Optional 0..1 confidence score from the analyzer. Rendered as a
   *  small chip when present and ≥ 0.5. */
  confidence?: number | null;
  /** When true the parent's auto-scroll guard hasn't tripped — the
   *  picker mounts and scrolls itself into view on first appearance.
   *  Mirror of the prop ScanProgressChips uses. */
  autoScrollEnabled?: boolean;
  /** Mirror of the chip-stack hook so the parent can flip the
   *  programmatic-scroll flag on its user-scroll detector. */
  onBeforeAutoScroll?: () => void;
}

function displayLabel(variant: string | null, foilType: string | null | undefined): string {
  const v = (variant ?? "").trim();
  if (v) return v;
  const f = (foilType ?? "").trim();
  if (f) return f;
  return "Base";
}

function confidenceLabel(confidence: number | null | undefined): string | null {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  if (confidence >= 0.85) return "High confidence";
  if (confidence >= 0.6) return "Likely";
  return null;
}

export const InlineParallelPicker = forwardRef<
  HTMLDivElement,
  InlineParallelPickerProps
>(function InlineParallelPicker(
  { variant, foilType, confidence, autoScrollEnabled = true, onBeforeAutoScroll },
  _outerRef,
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mountedAutoScrolledRef = useRef(false);

  useEffect(() => {
    // Auto-scroll fires exactly once on first mount — same contract
    // ScanProgressChips uses. Variant updates from later stages (e.g.
    // search-verify identity correction) reuse the same DOM node and
    // do not re-trigger scroll.
    if (mountedAutoScrolledRef.current) return;
    mountedAutoScrolledRef.current = true;
    if (!autoScrollEnabled) return;
    const node = ref.current;
    if (!node || typeof node.scrollIntoView !== "function") return;
    try {
      onBeforeAutoScroll?.();
      node.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch {
      try {
        node.scrollIntoView();
      } catch {
        /* best effort */
      }
    }
  }, [autoScrollEnabled, onBeforeAutoScroll]);

  const label = displayLabel(variant, foilType);
  const isBase = label === "Base";
  const confLabel = confidenceLabel(confidence);

  return (
    <div
      ref={ref}
      data-testid="inline-parallel-picker"
      data-variant={variant ?? ""}
      className={cn(
        "scan-chip-mount",
        "rounded-2xl border bg-white px-3.5 py-3",
        "flex items-center gap-3",
        isBase ? "border-slate-200" : "border-emerald-300/70",
      )}
    >
      <span
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-full",
          isBase ? "bg-slate-100 text-slate-500" : "bg-emerald-50 text-emerald-600",
        )}
        aria-hidden
      >
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">
          Potential variant
        </p>
        <p
          className="font-display text-base font-semibold text-ink truncate"
          data-testid="inline-parallel-picker-label"
        >
          {label}
        </p>
      </div>
      {confLabel && !isBase && (
        <span
          className="rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-semibold px-2 py-1"
          data-testid="inline-parallel-picker-confidence"
        >
          {confLabel}
        </span>
      )}
    </div>
  );
});
