import dynamic from "next/dynamic";
import {
  MarketingBackdrop,
  MarketingNav,
  Hero,
  TrustStrip,
  InstallSection,
  BottomCta,
  MarketingFooter,
} from "./_components";
import { SignedInGate } from "./_components/SignedInGate";

/**
 * Below-fold sections — deferred so first paint stays Hero + Trust + Install.
 * SSR kept so crawlers still see content; chunks load after the hero shell.
 */
const Pillars = dynamic(
  () => import("./_components/Pillars").then((m) => ({ default: m.Pillars })),
);
const ImproveSpotlight = dynamic(
  () =>
    import("./_components/ImproveSpotlight").then((m) => ({
      default: m.ImproveSpotlight,
    })),
);
const AssistantPreview = dynamic(
  () =>
    import("./_components/AssistantPreview").then((m) => ({
      default: m.AssistantPreview,
    })),
);
const Faq = dynamic(
  () => import("./_components/Faq").then((m) => ({ default: m.Faq })),
);

/**
 * K12 / P3 — landing is an RSC. Only SignedInGate (and nested client
 * islands like InstallSection / Faq / Nav) pull Clerk into the client
 * graph; static sections stay server-rendered. W17 defers below-fold
 * islands to cut pure first-paint bloat.
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
