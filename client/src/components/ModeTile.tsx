// Entry-point tile used on Home + /scan picker to choose how a card lookup
// starts. Three instances render side-by-side: Scan (front & back photos),
// Voice (speak it), Manual (type it). Tones are intentionally differentiated
// so each path feels distinct while keeping the same tile silhouette.
//
//   primary          → Scan. Foil gradient + grade halo + shimmer.
//   tone="voice"     → Voice. Green foil tint on a light surface.
//   tone="manual"    → Manual. Amber foil tint on a light surface.
//   (default)        → Neutral white surface (legacy fallback).

import { Link } from "wouter";
import { cn } from "@/lib/utils";

type Tone = "voice" | "manual";

interface ModeTileProps {
  href: string;
  icon: React.ReactNode;
  label: string;
  hint: string;
  /** Primary tile uses the foil gradient + halo (Scan). */
  primary?: boolean;
  /** Optional tinted variant for the non-primary tiles. */
  tone?: Tone;
  /** Bump heights for the full-screen picker use-case. */
  size?: "sm" | "lg";
  testId: string;
}

export default function ModeTile({
  href,
  icon,
  label,
  hint,
  primary = false,
  tone,
  size = "sm",
  testId,
}: ModeTileProps) {
  const heightClass = size === "lg" ? "h-[140px]" : "h-[104px]";

  // Tone styling for non-primary tiles. Each tone gets a tinted background,
  // matching icon wash, and a tone-colored label so Voice/Manual feel
  // distinct from each other while staying lighter than the Scan foil.
  const toneClasses: Record<Tone, { wrap: string; iconWrap: string; label: string; hint: string }> = {
    voice: {
      wrap: "bg-foil-green/10 text-ink border-foil-green/25 hover:border-foil-green/40 active:bg-foil-green/15",
      iconWrap: "bg-foil-green/15 text-foil-green",
      label: "text-ink",
      hint: "text-foil-green/80",
    },
    manual: {
      wrap: "bg-foil-amber/10 text-ink border-foil-amber/25 hover:border-foil-amber/40 active:bg-foil-amber/15",
      iconWrap: "bg-foil-amber/15 text-foil-amber",
      label: "text-ink",
      hint: "text-foil-amber/80",
    },
  };
  const t = !primary && tone ? toneClasses[tone] : null;

  return (
    <Link
      href={href}
      data-testid={testId}
      className={cn(
        "group relative flex flex-col items-center justify-center gap-1.5 rounded-2xl px-2 border transition overflow-hidden",
        heightClass,
        primary
          ? "bg-foil text-white border-transparent grade-halo foil-shimmer"
          : t
            ? t.wrap
            : "bg-white text-ink border-card-border hover:border-slate-300 active:bg-slate-50",
      )}
    >
      <div
        className={cn(
          "w-10 h-10 rounded-full flex items-center justify-center",
          primary
            ? "bg-white/20"
            : t
              ? t.iconWrap
              : "bg-muted text-ink group-hover:bg-slate-200",
        )}
      >
        {icon}
      </div>
      <div className="flex flex-col items-center leading-tight">
        <span
          className={cn(
            "font-display text-sm font-semibold",
            t && t.label,
          )}
        >
          {label}
        </span>
        <span
          className={cn(
            "text-[10px] uppercase tracking-wider font-semibold mt-0.5",
            primary ? "text-white/75" : t ? t.hint : "text-slate-400",
          )}
        >
          {hint}
        </span>
      </div>
    </Link>
  );
}
