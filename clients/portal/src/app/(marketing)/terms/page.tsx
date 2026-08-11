import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";
import { marketingMetadata } from "@/lib/seo";


export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/terms",
  title: "Terms · Eden",
  description: "Terms of service for Eden accounts, the API, and edenobservability.com.",
});

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
