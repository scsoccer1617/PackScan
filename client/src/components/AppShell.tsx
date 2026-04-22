import { ReactNode } from "react";
import TopBar from "./TopBar";
import BottomTabs from "./BottomTabs";

/**
 * Redesign shell for PackScan. Wraps every authenticated page in:
 *   TopBar (sticky, brand + profile)
 *   <main> (scrollable, max-w-lg mobile frame)
 *   BottomTabs (fixed, 5 tabs)
 *
 * `pb-[84px]` on <main> reserves space so the last row of content
 * isn't hidden behind BottomTabs (68px + 16px padding).
 */
export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-paper text-ink flex flex-col">
      <TopBar />
      <main className="flex-1 pb-[84px] mx-auto w-full max-w-lg">
        {children}
      </main>
      <BottomTabs />
    </div>
  );
}
