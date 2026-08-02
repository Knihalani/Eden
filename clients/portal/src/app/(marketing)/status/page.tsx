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
        "No active incidents are published here yet. If the portal or API is unavailable, email us and we will respond as quickly as we can.",
        "Historical uptime will appear on this page once production SLOs are published.",
      ]}
    />
  );
}
