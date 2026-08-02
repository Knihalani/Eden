import type { Metadata } from "next";

import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";


export const revalidate = 3600;
export const metadata: Metadata = { title: "Terms · Eden" };

export default function Page() {
  return (
    <ThinMarketingDoc
      kicker="Legal"
      title="Terms of service"
      paragraphs={[
        "By creating an Eden account or using the API you agree to use the service lawfully, keep credentials private, and not abuse ingest or evaluation capacity.",
        "The product is offered as-is during public beta. Formal terms will supersede this summary; contact us for enterprise agreements.",
      ]}
    />
  );
}
