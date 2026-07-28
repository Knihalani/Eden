"use client";

import dynamic from "next/dynamic";

/** Client boundary so root layout can defer consent off the SSR path. */
const CookieConsentLazy = dynamic(
  () =>
    import("@/components/cookie-consent").then((m) => ({
      default: m.CookieConsent,
    })),
  { ssr: false },
);

export function DeferredCookieConsent() {
  return <CookieConsentLazy />;
}
