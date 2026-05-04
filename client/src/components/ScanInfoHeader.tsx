import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// PR R Item 4 — streaming card-info header. Renders a result-style
// identity line above the chip stack while the scan is in flight.
//
// PR S Item 1 — sequenced reveal. Gemini returns the stage-1 OCR result
// as a single JSON blob, so all five fields land in one `setFields()`
// call on the parent. To avoid the "pop back all at once" feel, the
// header reveals each field one by one in reading order
// (Year → Brand → Set → Collection → # → Player). Honors
// `prefers-reduced-motion` — users with that setting see all fields
// rendered immediately.
//
// PR S Item 2 — adds a separate `collection` field rendered between
// `set` and `cardNumber`. Set is the product line ("Update Series");
// collection is the parallel/variant within the set ("Base Set",
// "Pink Sparkle", "Gold"). They're two distinct fields in the data
// model so we render two distinct slots — even if one is empty.
//
// PR T Item 2 — diagnosed user report ("fields appear all at once,
// stagger not visible"). Root cause: the stagger logic IS firing, but
// the per-field 150ms fade combined with a 160ms tick made the total
// reveal complete in ~800ms with a 4px translate that was hard to
// perceive on a phone screen. Two changes:
//   1. Default stagger bumped from 160ms → 200ms (total reveal now
//      ~1s end-to-end across 6 fields).
//   2. Per-field CSS animation lengthened to 280ms with an 8px
//      translate so each field's entrance is visibly distinct from
//      the next. Reduced-motion still bypasses the animation.

export interface ScanInfoHeaderFields {
  year?: number | string | null;
  brand?: string | null;
  set?: string | null;
  collection?: string | null;
  cardNumber?: string | null;
  player?: string | null;
}

interface ScanInfoHeaderProps {
  fields: ScanInfoHeaderFields;
  /** When false, suppresses the skeletons and renders only the
   *  populated fields (used after the final result lands). */
  showSkeletons?: boolean;
  /** Stagger between successive fields during the sequenced reveal,
   *  in milliseconds. Defaults to 200ms (PR T — bumped from 160ms so
   *  the total reveal across 6 fields lands at ~1s instead of ~800ms,
   *  which the user reported as imperceptible on phone). Tests can
   *  pass `0` to short-circuit the animation. */
  revealStaggerMs?: number;
  /** Override prefers-reduced-motion detection. Tests can force
   *  immediate reveal regardless of media query state. */
  forceReducedMotion?: boolean;
}

// Field render order. Pure constant so tests can import it directly
// to assert sequencing.
export const SCAN_INFO_HEADER_FIELD_ORDER = [
  "year",
  "brand",
  "set",
  "collection",
  "cardNumber",
  "player",
] as const;
export type ScanInfoHeaderFieldKey =
  (typeof SCAN_INFO_HEADER_FIELD_ORDER)[number];

// Pure helper: given the count of fields that have arrived from the
// stream and the index of the field, decide if it should be revealed
// at this moment. Exported for tests.
export function shouldRevealFieldAt(args: {
  fieldIndex: number;
  revealedCount: number;
}): boolean {
  return args.fieldIndex < args.revealedCount;
}

// Pure helper: detect whether the user has reduced-motion enabled.
// Pulled out so the test can stub the matchMedia call.
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
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
      <span data-testid={testId} className="text-ink scan-field-reveal">
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

// Hidden placeholder rendered for fields that are KNOWN (have a value)
// but not yet revealed by the sequenced animation. Same layout slot as
// the populated value so the line doesn't reflow as fields stream in;
// `visibility: hidden` keeps it invisible without removing its box.
function hiddenPlaceholder(width: string, testId: string): JSX.Element {
  return (
    <span
      data-testid={`${testId}-pending`}
      className={cn("inline-block align-middle h-3.5", width)}
      style={{ visibility: "hidden" }}
      aria-hidden
    />
  );
}

export function ScanInfoHeader({
  fields,
  showSkeletons = true,
  revealStaggerMs = 200,
  forceReducedMotion,
}: ScanInfoHeaderProps) {
  const { year, brand, set, collection, cardNumber, player } = fields;
  const cardNumDisplay =
    cardNumber == null
      ? null
      : String(cardNumber).startsWith("#")
        ? String(cardNumber)
        : `#${cardNumber}`;

  // Sequenced reveal state. We only animate the FIRST time stage-1
  // fields arrive — once `revealedCount` reaches 6 (all fields in
  // SCAN_INFO_HEADER_FIELD_ORDER), it stays there. Reveal kicks off
  // when at least one field is non-empty.
  const totalFields = SCAN_INFO_HEADER_FIELD_ORDER.length;
  const reduced = forceReducedMotion ?? prefersReducedMotion();
  const [revealedCount, setRevealedCount] = useState(0);
  const startedRef = useRef(false);

  // Has stage-1 landed? We treat "any of the six fields is populated"
  // as the trigger; in practice the server emits all of them in one
  // analyzing_card:completed event so they all land together.
  const anyFieldPresent = [
    year,
    brand,
    set,
    collection,
    cardNumDisplay,
    player,
  ].some((v) => v != null && String(v).trim() !== "");

  useEffect(() => {
    if (!anyFieldPresent) return;
    if (startedRef.current) return;
    startedRef.current = true;
    if (reduced) {
      // Reduced motion: skip the stagger entirely.
      setRevealedCount(totalFields);
      return;
    }
    // Reveal field 0 immediately (so the first field doesn't lag), then
    // tick subsequent fields on the configured cadence. Total duration
    // is roughly (totalFields - 1) * stagger ≈ 800ms at the default.
    setRevealedCount(1);
    if (revealStaggerMs <= 0) {
      setRevealedCount(totalFields);
      return;
    }
    let i = 1;
    const id = window.setInterval(() => {
      i += 1;
      setRevealedCount((c) => Math.min(totalFields, Math.max(c, i)));
      if (i >= totalFields) window.clearInterval(id);
    }, revealStaggerMs);
    return () => window.clearInterval(id);
  }, [anyFieldPresent, reduced, revealStaggerMs, totalFields]);

  // Per-field render: while a known value is "pending reveal", swap the
  // text for an invisible-but-same-width placeholder so the line keeps
  // its layout. Skeletons (no value yet) keep their existing pulse.
  const renderField = (
    key: ScanInfoHeaderFieldKey,
    value: string | number | null | undefined,
    width: string,
    testId: string,
  ): JSX.Element => {
    const idx = SCAN_INFO_HEADER_FIELD_ORDER.indexOf(key);
    const visible = shouldRevealFieldAt({ fieldIndex: idx, revealedCount });
    const hasValue = value != null && String(value).toString().trim() !== "";
    if (hasValue && !visible) return hiddenPlaceholder(width, testId);
    return fieldOrSkeleton(value, width, showSkeletons, testId);
  };

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
        {renderField("year", year, "w-10", "scan-info-header-year")}{" "}
        {renderField("brand", brand, "w-16", "scan-info-header-brand")}{" "}
        <span className="text-slate-400">·</span>{" "}
        {renderField("set", set, "w-20", "scan-info-header-set")}{" "}
        <span className="text-slate-400">·</span>{" "}
        {renderField(
          "collection",
          collection,
          "w-20",
          "scan-info-header-collection",
        )}{" "}
        <span className="text-slate-400">·</span>{" "}
        {renderField(
          "cardNumber",
          cardNumDisplay,
          "w-12",
          "scan-info-header-card-number",
        )}{" "}
        <span className="text-slate-400">·</span>{" "}
        {renderField("player", player, "w-32", "scan-info-header-player")}
      </p>
    </div>
  );
}
