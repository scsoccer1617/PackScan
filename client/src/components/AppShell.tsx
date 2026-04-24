import { ReactNode } from "react";
import TopBar from "./TopBar";
import BottomTabs from "./BottomTabs";
import ScrollToTop from "./ScrollToTop";

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
      {/* Reset scroll on every route change — wouter doesn't do this by
          default and without it the viewport keeps the previous page's
          scroll offset, so tapping a tab can land mid-page. */}
      <ScrollToTop />
      <TopBar />
      <main className="flex-1 pb-[84px] mx-auto w-full max-w-lg">
        {children}
      </main>
      <BottomTabs />
    </div>
  );
}
