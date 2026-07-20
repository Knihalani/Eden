import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/layout/legal-page";
import { DoNotSellForm } from "./do-not-sell-form";

export const metadata: Metadata = {
  title: "Do Not Sell · Eden",
  description:
    "California residents can opt out of the sale or sharing of personal information under the CCPA/CPRA.",
  openGraph: {
    title: "Do Not Sell · Eden",
    description:
      "California residents can opt out of the sale or sharing of personal information under the CCPA/CPRA.",
  },
  twitter: {
    title: "Do Not Sell · Eden",
    description:
      "California residents can opt out of the sale or sharing of personal information under the CCPA/CPRA.",
  },
};

/** P19 — RSC shell; form is a client island. */
export default function DoNotSellPage() {
  return (
    <LegalPage
      eyebrow="CCPA"
      title="Do Not Sell My Personal Information"
      description="California residents can opt out of the sale or sharing of personal information under the CCPA/CPRA. Eden does not sell personal information; submitting this form records your preference."
      size="narrow"
    >
      <DoNotSellForm />
      <p className="mt-8 text-sm text-[var(--text-muted)]">
        Questions? See our{" "}
        <Link
          href="/privacy"
          className="text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
        >
          Privacy Policy
        </Link>
        .
      </p>
    </LegalPage>
  );
}
