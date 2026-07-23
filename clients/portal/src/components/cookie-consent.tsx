"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  applyAnalyticsConsent,
  bootAnalyticsFromStoredConsent,
  COOKIE_CONSENT_KEY,
  OPEN_COOKIE_PREFERENCES_EVENT,
  type ConsentValue,
} from "@/lib/analytics";
import { isAuthPath } from "@/lib/auth-redirect";

function readStoredConsent(): ConsentValue | null {
  if (typeof window === "undefined") return null;
  try {
    const v = localStorage.getItem(COOKIE_CONSENT_KEY);
    if (v === "accepted" || v === "declined") return v;
  } catch {
    /* ignore */
  }
  return null;
}

export function CookieConsent() {
  const pathname = usePathname() ?? "";
  const [choice, setChoice] = useState<ConsentValue | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = readStoredConsent();
    setChoice(stored);
    bootAnalyticsFromStoredConsent();
    setReady(true);

    const onOpen = () => setChoice(null);
    window.addEventListener(OPEN_COOKIE_PREFERENCES_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_COOKIE_PREFERENCES_EVENT, onOpen);
  }, []);

  if (!ready || choice != null || isAuthPath(pathname)) return null;

  function decide(value: ConsentValue) {
    try {
      localStorage.setItem(COOKIE_CONSENT_KEY, value);
    } catch {
      /* ignore */
    }
    applyAnalyticsConsent(value);
    setChoice(value);
  }

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Cookie preferences"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--line)] bg-[var(--bg-elevated)] p-4"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="type-body">
          Optional analytics cookies. Decline keeps the product working without them.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="ds-btn ds-btn-outline"
            onClick={() => decide("declined")}
          >
            Decline
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-primary"
            onClick={() => decide("accepted")}
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}

export function openCookiePreferences() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_COOKIE_PREFERENCES_EVENT));
}
