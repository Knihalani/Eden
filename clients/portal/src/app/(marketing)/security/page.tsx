import type { Metadata } from "next";

import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";


export const revalidate = 3600;
export const metadata: Metadata = { title: "Security · Eden" };

export default function Page() {
  return (
    <ThinMarketingDoc
      kicker="Security"
      title="Security"
      paragraphs={[
        "Eden authenticates portal users with Clerk, scopes all API access to organization membership, and proxies browser calls same-origin to avoid cross-site cookie issues.",
        "Report vulnerabilities privately to the contact address below. We do not run a public bug bounty yet.",
      ]}
    />
  );
}
