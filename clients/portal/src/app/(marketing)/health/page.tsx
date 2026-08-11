import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";
import { marketingMetadata } from "@/lib/seo";


export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/health",
  title: "Health · Eden",
  description: "Public marker that the Eden marketing site is reachable.",
});

export default function Page() {
  return (
    <ThinMarketingDoc
      kicker="System"
      title="Health"
      paragraphs={[
        "This page is a public marker that the marketing site is reachable. API health checks live on the backend service, not here.",
        "If you need uptime details for enterprise, contact us.",
      ]}
    />
  );
}
