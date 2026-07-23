import type { Metadata } from "next";
import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";

export const metadata: Metadata = { title: "DPA · Eden" };

export default function Page() {
  return (
    <ThinMarketingDoc
      kicker="Legal"
      title="Data processing agreement"
      paragraphs={[
        "Enterprise customers can request a Data Processing Agreement covering subprocessors, security measures, and data residency preferences.",
        "Email us to start the DPA process. Standard public-beta accounts are covered by our privacy summary until a signed DPA is in place.",
      ]}
    />
  );
}
