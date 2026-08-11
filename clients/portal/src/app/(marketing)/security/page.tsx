import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";
import { marketingMetadata } from "@/lib/seo";


export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/security",
  title: "Security · Eden",
  description:
    "How Eden protects your trace data — Clerk authentication, org-scoped API access, and same-origin proxying.",
});

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
