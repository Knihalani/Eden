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
 * Accessibility: the banner is a ``role="dialog"`` with
 * ``aria-live="polite"`` and an "Accept" button as the primary
 * focusable element on mount.
 *
 * Ponytail: a single useEffect + localStorage + a tailwind-animated
 * slide-in panel. No external consent library — every dependency
 * is one more thing to audit.
 */

import { useEffect, useState } from "react";

type ConsentValue = "accepted" | "declined";

const STORAGE_KEY = "eden_cookie_consent";

export function CookieConsent() {
  const [visible, setVisible] = useState(false);

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

  return (
    // Outer wrapper is pointer-events-none so the wheel scrolls the
    // page underneath the banner (without this the bottom strip of
    // the viewport stops responding to scroll on first visit, which
    // the user reported as "scrolling doesn't work anywhere"). The
    // inner card opts back in to pointer-events so the buttons +
    // link remain clickable. The banner is a sibling of the page
    // chrome (root layout) and z-[60] so it floats above everything
    // except a critical modal.
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Cookie consent"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center p-4 md:p-6"
    >
      <div className="pointer-events-auto w-full max-w-3xl rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/95 p-4 shadow-2xl backdrop-blur md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
          <div className="flex-1 text-sm text-[var(--text-secondary)]">
            <p className="font-medium text-[var(--text-primary)]">
              Cookies & analytics
            </p>
            <p className="mt-1 leading-relaxed">
              Eden uses essential cookies to keep you signed in. With
              your consent we also use analytics cookies to understand
              how the portal is used. You can change this any time in
              {" "}
              <a
                href="/settings/privacy"
                className="underline underline-offset-2 hover:text-[var(--text-primary)]"
              >
                privacy settings
              </a>
              .
            </p>
          </div>
          <div className="flex gap-2 md:flex-shrink-0">
            <button
              type="button"
              onClick={() => set("declined")}
              className="rounded-md border border-[var(--border-subtle)] px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]"
            >
              Decline
            </button>
            <button
              type="button"
              onClick={() => set("accepted")}
              // text-[var(--accent-foreground)] (dark) on --accent (light blue)
              // gives 7.16:1 — passes WCAG AA Normal. Was text-white (2.69:1, fail).
              className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]"
              autoFocus
            >
              Accept
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
