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
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Cookie consent"
      className="fixed bottom-4 left-4 right-4 z-[60] mx-auto max-w-3xl rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/95 p-4 shadow-2xl backdrop-blur md:bottom-6 md:left-6 md:right-auto md:p-5"
    >
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
            className="rounded-md border border-[var(--border-subtle)] px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)]"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => set("accepted")}
            // text-[var(--accent-foreground)] (dark) on --accent (light blue)
            // gives 7.16:1 — passes WCAG AA Normal. Was text-white (2.69:1, fail).
            className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
            autoFocus
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
