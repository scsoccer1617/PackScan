import { Link, useLocation } from "wouter";
import { ScanLine, LayoutGrid, FileSpreadsheet, BarChart3, User as UserIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Redesign bottom nav. 5 tabs, Scan is primary (violet foil underline when
 * active). Routes map to existing pages:
 *   Scan       -> /scan       (PriceLookup, rebuilt in PR #2b)
 *   Collection -> /collection (existing Collection.tsx, rewired here)
 *   Sheets     -> /sheets     (MySheets)
 *   Stats      -> /stats      (existing Stats.tsx)
 *   Profile    -> /account    (AccountSettings)
 *
 * "/" (Home) highlights the Scan tab per prototype behavior since Home's
 * primary affordance is the scan CTA.
 */

const TABS = [
  { href: "/scan", label: "Scan", icon: ScanLine, primary: true },
  { href: "/collection", label: "Collection", icon: LayoutGrid },
  { href: "/sheets", label: "Sheets", icon: FileSpreadsheet },
  { href: "/stats", label: "Stats", icon: BarChart3 },
  { href: "/account", label: "Profile", icon: UserIcon },
];

export default function BottomTabs() {
  const [location] = useLocation();
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-card-border bg-paper/95 backdrop-blur"
      aria-label="Primary"
    >
      <div className="mx-auto max-w-lg grid grid-cols-5 h-[68px] pb-[env(safe-area-inset-bottom)]">
        {TABS.map((t) => {
          // The Scan tab covers the picker at /scan plus its capture
          // children (/scan/camera, /scan/camera?...), and Home treats
          // Scan as the active tab since its hero CTA is the scan flow.
          const active =
            location === t.href ||
            (t.href === "/scan" &&
              (location === "/" || location.startsWith("/scan")));
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                "flex flex-col items-center justify-center gap-1 relative",
                active ? "text-ink" : "text-slate-500"
              )}
              data-testid={`tab-${t.label.toLowerCase()}`}
            >
              {t.primary && active && (
                <span
                  aria-hidden
                  className="absolute -top-px left-1/2 -translate-x-1/2 h-0.5 w-10 rounded-full bg-foil"
                />
              )}
              <Icon
                className={cn(
                  "w-[22px] h-[22px]",
                  active && t.primary && "text-foil-violet"
                )}
                strokeWidth={active ? 2.25 : 1.75}
              />
              <span
                className={cn(
                  "text-[11px] leading-none",
                  active ? "font-medium" : "font-normal"
                )}
              >
                {t.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
