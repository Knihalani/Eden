import type { Metadata } from "next";
import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";

export const metadata: Metadata = { title: "Health · Eden" };

export default function Page() {
  return (
    <ThinMarketingDoc
      kicker="System"
      title="Health"
      paragraphs={[
        "This page is a public marker that the marketing site is reachable. API health checks live on the backend service, not here.",
        "If you need uptime details for enterprise, contact us.",
      ]}
    />
  );
}
