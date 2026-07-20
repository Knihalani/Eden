import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { LegalPage } from "@/components/layout/legal-page";
import { SignedInGate } from "../_components/SignedInGate";
import { DOCS_QUICKSTART_URL, PRODUCT_TAGLINE } from "@/lib/constants";

export const metadata: Metadata = {
  title: "About · Eden",
  description: PRODUCT_TAGLINE,
  openGraph: {
    title: "About · Eden",
    description: PRODUCT_TAGLINE,
  },
  twitter: {
    title: "About · Eden",
    description: PRODUCT_TAGLINE,
  },
};

const ctaPrimary =
  "inline-flex items-center justify-center gap-2 min-h-11 px-5 py-2.5 text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]";

const ctaSecondary =
  "inline-flex items-center justify-center gap-2 min-h-11 px-5 py-2.5 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-primary)]/80 border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]";

export default function AboutPage() {
  return (
    <LegalPage
      eyebrow="About"
      title="Observability that improves behavior"
      description={PRODUCT_TAGLINE}
      size="medium"
    >
      <div className="space-y-6 text-[var(--text-secondary)] leading-relaxed max-w-2xl">
        <p>
          Eden is the observability + improvement platform for AI agents and LLM apps: drop-in
          SDKs (
          <code className="font-mono text-[13px] text-[var(--text-primary)]">eden-sdk</code>
          {" / "}
          <code className="font-mono text-[13px] text-[var(--text-primary)]">@eden-ai/sdk</code>
          ) and an OpenAI-compatible gateway for capture, plus a multi-tenant workspace for
          traces, evals, export, and a cited AI assistant.
        </p>
        <p>
          Most LLM dashboards stop at charts. Eden closes the loop: capture → analyse → improve.
          When scores drift, you get cited insights and human-reviewed patch suggestions — you
          open the PR.
        </p>
        <p>
          Voice is precise, technical, and calm — closer to an instrument panel than a marketing
          deck. Soft launch is free while we harden the closed-loop path for production teams.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-4">
          <SignedInGate
            signedIn={
              <Link href="/dashboard" className={ctaPrimary}>
                Open dashboard
                <ArrowRight className="w-4 h-4" aria-hidden />
              </Link>
            }
            signedOut={
              <Link href="/sign-up" className={ctaPrimary}>
                Start free
                <ArrowRight className="w-4 h-4" aria-hidden />
              </Link>
            }
          />
          <a
            href={DOCS_QUICKSTART_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={ctaSecondary}
          >
            Quickstart
          </a>
        </div>
        <p className="text-sm text-[var(--text-muted)] pt-2">
          <Link
            href="/contact"
            className="text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
          >
            Contact
          </Link>
          {" · "}
          <Link
            href="/security"
            className="text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
          >
            Security
          </Link>
          {" · "}
          <Link
            href="/pricing"
            className="text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
          >
            Pricing
          </Link>
        </p>
      </div>
    </LegalPage>
  );
}
