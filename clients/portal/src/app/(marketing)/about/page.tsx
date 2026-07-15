import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/layout/legal-page";

export const metadata: Metadata = {
  title: "About · Eden",
  description:
    "Eden is the observability + improvement platform for AI agents and LLM apps — capture every call, close the loop with reviewable fixes.",
};

export default function AboutPage() {
  return (
    <LegalPage
      eyebrow="About"
      title="Observability that improves behavior"
      description="Eden sits between your app and upstream models. Change one base_url, capture traces and costs, then turn regressions into cited insights and human-reviewed PR suggestions."
      size="medium"
    >
      <div className="space-y-6 text-[var(--text-secondary)] leading-relaxed">
        <p>
          Most LLM dashboards stop at charts. Eden closes the loop: capture → analyse → improve.
          Platform engineers get an OpenAI-compatible gateway and SDKs; the portal gives org-scoped
          traces, evals, incidents, and an AI assistant that cites real telemetry.
        </p>
        <p>
          We are precise, technical, and calm — closer to an instrument panel than a marketing deck.
          Soft launch is free while we harden the closed-loop path for production teams.
        </p>
        <p>
          <Link href="/sign-up" className="text-[var(--accent)] hover:underline">
            Start free
          </Link>
          {" · "}
          <Link href="/contact" className="text-[var(--accent)] hover:underline">
            Contact
          </Link>
          {" · "}
          <Link href="/security" className="text-[var(--accent)] hover:underline">
            Security
          </Link>
        </p>
      </div>
    </LegalPage>
  );
}
