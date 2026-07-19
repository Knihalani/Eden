"use client";

import { useUser } from "@clerk/nextjs";
import {
  MarketingBackdrop,
  MarketingNav,
  Hero,
  TrustStrip,
  InstallSection,
  Pillars,
  ImproveSpotlight,
  AssistantPreview,
  Faq,
  BottomCta,
  MarketingFooter,
} from "./_components";

export default function LandingPage() {
  const { isSignedIn, isLoaded } = useUser();
  const signedIn = isLoaded && isSignedIn;

  return (
    <div className="relative min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] overflow-x-hidden">
      <MarketingBackdrop />
      <MarketingNav signedIn={!!signedIn} />
      <main>
        <Hero signedIn={!!signedIn} />
        <TrustStrip />
        <InstallSection />
        <Pillars />
        <ImproveSpotlight />
        <AssistantPreview />
        <Faq />
        <BottomCta signedIn={!!signedIn} />
        <MarketingFooter />
      </main>
    </div>
  );
}
