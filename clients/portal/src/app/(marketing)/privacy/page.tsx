import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { ChevronLeft, Shield, Lock, Eye, Database } from "lucide-react";

export const metadata: Metadata = {
  title: "Privacy · Eden",
  description:
    "How Eden collects, uses, retains, and protects your data. GDPR + CCPA compliant. EU residency available.",
};

const SECTIONS = [
  {
    id: "what-we-collect",
    title: "1. What we collect",
    icon: Database,
    body: (
      <>
        <p>
          Eden processes two distinct categories of data: <strong>Account Data</strong> (your
          sign-up email, name, organisation membership, and authentication credentials) and{" "}
          <strong>Telemetry Data</strong> (the LLM calls, prompts, completions, and tool
          invocations that flow through the Eden gateway when you integrate the SDK or
          proxy).
        </p>
        <p>
          By default, <strong>request and response bodies are not persisted to disk</strong>.
          Eden captures structured metadata — model, token counts, latency, status,
          custom spans — that is sufficient for observability and eval workloads. You opt
          in to full body capture per agent if you want replay or eval-on-trace features.
        </p>
      </>
    ),
  },
  {
    id: "pii-handling",
    title: "2. PII handling",
    icon: Eye,
    body: (
      <>
        <p>
          Before persistence, every captured body passes through the PII redaction filter
          declared in your <Link href="/settings?tab=pii" className="text-[var(--accent)] hover:underline">PII policy</Link>.
          The default policy masks emails, phone numbers, credit-card numbers, SSNs, and IP
          addresses. You can extend the policy with custom regex patterns or disable
          redaction per category.
        </p>
        <p>
          PII redaction is irreversible — the original payload is dropped at the gateway
          edge and never reaches our storage tier. If you need a &ldquo;redact on store, keep in
          memory&rdquo; mode, contact us about the self-hosted tier.
        </p>
      </>
    ),
  },
  {
    id: "data-residency",
    title: "3. Data residency",
    icon: Shield,
    body: (
      <>
        <p>
          Hosted customers choose between US (us-central-1) and EU (eu-west-1) at org
          creation. Data, backups, and derived rollups stay in the selected region. We
          do not cross-replicate telemetry data between regions.
        </p>
        <p>
          For compliance-sensitive workloads, Eden ships as a self-hosted image (Helm chart
          + docker-compose). The self-hosted tier ships the full control plane — gateway,
          evaluation pipeline, dashboard — and writes to your own Postgres + ClickHouse.
        </p>
      </>
    ),
  },
  {
    id: "retention",
    title: "4. Retention and deletion",
    icon: Lock,
    body: (
      <>
        <p>
          Trace events and judge scores retain for the period configured in your{" "}
          <Link href="/settings?tab=retention" className="text-[var(--accent)] hover:underline">retention policy</Link>
          {" "}(default 90 days for trace events, 365 days for eval aggregates). On request we
          will hard-delete an entire organisation or a specific sub-tree of resources
          within 30 days — contact <a href="mailto:privacy@eden.dev" className="text-[var(--accent)] hover:underline">privacy@eden.dev</a>.
        </p>
        <p>
          Account deletion cascades: removing your user record deletes all sessions,
          personal tokens, and SSO bindings; the org&apos;s data is preserved unless the org
          owner separately requests deletion.
        </p>
      </>
    ),
  },
  {
    id: "sharing",
    title: "5. When we share data",
    icon: Shield,
    body: (
      <>
        <p>
          We do not sell, rent, or share customer telemetry with third parties — including
          for training. Subprocessors (Postgres hosting, ClickHouse hosting, error
          reporting, email delivery) are listed in our DPA, which is auto-attached to
          enterprise contracts.
        </p>
        <p>
          We may disclose data when required by law (subpoena, court order). In the 24
          months ending June 2026 we have received zero such requests and disclosed zero
          customer records.
        </p>
      </>
    ),
  },
  {
    id: "your-rights",
    title: "6. Your rights (GDPR · CCPA)",
    icon: Shield,
    body: (
      <>
        <p>
          You can export, correct, or delete your data at any time from the settings page,
          or by emailing <a href="mailto:privacy@eden.dev" className="text-[var(--accent)] hover:underline">privacy@eden.dev</a>.
          GDPR data-subject requests are acknowledged within 72 hours and fulfilled within
          30 days. CCPA &ldquo;Do Not Sell&rdquo; is honoured by default (we never sell).
        </p>
        <p className="text-xs text-[var(--text-muted)] mt-3">
          Last updated: June 30, 2026. For the full legal text, see the DPA on our{" "}
          <Link href="/dpa" className="text-[var(--accent)] hover:underline">DPA page</Link>.
        </p>
      </>
    ),
  },
];

export default function PrivacyPage() {
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
          Privacy
        </h1>
        <p className="text-base text-[var(--text-secondary)] mb-12 leading-relaxed">
          Eden is built around the principle that your telemetry is yours. This page
          summarises what we collect, where it lives, who can see it, and how to take it
          back. For the legally-binding version, see our DPA.
        </p>

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
            Questions? Email{" "}
            <a href="mailto:privacy@eden.dev" className="text-[var(--accent)] hover:underline">
              privacy@eden.dev
            </a>
            . We respond within one business day.
          </p>
        </div>
      </main>
    </div>
  );
}