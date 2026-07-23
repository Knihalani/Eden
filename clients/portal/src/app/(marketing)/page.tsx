import type { Metadata } from "next";
import { MarketingHomeHero } from "@/components/marketing/marketing-home-hero";
import { MarketingHomeSections } from "@/components/marketing/marketing-home-sections";
import { SITE_URL } from "@/lib/constants";

const PORTAL = process.env.NEXT_PUBLIC_PORTAL_URL || SITE_URL;

export const metadata: Metadata = {
  title: "Eden — Observability and improvement for AI agents",
  description:
    "See every agent run. Fix what fails. Traces, evals, and reviewable changes in one loop.",
  robots: { index: true, follow: true },
  openGraph: {
    title: "Eden — Observability and improvement for AI agents",
    description:
      "Drop-in observability for AI agents — traces, evals, and reviewable improvements.",
    url: PORTAL,
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Eden" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Eden — Observability and improvement for AI agents",
    description:
      "Drop-in observability for AI agents — traces, evals, and reviewable improvements.",
    images: ["/og.png"],
  },
};

export default function HomePage() {
  return (
    <main>
      <MarketingHomeHero />
      <MarketingHomeSections />
    </main>
  );
}
