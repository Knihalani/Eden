import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { notFound } from "next/navigation";
import { CookieConsent } from "@/components/cookie-consent";
import { UnregisterServiceWorkers } from "@/components/unregister-service-workers";
import { routing } from "@/i18n/routing";
import { isKnownPortalPath } from "@/lib/portal-routes";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

// Display + body share Geist (brand identity). Marketing hierarchy
// comes from fluid scale / weight contrast via --font-display recipes
// in globals.css — not a second Google font (K11 perf budget).

export const metadata: Metadata = {
  title: "Eden — Observability + improvement for AI agents",
  description: "Drop-in observability, evaluation, and reviewable PR-suggestions for LLM applications and AI agents. OpenAI-compatible gateway, deterministic judge scores, and a human-in-the-loop patch review flow.",
  applicationName: "Eden",
  // Tell crawlers (Google, Bing, etc.) not to index the portal — the
  // app is auth-gated and indexed pages would be empty/error frames
  // to anyone following a search-result link. Public marketing pages
  // (docs/, marketing/) override this with their own metadata.
  // June 2026 polish.
  robots: { index: false, follow: false, nocache: true },
  // Eden favicon / app icons. `src/app/icon.png` (32x32) is picked up
  // automatically by Next.js App Router and served at /icon.png;
  // we declare the larger sizes here so Safari pinned tabs, Android
  // home-screen installs, and Windows taskbar shortcuts all get the
  // right resolution. The multi-res `src/app/favicon.ico` covers
  // classic browser tabs (16/32/48/64/128).
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48 64x64 128x128", type: "image/x-icon" },
      { url: "/favicon.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon.webp", sizes: "32x32", type: "image/webp" },
      { url: "/icon-192x192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-192x192.webp", sizes: "192x192", type: "image/webp" },
      { url: "/icon-512x512.png", sizes: "512x512", type: "image/png" },
      { url: "/icon-512x512.webp", sizes: "512x512", type: "image/webp" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

// ui-audit prompt 16: viewportFit: "cover" is required for the
// `env(safe-area-inset-*)` CSS values to resolve on iOS / Android.
// Without it, the safe-area values are always 0 and the home
// indicator / notch can overlap fixed bottom navigation bars and
// the ChatSidebar floating toggle.
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
};

/**
 * Clerk redirects back to our origin after OAuth + email-link flows.
 * We whitelist localhost + the production site so user-supplied
 * redirect URLs (e.g. /onboarding, /dashboard) are accepted.
 *
 * Update `NEXT_PUBLIC_SITE_URL` for staging / preview deploys; the
 * defaults cover `localhost:3000` (dev) and the canonical prod
 * domain. Wildcard would be insecure — keep the list explicit.
 */
const ALLOWED_REDIRECT_ORIGINS = [
  "http://localhost:3000",
  // Playwright golden paths + portal-ci bind to 127.0.0.1 (not localhost).
  "http://127.0.0.1:3000",
  "https://edenobservability.com",
  process.env.NEXT_PUBLIC_SITE_URL,
].filter((origin): origin is string => Boolean(origin));

// Dev/CI: allow the active PORT on both loopback hostnames (golden paths, a11y).
if (process.env.NODE_ENV !== "production") {
  const devPort = process.env.PORT || "3000";
  for (const host of ["localhost", "127.0.0.1"]) {
    const origin = `http://${host}:${devPort}`;
    if (!ALLOWED_REDIRECT_ORIGINS.includes(origin)) {
      ALLOWED_REDIRECT_ORIGINS.push(origin);
    }
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // P25: portal routes do not use next-intl (`useTranslations` lives
  // only on marketing). ``proxy.ts`` sets ``x-eden-pathname`` and
  // skips intl middleware for portal/API; here we skip loading the
  // message bundle + NextIntlClientProvider on those paths so portal
  // RSC/client trees do not pay for unused locale JSON.
  // Null pathname (SSG / no middleware) keeps intl — safe for marketing.
  const pathname = (await headers()).get("x-eden-pathname");
  const skipIntlMessages =
    pathname != null &&
    (isKnownPortalPath(pathname) ||
      pathname.startsWith("/api/") ||
      pathname.startsWith("/__clerk"));

  const locale = await getLocale();
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  const messages = skipIntlMessages ? null : await getMessages();

  // P2-phase2: portal Auth/Org/Query providers mount under
  // (portal)/layout — marketing/auth skip that tree.
  const tree = (
    <>
      {children}
      {/* K15: drop deleted SW controllers still claiming clients. */}
      <UnregisterServiceWorkers />
      {/* Cookie consent — GDPR / CCPA gate for analytics +
       * marketing tags. Only renders when the user has
       * not yet made a choice. */}
      <CookieConsent />
    </>
  );

  return (
    // Site-wide fix (July 2026): ``min-h-full`` (not ``h-full``) on
    // the html element. The previous ``h-full`` + globals.css
    // ``html { overflow-y: auto }`` combination pinned the html to
    // exactly viewport height — when body content exceeded the
    // viewport (auth pages with the Clerk <SignIn /> component,
    // password-reset forms, anything with multi-step verification
    // inputs) the overflow was clipped instead of scrolling, and the
    // user saw a frozen auth card. ``min-h-full`` lets the html grow
    // with its content while still establishing the % height context
    // ``body { min-height: 100dvh }`` needs.
    <html lang={locale} className={`${geistSans.variable} ${geistMono.variable} min-h-full antialiased`}>
      {/* P23: grain-overlay is marketing-only (see (marketing)/layout). */}
      <body className="flex min-h-full flex-col bg-[var(--bg-primary)]">
        <ClerkProvider allowedRedirectOrigins={ALLOWED_REDIRECT_ORIGINS}>
          {messages ? (
            <NextIntlClientProvider locale={locale} messages={messages}>
              {tree}
            </NextIntlClientProvider>
          ) : (
            tree
          )}
        </ClerkProvider>
      </body>
    </html>
  );
}
