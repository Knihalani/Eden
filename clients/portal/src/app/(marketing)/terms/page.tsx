import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/legal-page";
import Link from "next/link";
import { KeyRound, ShieldAlert, FileLock, Activity, CreditCard, Scale, RefreshCw } from "lucide-react";

export const metadata: Metadata = {
  title: "Terms of Service · Eden",
  description: "Terms governing your use of the Eden platform.",
};

{/* TODO: legal review — every clause below needs counsel sign-off before launch. */}

const SECTIONS = [
  {
    id: "account",
    title: "1. Account",
    icon: KeyRound,
    body: (
      <p>
        You&apos;re responsible for the security of your account credentials and for
        activity under your API keys. Notify us within 24 hours of any suspected
        unauthorised access at{" "}
        <a href="mailto:security@eden.dev" className="text-[var(--accent)] hover:underline">
          security@eden.dev
        </a>
        .
      </p>
    ),
  },
  {
    id: "acceptable-use",
    title: "2. Acceptable use",
    icon: ShieldAlert,
    body: (
      <p>
        You may not use Eden to (a) violate any applicable law, (b) attempt to
        disrupt the service or other customers, (c) reverse-engineer the platform
        outside the terms of our public API, or (d) submit content that infringes
        third-party rights. We may suspend accounts that violate these terms with
        24 hours notice (or immediately for security incidents).
      </p>
    ),
  },
  {
    id: "your-data",
    title: "3. Your data",
    icon: FileLock,
    body: (
      <p>
        You retain ownership of all data you send to Eden. We process it only to
        provide the service and as documented in our{" "}
        <Link href="/privacy" className="text-[var(--accent)] hover:underline">Privacy Policy</Link>.
        On termination you can export your data for 30 days; after that it is
        permanently deleted.
      </p>
    ),
  },
  {
    id: "service-availability",
    title: "4. Service availability",
    icon: Activity,
    body: (
      <p>
        The free tier is provided best-effort with no SLA. Paid plans include an
        uptime SLA (99.9% monthly for Team, 99.95% for Enterprise) with service
        credits defined in your order form.
      </p>
    ),
  },
  {
    id: "payment-and-refunds",
    title: "5. Payment and refunds",
    icon: CreditCard,
    body: (
      <p>
        Paid plans are billed monthly or annually in advance. You can cancel any
        time and continue using the paid tier through the end of the current billing
        period. Refunds are issued at our discretion for documented service issues.
      </p>
    ),
  },
  {
    id: "limitation-of-liability",
    title: "6. Limitation of liability",
    icon: Scale,
    body: (
      <p>
        To the maximum extent permitted by law, Eden&apos;s aggregate liability for any
        claim is capped at the fees you paid Eden in the 12 months preceding the
        claim. We are not liable for indirect, consequential, or punitive damages.
      </p>
    ),
  },
  {
    id: "changes",
    title: "7. Changes",
    icon: RefreshCw,
    body: (
      <p>
        We may update these terms with 30 days notice for material changes. Continued
        use after the effective date constitutes acceptance. For enterprise customers,
        changes follow the change-notification process in your order form.
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Terms of Service"
      description="These terms govern your use of Eden. The free tier is offered under these terms as-is. Paid plans add the SLA + DPA in your order form."
      size="narrow"
    >
      <div className="space-y-12">
        {SECTIONS.map((s) => (
          <section key={s.id} id={s.id} className="scroll-mt-20">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-lg bg-[var(--accent-faint)] border border-[var(--accent)]/20 flex items-center justify-center text-[var(--accent)] shrink-0">
                <s.icon className="w-4.5 h-4.5" aria-hidden />
              </div>
              <h2 className="text-xl font-semibold text-[var(--text-primary)] tracking-tight">
                {s.title}
              </h2>
            </div>
            <div className="space-y-3 text-sm text-[var(--text-secondary)] leading-relaxed">
              {s.body}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-16 pt-8 border-t border-[var(--border-subtle)]">
        <p className="text-xs text-[var(--text-muted)]">
          Last updated: June 30, 2026 · Effective for all accounts created after this date.
        </p>
      </div>
    </LegalPage>
  );
}
