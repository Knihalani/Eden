import type { Metadata } from "next";
import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";

export const metadata: Metadata = { title: "Privacy · Eden" };

export default function Page() {
  return (
    <ThinMarketingDoc
      kicker="Legal"
      title="Privacy"
      paragraphs={[
        "Eden processes account data and telemetry you send to operate the service — traces, evals, and workspace settings scoped to your organization.",
        "We do not sell personal information. For deletion, export, or DPA requests, email the address below. A fuller policy will replace this summary as we exit public beta.",
      ]}
    />
  );
}
