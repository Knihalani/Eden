import type { Metadata } from "next";

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
      "Drop-in LLM observability, evaluation, and reviewable PR suggestions. Capture every call. Ship every fix.",
    url: PORTAL,
  },
  twitter: {
    card: "summary_large_image",
    title: "Eden — Observability + improvement for AI agents",
    description:
      "Drop-in LLM observability, evaluation, and reviewable PR suggestions.",
  },
  metadataBase: new URL(PORTAL),
};

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      {children}
    </div>
  );
}
