import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";
import { marketingMetadata } from "@/lib/seo";


export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/changelog",
  title: "Changelog · Eden",
  description: "Recent product updates, releases, and platform changes for Eden.",
});

export default function Page() {
  return (
    <ThinMarketingDoc
      kicker="Product"
      title="Changelog"
      paragraphs={[
        "Recent work: live portal API wire-up, Signal Black product chrome, and this marketing + auth redesign.",
        "Detailed release notes will appear here as we ship numbered releases out of public beta.",
      ]}
    />
  );
}
