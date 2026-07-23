import type { Metadata } from "next";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { SITE_URL } from "@/lib/constants";

const PORTAL = process.env.NEXT_PUBLIC_PORTAL_URL || SITE_URL;

export const metadata: Metadata = {
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: "Eden",
    title: "Eden — Observability and improvement for AI agents",
    description:
      "Traces, evals, and reviewable fixes for production AI agents.",
    url: PORTAL,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Eden" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Eden — Observability and improvement for AI agents",
    description:
      "Traces, evals, and reviewable fixes for production AI agents.",
    images: ["/og.png"],
  },
  metadataBase: new URL(PORTAL),
};

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-[var(--bg)] text-[var(--text)]">
      <MarketingHeader />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      <MarketingFooter />
    </div>
  );
}
