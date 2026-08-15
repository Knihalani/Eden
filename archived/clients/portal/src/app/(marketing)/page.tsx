import {
  faqPageJsonLd,
  HOME_FAQ,
  marketingMetadata,
  organizationJsonLd,
  softwareApplicationJsonLd,
  webSiteJsonLd,
} from "@/lib/seo";
import { JsonLd } from "@/components/seo/json-ld";

import { MarketingHomeHero } from "@/components/marketing/marketing-home-hero";
import { MarketingHomeSections } from "@/components/marketing/marketing-home-sections";

export const revalidate = 3600;

export const metadata = marketingMetadata({
  path: "/",
  title: "Eden — LLM Observability & Improvement for AI Agents",
  description:
    "Drop-in LLM observability for AI agents: traces, evals, and reviewable fix plans in one loop. OpenAI-compatible gateway and SDKs. See every run; fix what fails.",
});

export default function HomePage() {
  return (
    <main>
      {/* Structured data — Organization + WebSite + SoftwareApplication +
          FAQPage. FAQ content stays in sync with the visible FAQ section
          in marketing-home-sections.tsx via HOME_FAQ. */}
      <JsonLd
        data={[
          organizationJsonLd(),
          webSiteJsonLd(),
          softwareApplicationJsonLd(),
        ]}
      />
      <JsonLd data={faqPageJsonLd(HOME_FAQ)} />
      <MarketingHomeHero />
      <MarketingHomeSections />
    </main>
  );
}
