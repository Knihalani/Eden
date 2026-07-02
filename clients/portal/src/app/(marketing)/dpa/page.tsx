import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { ChevronLeft, Download, FileText } from "lucide-react";

export const metadata: Metadata = {
  title: "Data Processing Addendum · Eden",
  description:
    "GDPR-compliant DPA. Standard Contractual Clauses (SCCs). Auto-attached to enterprise contracts.",
};

{/* TODO: legal review — every clause below needs counsel sign-off before launch. */}

export default function DpaPage() {
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
          Data Processing Addendum
        </h1>
        <p className="text-base text-[var(--text-secondary)] mb-10 leading-relaxed">
          Eden&apos;s DPA is auto-attached to every paid order form. It incorporates the EU
          Standard Contractual Clauses (SCCs) for international data transfers and
          designates Eden as a <strong>Processor</strong> acting on the Customer&apos;s
          documented instructions.
        </p>

        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-6 mb-10 flex items-start gap-4">
          <div className="w-12 h-12 rounded-lg bg-[var(--accent-faint)] border border-[var(--accent)]/20 flex items-center justify-center text-[var(--accent)] shrink-0">
            <FileText className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-[var(--text-primary)] mb-1">
              Download the DPA
            </h2>
            <p className="text-sm text-[var(--text-muted)] mb-3">
              Signed copy auto-attached to your order form. For pre-sales review, download
              the unsigned template below.
            </p>
            <a
              href="/api/dpa/download"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)] rounded-lg transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Download DPA template (PDF)
            </a>
          </div>
        </div>

        <div className="space-y-10 text-sm text-[var(--text-secondary)] leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight">
              Roles and scope
            </h2>
            <p>
              Customer is the <strong>Controller</strong>. Eden is the{" "}
              <strong>Processor</strong>. Eden processes Customer Personal Data only on
              documented instructions from the Customer, including with regard to
              international transfers, unless required to do so by applicable law.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight">
              Subprocessors
            </h2>
            <p>
              Eden engages the following subprocessor categories. A current list with
              regions is maintained at{" "}
              <Link href="/security" className="text-[var(--accent)] hover:underline">
                /security
              </Link>
              ; changes are notified 30 days in advance.
            </p>
            <ul className="list-disc list-inside space-y-1 mt-2 ml-2">
              <li>Postgres hosting (AWS, region selected by Customer)</li>
              <li>ClickHouse hosting (AWS, region selected by Customer)</li>
              <li>Object storage for exports (AWS S3, region selected by Customer)</li>
              <li>Email delivery (Postmark, US)</li>
              <li>Error reporting (Sentry, US)</li>
              <li>Status page (Statuspage, US)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight">
              International transfers
            </h2>
            <p>
              For transfers outside the EEA, UK, or Switzerland, Eden relies on the EU
              Standard Contractual Clauses (Module 2: Controller-to-Processor). The SCCs
              are incorporated by reference into the DPA. Customer may execute the SCCs
              as a separate addendum if required.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight">
              Security measures
            </h2>
            <p>
              Eden implements technical and organisational measures as documented in our{" "}
              <Link href="/security" className="text-[var(--accent)] hover:underline">Security page</Link>,
              including encryption at rest (AES-256) and in transit (TLS 1.3), per-tenant
              data isolation, RBAC with audit logging, quarterly access reviews, and
              annual SOC 2 Type II audits.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight">
              Data subject requests
            </h2>
            <p>
              Eden will assist the Customer in fulfilling data-subject requests (access,
              rectification, erasure, portability, restriction, objection) by providing
              self-service tools in the dashboard and a 72-hour-acknowledgement SLA for
              requests received via{" "}
              <a href="mailto:privacy@eden.dev" className="text-[var(--accent)] hover:underline">
                privacy@eden.dev
              </a>
              .
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight">
              Breach notification
            </h2>
            <p>
              Eden will notify the Customer without undue delay, and in any case within 72
              hours, of any Personal Data breach affecting Customer data. Notification
              includes the nature of the breach, categories and approximate number of
              data subjects affected, likely consequences, and measures taken.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight">
              Return and deletion
            </h2>
            <p>
              On termination, Eden will return all Customer Personal Data in a
              machine-readable format (JSONL / CSV) within 30 days, then permanently
              delete all copies within a further 30 days, unless retention is required by
              law.
            </p>
          </section>
        </div>

        <div className="mt-16 pt-8 border-t border-[var(--border-subtle)]">
          <p className="text-xs text-[var(--text-muted)]">
            DPA version 3.2 · Last updated: June 30, 2026. This page is a summary — the
            signed DPA attached to your order form is the legally-binding document.
          </p>
        </div>
      </main>
    </div>
  );
}