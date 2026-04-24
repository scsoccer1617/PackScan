// Entry-point tile used on Home to pick how the user looks up a card.
//
// Three instances render side-by-side: Scan (front & back photos), Voice
// (speak it), Manual (type it). The Scan tile is the primary action and uses
// the foil gradient + grade halo; the other two use a neutral surface.
//
// Navigation targets live on Home; this component is presentation-only so it
// can be reused from /scan later if we ever bring the tile chooser back.

import { Link } from "wouter";
import { cn } from "@/lib/utils";

interface ModeTileProps {
  href: string;
  icon: React.ReactNode;
  label: string;
  hint: string;
  /** Primary tile uses the foil gradient + halo (Scan). */
  primary?: boolean;
  testId: string;
}

export default function ModeTile({
  href,
  icon,
  label,
  hint,
  primary = false,
  testId,
}: ModeTileProps) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className={cn(
        "group relative flex flex-col items-center justify-center gap-1.5 rounded-2xl h-[104px] px-2 border transition overflow-hidden",
        primary
          ? "bg-foil text-white border-transparent grade-halo foil-shimmer"
          : "bg-white text-ink border-card-border hover:border-slate-300 active:bg-slate-50",
      )}
    >
      <div
        className={cn(
          "w-10 h-10 rounded-full flex items-center justify-center",
          primary ? "bg-white/20" : "bg-muted text-ink group-hover:bg-slate-200",
        )}
      >
        {icon}
      </div>
      <div className="flex flex-col items-center leading-tight">
        <span className="font-display text-sm font-semibold">{label}</span>
        <span
          className={cn(
            "text-[10px] uppercase tracking-wider font-semibold mt-0.5",
            primary ? "text-white/75" : "text-slate-400",
          )}
        >
          {hint}
        </span>
      </div>
    </Link>
  );
}
