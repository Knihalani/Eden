import type { Metadata } from "next";

import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";


export const revalidate = 3600;
export const metadata: Metadata = { title: "Do Not Sell · Eden" };

export default function Page() {
  return (
    <ThinMarketingDoc
      kicker="Legal"
      title="Do not sell my personal information"
      paragraphs={[
        "Eden does not sell personal information. If you believe we hold data about you and want it deleted or corrected, contact us with enough detail to locate the account.",
        "Cookie preferences can be reopened from the cookie banner when present on this site.",
      ]}
    />
  );
}
