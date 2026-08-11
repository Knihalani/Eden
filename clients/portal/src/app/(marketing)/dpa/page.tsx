import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";
import { marketingMetadata } from "@/lib/seo";


export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/dpa",
  title: "DPA · Eden",
  description:
    "Eden Data Processing Agreement for enterprise customers — subprocessors, security measures, and residency.",
});

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
