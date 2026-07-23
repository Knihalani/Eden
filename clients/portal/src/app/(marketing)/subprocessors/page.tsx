import type { Metadata } from "next";
import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";

export const metadata: Metadata = { title: "Subprocessors · Eden" };

export default function Page() {
  return (
    <ThinMarketingDoc
      kicker="Legal"
      title="Subprocessors"
      paragraphs={[
        "We use infrastructure and auth providers to run Eden (cloud hosting, database, and Clerk for identity). A detailed subprocessor list is available on request for enterprise DPAs.",
        "We will notify enterprise customers of material subprocessor changes as required by agreement.",
      ]}
    />
  );
}
