import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";
import { marketingMetadata } from "@/lib/seo";


export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/privacy",
  title: "Privacy · Eden",
  description:
    "How Eden collects, uses, and protects your data. Eden does not sell personal information.",
  robots: { index: false, follow: true },
});

export default function Page() {
  return (
    <ThinMarketingDoc
      kicker="Legal"
      title="Privacy"
      paragraphs={[
        "Eden processes account data and telemetry you send to operate the service — traces, evals, and workspace settings scoped to your organization.",
        "We do not sell personal information. Deletion requests start a partial erasure flow — coverage varies by store and is not a certified GDPR-compliant guarantee. For deletion, export, or DPA requests, email the address below. A fuller policy will replace this summary as we exit public beta.",
      ]}
    />
  );
}
