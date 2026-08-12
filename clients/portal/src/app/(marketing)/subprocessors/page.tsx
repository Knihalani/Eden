import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";
import { marketingMetadata } from "@/lib/seo";


export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/subprocessors",
  title: "Subprocessors · Eden",
  description:
    "Subprocessors Eden uses to run the platform — cloud hosting, database, and identity providers.",
  robots: { index: false, follow: true },
});

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
