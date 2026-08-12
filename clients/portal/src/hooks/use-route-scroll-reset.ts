"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * Route-change chrome for the portal shell.
 *
 * The app scrolls a custom `<main>` container (not the document), so
 * Next.js's built-in scroll restoration does nothing: navigating from a
 * scrolled-down traces list to Issues used to land you mid-page on the
 * new route. This hook fixes that — on every pathname change it returns
 * the main container to the top and moves focus to it, so keyboard and
 * screen-reader users land on the new page's content instead of being
 * stranded on the sidebar link that triggered the navigation.
 *
 * Guards:
 * - **First render** — never scroll/focus on initial load; the browser
 *   already paints at the top and focus should stay on the address bar.
 * - **Modal open** — when `[role="dialog"][aria-modal="true"]` is on
 *   screen (product tour, alerts modal, ⌘K, mobile More sheet), the
 *   modal owns focus and often its own scrolling; the shell must not
 *   fight it. The command palette is exempt in practice because it
 *   closes before the navigated route commits.
 *
 * Keyed on `pathname` only — search-param-only changes (`?id=`, `?view=`)
 * never reset scroll, so picking a trace in a feed or flipping the
 * sessions lens keeps your place.
 */
export function useRouteScrollReset(
  mainRef: React.RefObject<HTMLElement | null>,
): void {
  const pathname = usePathname() ?? "";
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (typeof document === "undefined") return;
    // A modal dialog (tour / alerts / palette / mobile sheet) owns focus
    // and its own scrolling — never yank either away mid-navigation.
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
      return;
    }
    const main = mainRef.current;
    if (!main) return;
    main.scrollTo({ top: 0, left: 0 });
    // Programmatic focus on a `tabIndex={-1}` container: screen readers
    // announce the new page's main region, keyboard users continue from
    // content, and mouse users never see a ring (no :focus-visible match).
    main.focus({ preventScroll: true });
  }, [pathname, mainRef]);
}
