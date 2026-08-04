import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { DeferredCookieConsent } from "@/components/deferred-cookie-consent";
import { UnregisterServiceWorkers } from "@/components/unregister-service-workers";
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
  icons: {
    icon: [
      { url: "/favicon.webp", sizes: "32x32", type: "image/webp" },
      { url: "/favicon.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon.ico", sizes: "16x16 32x32", type: "image/x-icon" },
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
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // English-only: the next-intl layer was removed (nothing ever called
  // useTranslations). ClerkProvider mounts under portal + auth layouts only.
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} min-h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-[var(--bg)] text-[var(--text)]">
        {children}
        <UnregisterServiceWorkers />
        <DeferredCookieConsent />
      </body>
    </html>
  );
}
