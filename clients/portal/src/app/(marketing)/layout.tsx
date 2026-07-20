import type { Metadata } from "next";

// K12: marketing HTML is statically cacheable. Signed-in CTAs come from
// a tiny SignedInGate client leaf on the landing page — no force-dynamic.

const PORTAL = process.env.NEXT_PUBLIC_PORTAL_URL || "https://edenobservability.com";

export const metadata: Metadata = {
  // Marketing pages are public — override the root layout's
  // noindex/robots setting so the landing page can rank in
  // search results. Without this, Google would skip the whole
  // site because the parent layout disallows indexing.
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: "Eden",
    title: "Eden — Observability + improvement for AI agents",
    description:
      "Drop-in LLM observability, evaluation, and human-reviewed PR suggestions. Capture every call. Review every patch.",
    url: PORTAL,
  },
  twitter: {
    card: "summary_large_image",
    title: "Eden — Observability + improvement for AI agents",
    description:
      "Drop-in LLM observability, evaluation, and human-reviewed PR suggestions.",
  },
  metadataBase: new URL(PORTAL),
};

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  // P23: grain texture is marketing-only (not portal chrome).
  // ``marketing-surface`` scopes display type recipes from globals.css.
  return (
    <div className="marketing-surface grain-overlay min-h-screen bg-[var(--bg-primary)]">
      {children}
    </div>
  );
}
