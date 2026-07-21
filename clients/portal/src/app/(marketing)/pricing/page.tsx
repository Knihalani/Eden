import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { LegalPage } from "@/components/layout/legal-page";
import { SignedInGate } from "../_components/SignedInGate";
import {
  DOCS_QUICKSTART_URL,
  FREE_TIER_ORG_CAP_USD,
  FREE_TIER_PERSONAL_CAP_USD,
  FREE_TIER_TAGLINE,
} from "@/lib/constants";

export const metadata: Metadata = {
  title: "Pricing · Eden",
  description: FREE_TIER_TAGLINE,
  openGraph: {
    title: "Pricing · Eden",
    description: FREE_TIER_TAGLINE,
  },
  twitter: {
    title: "Pricing · Eden",
    description: FREE_TIER_TAGLINE,
  },
};

const ctaPrimary =
  "inline-flex items-center justify-center gap-2 min-h-11 px-5 py-2.5 text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]";

const ctaSecondary =
  "inline-flex items-center justify-center gap-2 min-h-11 px-5 py-2.5 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-primary)]/80 border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]";

export default function PricingPage() {
  return (
    <LegalPage
      eyebrow="Pricing"
      title="Free during public beta"
      description={FREE_TIER_TAGLINE}
      size="medium"
    >
      <div className="border-t border-[var(--border-subtle)] pt-8 md:pt-10">
        <p className="text-[11px] font-mono uppercase tracking-widest text-[var(--accent)] mb-3">
          Public beta · Free
        </p>
        <p className="marketing-brand mb-6 text-[clamp(2.5rem,2rem+2vw,3.5rem)]">
          $0
        </p>
        <ul className="space-y-2.5 text-sm text-[var(--text-secondary)] mb-8 max-w-xl">
          <li>
            ${FREE_TIER_PERSONAL_CAP_USD}/mo LLM spend cap — personal workspace, 1 seat
          </li>
          <li>
            ${FREE_TIER_ORG_CAP_USD}/mo LLM spend cap — org workspace, up to 3 seats
          </li>
          <li>
            Gateway + SDKs (
            <code className="font-mono text-[13px] text-[var(--text-primary)]">eden-sdk</code>
            {" / "}
            <code className="font-mono text-[13px] text-[var(--text-primary)]">@eden-ai/sdk</code>
            )
          </li>
          <li>Org workspace, invites, and cited AI assistant</li>
          <li>Improve loop + patch suggestions — human-reviewed; you open the PR</li>
        </ul>
        <p className="text-sm text-[var(--text-muted)] mb-8 max-w-xl">
          Paid Team / Pro plans are not available yet. No credit card required.
        </p>
        <div className="flex flex-wrap items-center gap-3">
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
      </div>
      <p className="mt-10 text-sm text-[var(--text-muted)]">
        Need higher volume or enterprise tenancy?{" "}
        <Link
          href="/contact"
          className="text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
        >
          Contact us
        </Link>
        {" · "}
        <Link
          href="/about"
          className="text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
        >
          About
        </Link>
        .
      </p>
    </LegalPage>
  );
}
