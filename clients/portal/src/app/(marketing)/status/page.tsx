import type { Metadata } from "next";

import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";


export const revalidate = 3600;
export const metadata: Metadata = { title: "Status · Eden" };

export default function Page() {
  return (
    <ThinMarketingDoc
      kicker="Status"
      title="System status"
      paragraphs={[
        "No active incidents are published on this page yet. If the portal or API is unavailable, email us and we will respond as quickly as we can.",
        "A dedicated status page with historical uptime will land here as we harden production SLOs.",
      ]}
    />
  );
}
