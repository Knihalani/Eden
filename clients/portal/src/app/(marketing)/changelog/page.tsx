import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { LegalPage } from "@/components/layout/legal-page";
import { SignedInGate } from "../_components/SignedInGate";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";


export const metadata: Metadata = {
  title: "Changelog · Eden",
  description:
    "Product updates for Eden — observability, human-reviewed Improve patches, and platform changes.",
};


const ctaPrimary =
  "inline-flex items-center justify-center gap-2 min-h-11 px-5 py-2.5 text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]";

const ctaSecondary =
  "inline-flex items-center justify-center gap-2 min-h-11 px-5 py-2.5 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-primary)]/80 border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]";

const ENTRIES = [
  {
    date: "2026-07-13",
    title: "Soft-launch public surface",
    body: "Public pricing, about, contact, subprocessors, and CCPA Do Not Sell pages. GDPR export and DSAR job pipelines. Portal unit tests in CI.",
  },
  {
    date: "2026-07",
    title: "Human-reviewed Improve",
    body: "Agent Issues, Improve cockpit, and human-reviewed patch suggestions close the capture → analyse → improve path. Diffs land in an inbox — you review and open the PR.",
  },
  {
    date: "2026-06",
    title: "Observability repositioning",
    body: "Eden ships as an observability + improvement platform: OpenAI-compatible gateway, multi-language SDKs (eden-sdk / @eden-ai/sdk), and an org workspace with a cited AI assistant.",
  },
];

export default function ChangelogPage() {
  return (
    <LegalPage
      eyebrow="Changelog"
      title="What shipped"
      description="A calm, chronological record of product changes. Soft launch focuses on reliability and human-reviewed Improve."
      size="medium"
    >
      <ol className="space-y-10">
        {ENTRIES.map((entry) => (
          <li key={entry.date + entry.title} className="border-l border-[var(--border-subtle)] pl-6">
            <p className="text-[11px] font-mono uppercase tracking-widest text-[var(--text-muted)] mb-1">
              <time dateTime={entry.date.length === 7 ? `${entry.date}-01` : entry.date}>
                {entry.date}
              </time>
            </p>
            <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">{entry.title}</h2>
            <p className="text-sm text-[var(--text-secondary)] leading-relaxed max-w-2xl">
              {entry.body}
            </p>
          </li>
        ))}
      </ol>
      <div className="mt-14 flex flex-wrap items-center gap-3">
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

    </LegalPage>
  );
}
