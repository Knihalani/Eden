import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import {
  ChevronLeft,
  Shield,
  Lock,
  Server,
  Key,
  FileCheck2,
  
  AlertTriangle,
  CheckCircle2 } from "lucide-react";

export const metadata: Metadata = {
  title: "Security · Eden",
  description:
    "How Eden protects your data — encryption, RBAC, audit logs, SOC 2, vulnerability disclosure." };

const CONTROLS = [
  {
    title: "Encryption in transit",
    icon: Lock,
    detail:
      "All client traffic uses TLS 1.3 with modern cipher suites. Internal service-to-service traffic is mTLS." },
  {
    title: "Encryption at rest",
    icon: Server,
    detail:
      "Postgres, ClickHouse, and object storage volumes are AES-256 encrypted. Per-tenant encryption keys are rotated quarterly." },
  {
    title: "Authentication & RBAC",
    icon: Key,
    detail:
      "Clerk-managed sessions, JWT + refresh, MFA enforced for admins. Per-org RBAC with audit log of every permission escalation." },
  {
    title: "Audit logging",
    icon: FileCheck2,
    detail:
      "Every read/write to customer data, every permission change, and every auth event is logged to a tamper-evident store with 1-year retention." },
  {
    title: "Penetration testing",
    icon: Shield,
    detail:
      "Annual third-party pen test by a CREST-accredited firm. Reports available under NDA. Critical findings remediated within 30 days." },
  {
    title: "Bug bounty",
    icon: AlertTriangle,
    detail:
      "Public bug bounty via HackerOne. Rewards up to $25,000 for critical findings in production endpoints." },
];

const CERTIFICATIONS = [
  { name: "SOC 2 Type II", status: "Active — annual audit", icon: CheckCircle2 },
  { name: "GDPR", status: "Compliant — DPA auto-attached", icon: CheckCircle2 },
  { name: "CCPA", status: "Compliant — Do Not Sell honoured", icon: CheckCircle2 },
  { name: "HIPAA", status: "Available on Enterprise + BAA", icon: CheckCircle2 },
  { name: "ISO 27001", status: "In progress — target Q4 2026", icon: Shield },
  { name: "C5 (BSI)", status: "Available on Enterprise (EU)", icon: Shield },
];

export default function SecurityPage() {
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

      <main className="max-w-4xl mx-auto px-6 py-16">
        <p className="text-[11px] font-mono font-semibold uppercase tracking-widest text-[var(--accent)] mb-3">
          Trust Center
        </p>
        <h1
          className="text-4xl md:text-5xl font-bold text-[var(--text-primary)] mb-4"
          style={{ letterSpacing: "-0.03em", lineHeight: 1.05 }}
        >
          Security
        </h1>
        <p className="text-base text-[var(--text-secondary)] mb-12 leading-relaxed max-w-2xl">
          Eden is built around the principle that observability data is sensitive. This
          page summarises the controls we have in place to protect your data — and the
          ways you can verify them yourself.
        </p>

        {/* Compliance status */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-4 tracking-tight">
            Certifications & compliance
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {CERTIFICATIONS.map((c) => (
              <div
                key={c.name}
                className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 flex items-start gap-3"
              >
                <c.icon
                  className={
                    c.icon === CheckCircle2
                      ? "w-5 h-5 text-[var(--terminal)] mt-0.5 shrink-0"
                      : "w-5 h-5 text-[var(--text-muted)] mt-0.5 shrink-0"
                  }
                />
                <div>
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    {c.name}
                  </h3>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">{c.status}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Controls */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-4 tracking-tight">
            Technical controls
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {CONTROLS.map((c) => (
              <div
                key={c.title}
                className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5"
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 rounded-lg bg-[var(--accent-faint)] border border-[var(--accent)]/20 flex items-center justify-center text-[var(--accent)]">
                    <c.icon className="w-4 h-4" />
                  </div>
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    {c.title}
                  </h3>
                </div>
                <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                  {c.detail}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Vulnerability disclosure */}
        <section className="bg-[var(--bg-primary)] border border-[var(--accent)]/30 rounded-xl p-6 mb-8">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[var(--accent)] mt-0.5 shrink-0" />
            <div>
              <h2 className="text-base font-semibold text-[var(--text-primary)] mb-1">
                Report a vulnerability
              </h2>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-3">
                Found a security issue? Email{" "}
                <a
                  href="mailto:security@eden.dev"
                  className="text-[var(--accent)] hover:underline font-mono"
                >
                  security@eden.dev
                </a>{" "}
                (PGP key on request) or report via HackerOne. We acknowledge within 24
                hours and triage within 72 hours. Critical findings are eligible for our
                bug bounty program.
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                Please do not file public GitHub issues for suspected vulnerabilities.
              </p>
            </div>
          </div>
        </section>

        <div className="flex flex-wrap gap-3 mt-8">
          <Link
            href="/privacy"
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            Privacy policy
          </Link>
          <Link
            href="/dpa"
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            DPA
          </Link>
          <Link
            href="/docs"
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-[var(--accent)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg transition-colors"
            style={{ color: "var(--accent-foreground)" }}
          >
            Read the docs
          </Link>
        </div>

        <div className="mt-12 pt-8 border-t border-[var(--border-subtle)]">
          <p className="text-xs text-[var(--text-muted)]">
            Last reviewed: June 30, 2026. For the full security questionnaire (CAIQ, SIG,
            custom), contact{" "}
            <a
              href="mailto:security@eden.dev"
              className="text-[var(--accent)] hover:underline"
            >
              security@eden.dev
            </a>
            .
          </p>
        </div>
      </main>
    </div>
  );
}