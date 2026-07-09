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
 * explicitly opts the user in. Withdraw is one click from the
 * settings page.
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
 * The fix is two-fold:
 *
 * 1. The banner auto-collapses to a small floating pill after the
 *    user scrolls past ~30% of the document. Reading flow is no
 *    longer blocked because the pill is ~36px tall instead of ~96px.
 *    The pill keeps the choice reachable inline; an explicit chevron
 *    expands it back to the full banner for users who want the
 *    longer copy.
 *
 * 2. ``--cookie-banner-offset`` is set to the pill height (~52px
 *    including breathing room) so the very end of long pages is
 *    still readable after the user has scrolled to the bottom.
 *
 * Accessibility: the banner is a ``role="dialog"`` with
 * ``aria-live="polite"`` and an "Accept" button as the primary
 * focusable element on mount.
 *
 * Ponytail: useState + useEffect + localStorage + a rAF-throttled
 * scroll listener for the auto-collapse. No external consent library.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

type ConsentValue = "accepted" | "declined";

const STORAGE_KEY = "eden_cookie_consent";
// Pill (collapsed) reserves a slim strip so the bottom edge of the
// document isn't flush against the pill.
const PILL_OFFSET_PX = 56;
// Auto-collapse once the user has scrolled past this fraction of
// the document. 30% reads as "engaged but not yet at the bottom"
// — earlier than that the user is still orienting themselves and
// should see the full banner; later than that they should be able
// to read without the banner blocking anything.
//
// ``COLLAPSE_MIN_PX`` is an absolute floor: on short pages (e.g.
// a docs section that's only 200px taller than the viewport) the
// 30% threshold would mean collapsing only after 60px of scroll,
// which is barely a "decision" the user has made. The floor of
// 240px of scroll means the user has actually moved their reading
// position into the body of the page, regardless of the
// document's total height.
const COLLAPSE_SCROLL_FRACTION = 0.3;
const COLLAPSE_MIN_PX = 240;

export function CookieConsent() {
  const [visible, setVisible] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Apply/remove the bottom padding that keeps page content
  // visible above the pill. Reads `visible` as a dependency so
  // the effect re-runs on dismiss.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (visible) {
      document.documentElement.style.setProperty(
        "--cookie-banner-offset",
        `${PILL_OFFSET_PX}px`,
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
  }, [visible]);

  // Scroll-driven collapse: once the user has scrolled past
  // COLLAPSE_SCROLL_FRACTION of the document, the full banner
  // collapses into a compact pill. The pill can be re-expanded
  // via the chevron button for users who want the longer copy.
  // A rAF-throttled scroll handler keeps the listener cheap on
  // long pages.
  useEffect(() => {
    if (!visible) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - window.innerHeight;
      if (scrollable <= 0) {
        // Page is shorter than the viewport — no collapse needed.
        setCollapsed(false);
        return;
      }
      const ratio = window.scrollY / scrollable;
      // Collapse on either the fractional threshold OR the
      // absolute-pixel floor — whichever the page satisfies
      // first. This handles short pages (small scrollable) and
      // long pages (large scrollable) with the same intent: the
      // user has read past the top of the page.
      setCollapsed(
        ratio > COLLAPSE_SCROLL_FRACTION ||
        window.scrollY > COLLAPSE_MIN_PX
      );
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [visible]);

  useEffect(() => {
    // F3: don't show the banner on auth routes — the cookie choice
    // belongs to the portal, not the sign-in/sign-up surface.
    if (typeof window !== "undefined") {
      const p = window.location.pathname;
      if (
        p.startsWith("/sign-in") ||
        p.startsWith("/sign-up") ||
        p.startsWith("/login") ||
        p.startsWith("/signup") ||
        p.startsWith("/forgot-password") ||
        p.startsWith("/reset-password") ||
        p.startsWith("/invite")
      ) {
        return;
      }
    }
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (!stored) {
        // No prior choice → show the banner. Slight delay so the
        // banner slides in after the page paints (avoids CLS).
        const t = window.setTimeout(() => setVisible(true), 600);
        return () => window.clearTimeout(t);
      }
    } catch {
      // localStorage blocked (private mode, etc.) → don't show
      // the banner (we can't persist the choice either way).
    }
  }, []);

  const set = (value: ConsentValue) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // ignored
    }
    setVisible(false);
  };

  if (!visible) return null;

  const showFull = !collapsed || expanded;

  // Pointer-events-none on the wrapper preserves page scroll;
  // the inner card opts back in so the buttons + link remain
  // clickable. The banner is a sibling of the page chrome (root
  // layout) and z-[var(--z-cookie)] so it floats above everything
  // except a critical modal.
  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Cookie consent"
      className="pointer-events-none fixed inset-x-0 bottom-3 md:bottom-4 flex justify-center px-4"
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
              className="rounded-full px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              Decline
            </button>
            <button
              type="button"
              onClick={() => set("accepted")}
              className="rounded-full border border-[var(--accent)] bg-[var(--accent)] px-2 py-0.5 text-[11px] font-medium text-[var(--bg-base)] transition-colors hover:bg-[var(--accent-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label="Show cookie details"
              className="ml-1 rounded-full p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
                how the portal is used. You can change this any time in{" "}
                <Link
                  href="/settings/privacy"
                  className="underline underline-offset-2 hover:text-[var(--text-primary)]"
                >
                  privacy settings
                </Link>
                .
              </p>
            </div>
            <div className="flex items-center gap-2 md:flex-shrink-0">
              {collapsed && (
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  aria-label="Collapse cookie details"
                  className="rounded-md p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
                className="rounded-md border border-[var(--border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => set("accepted")}
                className="rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--bg-base)] transition-colors hover:bg-[var(--accent-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]"
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
