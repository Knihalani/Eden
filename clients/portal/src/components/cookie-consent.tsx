"use client";

/**
 * CookieConsent — GDPR / CCPA cookie banner.
 *
 * The portal gates analytics + marketing tags behind explicit consent
 * per the privacy policy. The banner is suppressed once the user has
 * made a choice (stored in ``localStorage.eden_cookie_consent``).
 *
 * Non-essential cookies (analytics, marketing) are NOT set until the
 * user accepts. The default state is "declined" — accepting
 * explicitly opts the user in. After a choice, a compact
 * "Cookie preferences" control re-opens the banner so the user can
 * accept, decline, or withdraw consent without leaving the page.
 *
 * Layout / reading flow:
 *
 * The banner is ``position: fixed`` at the viewport bottom. The
 * previous implementation reserved 128px of body padding-bottom
 * via ``--cookie-banner-offset`` so the very end of the document
 * wouldn't be hidden, but mid-page reading was still broken — the
 * fixed banner always sat over the bottom 128px of the viewport,
 * blocking whatever the user was trying to read (privacy section 3,
 * docs endpoint cards, marketing FAQ answers, etc.). The pointer-
 * events-none wrapper meant the user couldn't even scroll past the
 * hidden content.
 *
 * The fix is three-fold:
 *
 * 1. The banner auto-collapses to a small floating pill after the
 *    user scrolls past ~30% of the document. Reading flow is no
 *    longer blocked because the pill is ~36px tall instead of ~96px.
 *    The pill keeps the choice reachable inline; an explicit chevron
 *    expands it back to the full banner for users who want the
 *    longer copy.
 *
 * 2. On short pages (little or no scroll room), the banner starts
 *    collapsed as a pill immediately — the full banner would
 *    otherwise sit on top of primary CTAs (Start free, Open email,
 *    BottomCta) with nowhere to scroll them clear.
 *
 * 3. ``--cookie-banner-offset`` tracks the *visible* chrome: full
 *    banner height while expanded, pill height while collapsed, so
 *    the document end (and short-page CTAs) stay above the overlay.
 *
 * Accessibility: the banner is a ``role="dialog"`` with
 * ``aria-live="polite"`` and an "Accept" button as the primary
 * focusable element on mount.
 *
 * Ponytail: useState + useEffect + localStorage + a rAF-throttled
 * scroll/resize listener for the auto-collapse. No external consent library.
 */

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  applyAnalyticsConsent,
  bootAnalyticsFromStoredConsent,
  COOKIE_CONSENT_KEY,
  type ConsentValue,
} from "@/lib/analytics";
import { isAuthPath } from "@/lib/auth-redirect";
import {
  CHROME_BANNER_ATTR,
  ERROR_STATE_ATTR,
  shouldDeferBlockingOverlays,
} from "@/lib/overlay-defer";

const STORAGE_KEY = COOKIE_CONSENT_KEY;
/** Pill (collapsed) reserves a slim strip so the bottom edge of the
 * document isn't flush against the pill. */
const PILL_OFFSET_PX = 56;
/**
 * Full banner + safe breathing room (stacked copy + actions on
 * mobile can exceed ~120px). Used while the expanded dialog is
 * showing so short-page CTAs aren't trapped under it.
 */
const FULL_BANNER_OFFSET_PX = 168;
/**
 * Auto-collapse once the user has scrolled past this fraction of
 * the document. 30% reads as "engaged but not yet at the bottom"
 * — earlier than that the user is still orienting themselves and
 * should see the full banner; later than that they should be able
 * to read without the banner blocking anything.
 *
 * ``COLLAPSE_MIN_PX`` is an absolute floor on *long* pages: on short
 * pages the 30% threshold would mean collapsing only after a tiny
 * scroll. Short pages are handled separately via
 * ``SHORT_PAGE_MAX_SCROLLABLE_PX`` (collapse immediately).
 */
const COLLAPSE_SCROLL_FRACTION = 0.3;
const COLLAPSE_MIN_PX = 240;
/**
 * If the document has this little (or less) scroll room, treat it
 * as a short page and start in pill mode so primary CTAs stay
 * clickable without requiring scroll the page doesn't have.
 */
const SHORT_PAGE_MAX_SCROLLABLE_PX = 320;

export function CookieConsent() {
  const pathname = usePathname() ?? "";
  const onAuthRoute = isAuthPath(pathname);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);
  const [hasChoice, setHasChoice] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const showFull = !collapsed || expanded;

  // Reserve body padding for whichever chrome is actually showing.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (visible) {
      document.documentElement.style.setProperty(
        "--cookie-banner-offset",
        `${showFull ? FULL_BANNER_OFFSET_PX : PILL_OFFSET_PX}px`,
      );
    } else {
      document.documentElement.style.setProperty(
        "--cookie-banner-offset",
        "0px",
      );
    }
    return () => {
      document.documentElement.style.setProperty(
        "--cookie-banner-offset",
        "0px",
      );
    };
  }, [visible, showFull]);

  // Scroll/resize-driven collapse: long pages collapse after the
  // user scrolls; short pages collapse immediately so CTAs aren't
  // occluded. Expanded state always wins for showFull via OR.
  useEffect(() => {
    if (!visible) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - window.innerHeight;
      // Short page (including no-scroll): auto-collapse to pill.
      // Previously this branch forced collapsed=false, which left
      // the full banner covering primary CTAs with nowhere to go.
      if (scrollable <= SHORT_PAGE_MAX_SCROLLABLE_PX) {
        setCollapsed(true);
        return;
      }
      const ratio = window.scrollY / scrollable;
      setCollapsed(
        ratio > COLLAPSE_SCROLL_FRACTION ||
          window.scrollY > COLLAPSE_MIN_PX,
      );
    };
    const onScrollOrResize = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [visible]);

  useEffect(() => {
    // F3: don't show the banner on auth routes — the cookie choice
    // belongs to the portal, not the sign-in/sign-up surface.
    // Re-run on pathname so client navigations into/out of auth
    // (marketing → /sign-in) hide/show correctly.
    if (onAuthRoute) {
      bootAnalyticsFromStoredConsent();
      setVisible(false);
      setExpanded(false);
      setReady(true);
      return;
    }
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "accepted" || stored === "declined") {
        setHasChoice(true);
        bootAnalyticsFromStoredConsent();
        setReady(true);
        return;
      }
      // No prior choice → show the banner after paint, but defer while
      // session / ErrorState chrome owns attention (avoids overlay pile-up).
      let cancelled = false;
      let showTimer: number | undefined;
      const tryShow = () => {
        if (cancelled) return;
        if (shouldDeferBlockingOverlays()) {
          setReady(true);
          setVisible(false);
          return;
        }
        if (showTimer != null) window.clearTimeout(showTimer);
        showTimer = window.setTimeout(() => {
          if (cancelled || shouldDeferBlockingOverlays()) return;
          setVisible(true);
          setReady(true);
        }, 600);
      };
      tryShow();
      const observer = new MutationObserver(() => {
        if (cancelled) return;
        if (shouldDeferBlockingOverlays()) {
          if (showTimer != null) window.clearTimeout(showTimer);
          setVisible(false);
          return;
        }
        // Banner was deferred — reveal once blockers clear (if still undecided).
        if (!window.localStorage.getItem(STORAGE_KEY)) {
          tryShow();
        }
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: [CHROME_BANNER_ATTR],
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [ERROR_STATE_ATTR],
      });
      return () => {
        cancelled = true;
        if (showTimer != null) window.clearTimeout(showTimer);
        observer.disconnect();
      };
    } catch {
      // localStorage blocked (private mode, etc.) → don't show
      // the banner (we can't persist the choice either way).
      setReady(true);
    }
  }, [onAuthRoute]);

  const set = (value: ConsentValue) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // ignored
    }
    applyAnalyticsConsent(value);
    setHasChoice(true);
    setVisible(false);
    setExpanded(false);
  };

  const openPreferences = () => {
    setCollapsed(false);
    setExpanded(true);
    setVisible(true);
  };

  // Auth routes: nothing to render (choice deferred to portal).
  if (onAuthRoute) return null;

  // Compact re-open control after a choice — honest withdraw path.
  if (ready && hasChoice && !visible) {
    return (
      <div
        className="pointer-events-none fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom)+0.75rem)] lg:bottom-4 flex justify-end px-4"
        style={{ zIndex: "var(--z-cookie)" }}
      >
        <button
          type="button"
          onClick={openPreferences}
          className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)]/95 px-3 min-h-[44px] text-[11px] font-medium text-[var(--text-secondary)] shadow-lg backdrop-blur transition-colors hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-[var(--text-muted)]" />
          Cookie preferences
        </button>
      </div>
    );
  }

  if (!visible) return null;

  // Pointer-events-none on the wrapper preserves page scroll;
  // the inner card opts back in so the buttons + link remain
  // clickable. The banner is a sibling of the page chrome (root
  // layout) and uses --z-cookie (below dialogs at z-50) so
  // modals are never occluded by the consent chrome.
  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Cookie consent"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom)+0.75rem)] lg:bottom-4 flex justify-center px-4"
      style={{ zIndex: "var(--z-cookie)" }}
    >
      <div
        className={
          // Pill: collapsed, compact, single line.
          !showFull
            ? "pointer-events-auto inline-flex items-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)]/95 px-3 py-1.5 shadow-lg backdrop-blur"
            : // Full banner: expanded, multi-line, max-w-2xl.
              "pointer-events-auto w-full max-w-2xl rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)]/95 px-4 py-3 shadow-2xl backdrop-blur"
        }
      >
        {!showFull ? (
          // Compact pill — single line, ~36px tall. Expand chevron
          // returns the user to the full banner copy.
          <>
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-[var(--warning)]" />
            <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-secondary)]">
              Cookies
            </span>
            <button
              type="button"
              onClick={() => set("declined")}
              className="rounded-full px-3 min-h-[44px] text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              Decline
            </button>
            <button
              type="button"
              onClick={() => set("accepted")}
              className="rounded-full border border-[var(--accent)] bg-[var(--accent)] px-3 min-h-[44px] text-[11px] font-medium text-[var(--bg-base)] transition-colors hover:bg-[var(--accent-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label="Show cookie details"
              className="ml-1 inline-flex items-center justify-center rounded-full min-h-[44px] min-w-[44px] p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </>
        ) : (
          // Full banner — same content as before. The button group
          // stays at md+ and stacks on mobile.
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
            <div className="flex-1 min-w-0 text-sm text-[var(--text-secondary)]">
              <p className="font-medium text-[var(--text-primary)]">
                Cookies & analytics
              </p>
              <p className="mt-0.5 leading-relaxed text-[13px]">
                Eden uses essential cookies to keep you signed in. With
                your consent we also use analytics cookies to understand
                how the portal is used. You can change or withdraw this
                any time via Cookie preferences.
              </p>
            </div>
            <div className="flex items-center gap-2 md:flex-shrink-0">
              {collapsed && (
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  aria-label="Collapse cookie details"
                  className="inline-flex items-center justify-center rounded-md min-h-[44px] min-w-[44px] p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="18 15 12 9 6 15" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                onClick={() => set("declined")}
                className="rounded-md border border-[var(--border-subtle)] px-3 min-h-[44px] text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => set("accepted")}
                className="rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 min-h-[44px] text-xs font-medium text-[var(--bg-base)] transition-colors hover:bg-[var(--accent-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]"
              >
                Accept
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
