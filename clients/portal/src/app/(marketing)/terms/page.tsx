import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { ChevronLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "Terms of Service · Eden",
  description: "Terms governing your use of the Eden platform.",
};

{/* TODO: legal review — every clause below needs counsel sign-off before launch. */}

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[var(--bg-secondary)]">
      <nav className="sticky top-0 z-50 h-16 bg-[var(--bg-primary)]/90 backdrop-blur-xl border-b border-[var(--border-subtle)]">
        <div className="max-w-5xl mx-auto px-6 h-full flex items-center justify-between">
          <Logo size="md" showWordmark href="/" />
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Back to home
          </Link>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-16">
        <p className="text-[11px] font-mono font-semibold uppercase tracking-widest text-[var(--accent)] mb-3">
          Legal
        </p>
        <h1
          className="text-4xl md:text-5xl font-bold text-[var(--text-primary)] mb-4"
          style={{ letterSpacing: "-0.03em", lineHeight: 1.05 }}
        >
          Terms of Service
        </h1>
        <p className="text-base text-[var(--text-secondary)] mb-12 leading-relaxed">
          These terms govern your use of Eden. The free tier is offered under these terms
          as-is. Paid plans add the SLA + DPA in your order form.
        </p>

        <div className="space-y-10 text-sm text-[var(--text-secondary)] leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight">
              1. Account
            </h2>
            <p>
              You&apos;re responsible for the security of your account credentials and for
              activity under your API keys. Notify us within 24 hours of any suspected
              unauthorised access at{" "}
              <a href="mailto:security@eden.dev" className="text-[var(--accent)] hover:underline">
                security@eden.dev
              </a>
              .
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight">
              2. Acceptable use
            </h2>
            <p>
              You may not use Eden to (a) violate any applicable law, (b) attempt to
              disrupt the service or other customers, (c) reverse-engineer the platform
              outside the terms of our public API, or (d) submit content that infringes
              third-party rights. We may suspend accounts that violate these terms with
              24 hours notice (or immediately for security incidents).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight">
              3. Your data
            </h2>
            <p>
              You retain ownership of all data you send to Eden. We process it only to
              provide the service and as documented in our{" "}
              <Link href="/privacy" className="text-[var(--accent)] hover:underline">Privacy Policy</Link>.
              On termination you can export your data for 30 days; after that it is
              permanently deleted.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight">
              4. Service availability
            </h2>
            <p>
              The free tier is provided best-effort with no SLA. Paid plans include an
              uptime SLA (99.9% monthly for Team, 99.95% for Enterprise) with service
              credits defined in your order form.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight">
              5. Payment and refunds
            </h2>
            <p>
              Paid plans are billed monthly or annually in advance. You can cancel any
              time and continue using the paid tier through the end of the current billing
              period. Refunds are issued at our discretion for documented service issues.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight">
              6. Limitation of liability
            </h2>
            <p>
              To the maximum extent permitted by law, Eden&apos;s aggregate liability for any
              claim is capped at the fees you paid Eden in the 12 months preceding the
              claim. We are not liable for indirect, consequential, or punitive damages.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight">
              7. Changes
            </h2>
            <p>
              We may update these terms with 30 days notice for material changes. Continued
              use after the effective date constitutes acceptance. For enterprise customers,
              changes follow the change-notification process in your order form.
            </p>
          </section>
        </div>

        <div className="mt-16 pt-8 border-t border-[var(--border-subtle)]">
          <p className="text-xs text-[var(--text-muted)]">
            Last updated: June 30, 2026 · Effective for all accounts created after this date.
          </p>
        </div>
      </main>
    </div>
  );
}