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
import { SignedInGate } from "./_components/SignedInGate";

/**
 * K12 / P3 — landing is an RSC. Only SignedInGate (and nested client
 * islands like InstallSection / Faq / Nav) pull Clerk into the client
 * graph; static sections stay server-rendered.
 */
export default function LandingPage() {
  return (
    <div className="relative min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] overflow-x-hidden">
      <MarketingBackdrop />
      <SignedInGate
        signedIn={<MarketingNav signedIn />}
        signedOut={<MarketingNav signedIn={false} />}
      />
      <main>
        <SignedInGate
          signedIn={<Hero signedIn />}
          signedOut={<Hero signedIn={false} />}
        />
        <TrustStrip />
        <InstallSection />
        <Pillars />
        <ImproveSpotlight />
        <AssistantPreview />
        <Faq />
        <SignedInGate
          signedIn={<BottomCta signedIn />}
          signedOut={<BottomCta signedIn={false} />}
        />
        <MarketingFooter />
      </main>
    </div>
  );
}
