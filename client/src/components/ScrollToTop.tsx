import { useEffect } from "react";
import { useLocation } from "wouter";

/**
 * Scrolls the window to the top every time the route changes. Wouter
 * doesn't do this automatically the way react-router's ScrollRestoration
 * does, so without this component the viewport keeps the scroll offset
 * from the previous page — i.e. tapping a bottom tab at scroll depth
 * 600px lands the user 600px down on the new page.
 *
 * Mount this once inside AppShell (above <main>) so it runs for every
 * authenticated page transition.
 */
export default function ScrollToTop() {
  const [location] = useLocation();

  useEffect(() => {
    // Use `auto` (instant) rather than `smooth` so the jump isn't visible
    // on what feels like a fresh page load — the old scroll position
    // flashing briefly before easing up would look worse than the bug.
    try {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    } catch {
      window.scrollTo(0, 0);
    }
  }, [location]);

  return null;
}
