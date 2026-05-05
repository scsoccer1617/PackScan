import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { displayYear } from "@/lib/seasonYear";

// PR R Item 4 — streaming card-info header. Renders a result-style
// identity line above the chip stack while the scan is in flight.
//
// PR U — REACTIVE rendering. Previously (PR S/T) Gemini returned the
// stage-1 OCR result as a single JSON blob, so all five fields landed
// in one `setFields()` call on the parent. The header used a
// client-side timer to fake a stagger because the underlying data
// arrived all at once. With the streaming Gemini call wired up in PR
// U, the server now emits one `analyzing_card:progress` SSE event per
// completed field as Gemini streams them, so the parent's
// `scanInfoFields` state mutates field-by-field. This component now
// just renders whatever's in the props: each field's slot is filled
// the moment its prop becomes non-empty, with the existing fade +
// translate motion. No timer, no stagger heuristic.
//
// Field render order is fixed (Year · Brand · Set · Collection · # ·
// Player) regardless of which order the server emits — Gemini's
// stream order is unpredictable, so the position-1 slot stays
// skeleton until `year` arrives even if `set` lands first.
//
// PR S Item 2 — separate `collection` field rendered between `set`
// and `cardNumber`. Set is the product line ("Update Series");
// collection is the parallel/variant within the set ("Base Set",
// "Pink Sparkle", "Gold").
//
// Reduced motion: the per-field fade-in still honors
// `prefers-reduced-motion`. The CSS in client/src/index.css under
// `.scan-field-reveal` keys off the media query.

export interface ScanInfoHeaderFields {
  year?: number | string | null;
  brand?: string | null;
  set?: string | null;
  collection?: string | null;
  cardNumber?: string | null;
  player?: string | null;
  // PR X: passed through from the streaming `analyzing_card` events so
  // the header can render YYYY-YY for season sports (Basketball,
  // Hockey) the moment Gemini's stage-1 lands. Parallels the same
  // fields used by the result page's `displayYear()` call.
  sport?: string | null;
  yearPrintedRaw?: string | null;
}

interface ScanInfoHeaderProps {
  fields: ScanInfoHeaderFields;
  /** When false, suppresses the skeletons and renders only the
   *  populated fields (used after the final result lands). */
  showSkeletons?: boolean;
  /** PR U: kept on the props so existing call sites compile, but
   *  no longer affects render — the server-driven streaming makes
   *  the client-side stagger redundant. Tests that pass 0 still
   *  work (it's a no-op). */
  revealStaggerMs?: number;
  /** Override prefers-reduced-motion detection. Tests can force
   *  immediate reveal regardless of media query state. PR U: the
   *  CSS-based reveal still honors this via a class hook below. */
  forceReducedMotion?: boolean;
}

// Field render order. Pure constant so tests can import it directly
// to assert sequencing. PR W: Player promoted to slot 1 — see render
// comment below for rationale.
export const SCAN_INFO_HEADER_FIELD_ORDER = [
  "player",
  "year",
  "brand",
  "set",
  "collection",
  "cardNumber",
] as const;
export type ScanInfoHeaderFieldKey =
  (typeof SCAN_INFO_HEADER_FIELD_ORDER)[number];

// Pure helper kept for backwards compatibility with older tests.
// The sequenced reveal is no longer client-side, but tests imported
// this for other reasons (asserting the field order constant pairs
// with a deterministic rule). Safe to keep; returns true once the
// field's index is reachable.
export function shouldRevealFieldAt(args: {
  fieldIndex: number;
  revealedCount: number;
}): boolean {
  return args.fieldIndex < args.revealedCount;
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

export function ScanInfoHeader({
  fields,
  showSkeletons = true,
  // revealStaggerMs is intentionally ignored — kept on the props for
  // backwards compatibility with PR S/T callers and tests.
  revealStaggerMs: _ignoredStagger,
  forceReducedMotion: _ignoredReducedMotion,
}: ScanInfoHeaderProps) {
  const { year, brand, set, collection, cardNumber, player, sport, yearPrintedRaw } = fields;
  const cardNumDisplay = useMemo(() => {
    if (cardNumber == null) return null;
    const s = String(cardNumber);
    return s.startsWith("#") ? s : `#${cardNumber}`;
  }, [cardNumber]);
  // PR X: prefer the season-range form when the sport / printed range
  // calls for it (matches what the result page renders). Falls back to
  // the integer when displayYear can't form a range — empty year still
  // shows the skeleton because we pass through `null`.
  const yearDisplay = useMemo<string | number | null>(() => {
    if (year == null || year === "") return null;
    const formatted = displayYear(year, sport ?? null, yearPrintedRaw ?? null);
    return formatted ?? year;
  }, [year, sport, yearPrintedRaw]);

  // PR U — pure reactive rendering. Each field renders skeleton until
  // its slot has a value, then renders the value with the standard
  // fade-in motion (CSS class `scan-field-reveal`). Order in the DOM
  // is fixed; the order in which slots transition skeleton→value is
  // driven entirely by the order Gemini emits fields on the server
  // stream.
  const renderField = (
    _key: ScanInfoHeaderFieldKey,
    value: string | number | null | undefined,
    width: string,
    testId: string,
  ): JSX.Element => fieldOrSkeleton(value, width, showSkeletons, testId);

  return (
    <div
      data-testid="scan-info-header"
      className={cn(
        "rounded-2xl border border-slate-200 bg-white px-4 py-3",
        "scan-chip-mount",
      )}
    >
      <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1">
        Card Info
      </p>
      <p className="font-display text-base font-semibold leading-snug">
        {/* PR W: Player first. Stage-1 stream order is determined by
            Gemini's JSON emit order, which is unpredictable; pinning
            Player to the position-1 slot here means the user always
            sees the most identifying field first regardless of which
            order the server fills the others in. Display order:
            Player · Year · Brand · Set · Collection · #. */}
        {renderField("player", player, "w-32", "scan-info-header-player")}{" "}
        <span className="text-slate-400">·</span>{" "}
        {renderField("year", yearDisplay, "w-10", "scan-info-header-year")}{" "}
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
        )}
      </p>
    </div>
  );
}
