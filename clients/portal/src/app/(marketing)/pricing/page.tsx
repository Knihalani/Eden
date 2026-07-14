import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/layout/legal-page";

export const metadata: Metadata = {
  title: "Pricing · Eden",
  description:
    "Eden is free during soft launch — up to 100K trace events per month with 7-day retention. Paid plans coming later.",
};

export default function PricingPage() {
  return (
    <LegalPage
      eyebrow="Pricing"
      title="Simple pricing"
      description="Soft launch is free. Capture traces, run evals, and ship reviewable PR suggestions without a credit card."
      size="medium"
    >
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-8">
        <p className="text-[11px] font-mono uppercase tracking-widest text-[var(--accent)] mb-2">
          Free
        </p>
        <p className="text-4xl font-bold text-[var(--text-primary)] mb-2" style={{ letterSpacing: "-0.03em" }}>
          $0
        </p>
        <p className="text-sm text-[var(--text-secondary)] mb-6">
          Soft launch — paid Team / Pro plans are not available yet.
        </p>
        <ul className="space-y-2 text-sm text-[var(--text-secondary)] mb-8">
          <li>Up to 100K trace events / month</li>
          <li>7-day retention</li>
          <li>Gateway + SDKs (Python, TypeScript, Go, Rust)</li>
          <li>Org workspace, invites, and AI assistant sidebar</li>
          <li>Improve loop + PR suggestions (human-reviewed)</li>
        </ul>
        <Link
          href="/sign-up"
          className="inline-flex items-center justify-center rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90"
        >
          Start free
        </Link>
      </div>
      <p className="mt-8 text-sm text-[var(--text-muted)]">
        Need a higher volume commitment or self-hosted deployment?{" "}
        <Link href="/contact" className="text-[var(--accent)] hover:underline">
          Contact us
        </Link>
        .
      </p>
    </LegalPage>
  );
}
