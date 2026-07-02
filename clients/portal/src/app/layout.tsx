import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AuthProvider } from "@/hooks/use-auth";
import { OrgProvider } from "@/hooks/use-org";
import { ToastProvider } from "@/components/ui/toast";
import { NotificationsProvider } from "@/hooks/use-notifications";
import { QueryProvider } from "@/components/providers/query-provider";
import { MotionProvider } from "@/components/providers/motion-provider";
import { CookieConsent } from "@/components/cookie-consent";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Eden — AI Environment Generation",
  description: "AI-native environment generation system for reinforcement learning and agent evaluation",
  // Tell crawlers (Google, Bing, etc.) not to index the portal — the
  // app is auth-gated and indexed pages would be empty/error frames
  // to anyone following a search-result link. Public marketing pages
  // (docs/, marketing/) override this with their own metadata.
  // June 2026 polish.
  robots: { index: false, follow: false, nocache: true },
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
  "https://edenobservability.com",
  process.env.NEXT_PUBLIC_SITE_URL,
].filter((origin): origin is string => Boolean(origin));

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex flex-col bg-[var(--bg-primary)] grain-overlay">
        <ClerkProvider allowedRedirectOrigins={ALLOWED_REDIRECT_ORIGINS}>
          <QueryProvider>
          <AuthProvider>
          <OrgProvider>
          <ToastProvider>
            <MotionProvider>
              {/* ui-audit prompt 85: Radix TooltipProvider enables
               * hover/focus tooltips anywhere in the app. delayDuration
               * 200ms prevents accidental tooltip flash on quick mouse
               * passes; skipDelayDuration 300ms lets users move between
               * adjacent triggers without re-waiting. */}
              <TooltipProvider delayDuration={200} skipDelayDuration={300}>
                <NotificationsProvider>
                  {children}
                  {/* Cookie consent — GDPR / CCPA gate for analytics +
                   * marketing tags. Only renders when the user has
                   * not yet made a choice. */}
                  <CookieConsent />
                </NotificationsProvider>
              </TooltipProvider>
            </MotionProvider>
          </ToastProvider>
          </OrgProvider>
          </AuthProvider>
          </QueryProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}