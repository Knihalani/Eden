import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/layout/legal-page";
import { Download, FileText, Users, Globe, ShieldCheck, Inbox, AlertTriangle, Trash2, Mail } from "lucide-react";

export const metadata: Metadata = {
  title: "Data Processing Addendum · Eden",
  description:
    "GDPR-compliant DPA. Standard Contractual Clauses (SCCs). Auto-attached to enterprise contracts.",
};

{/* TODO: legal review — every clause below needs counsel sign-off before launch. */}

const SUBPROCESSORS = [
  "Postgres hosting (AWS, region selected by Customer)",
  "ClickHouse hosting (AWS, region selected by Customer)",
  "Object storage for exports (AWS S3, region selected by Customer)",
  "Email delivery (Postmark, US)",
  "Error reporting (Sentry, US)",
  "Status page (Statuspage, US)",
];

const SECTIONS = [
  {
    id: "roles-and-scope",
    title: "Roles and scope",
    icon: Users,
    body: (
      <p>
        Customer is the <strong>Controller</strong>. Eden is the{" "}
        <strong>Processor</strong>. Eden processes Customer Personal Data only on
        documented instructions from the Customer, including with regard to
        international transfers, unless required to do so by applicable law.
      </p>
    ),
  },
  {
    id: "subprocessors",
    title: "Subprocessors",
    icon: Inbox,
    body: (
      <>
        <p>
          Eden engages the following subprocessor categories. A current list with
          regions is maintained at{" "}
          <Link href="/security" className="text-[var(--accent)] hover:underline">
            /security
          </Link>
          ; changes are notified 30 days in advance.
        </p>
        <ul className="list-disc list-outside pl-6 space-y-1 mt-3 text-sm text-[var(--text-secondary)]">
          {SUBPROCESSORS.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </>
    ),
  },
  {
    id: "international-transfers",
    title: "International transfers",
    icon: Globe,
    body: (
      <p>
        For transfers outside the EEA, UK, or Switzerland, Eden relies on the EU
        Standard Contractual Clauses (Module 2: Controller-to-Processor). The SCCs
        are incorporated by reference into the DPA. Customer may execute the SCCs
        as a separate addendum if required.
      </p>
    ),
  },
  {
    id: "security-measures",
    title: "Security measures",
    icon: ShieldCheck,
    body: (
      <p>
        Eden implements technical and organisational measures as documented in our{" "}
        <Link href="/security" className="text-[var(--accent)] hover:underline">Security page</Link>,
        including encryption at rest (AES-256) and in transit (TLS 1.3), per-tenant
        data isolation, RBAC with audit logging, quarterly access reviews, and
        annual SOC 2 Type II audits.
      </p>
    ),
  },
  {
    id: "data-subject-requests",
    title: "Data subject requests",
    icon: Mail,
    body: (
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
    ),
  },
  {
    id: "breach-notification",
    title: "Breach notification",
    icon: AlertTriangle,
    body: (
      <p>
        Eden will notify the Customer without undue delay, and in any case within 72
        hours, of any Personal Data breach affecting Customer data. Notification
        includes the nature of the breach, categories and approximate number of
        data subjects affected, likely consequences, and measures taken.
      </p>
    ),
  },
  {
    id: "return-and-deletion",
    title: "Return and deletion",
    icon: Trash2,
    body: (
      <p>
        On termination, Eden will return all Customer Personal Data in a
        machine-readable format (JSONL / CSV) within 30 days, then permanently
        delete all copies within a further 30 days, unless retention is required by
        law.
      </p>
    ),
  },
];

export default function DpaPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Data Processing Addendum"
      description={
        <>
          Eden&apos;s DPA is auto-attached to every paid order form. It incorporates the EU Standard
          Contractual Clauses (SCCs) for international data transfers and designates Eden as a{" "}
          <strong>Processor</strong>{" "}
          acting on the Customer&apos;s documented instructions.
        </>
      }
      size="narrow"
    >
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
          <Link
            href="/api/dpa/download"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)] rounded-lg transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Download DPA template (PDF)
          </Link>
        </div>
      </div>

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
          DPA version 3.2 · Last updated: June 30, 2026. This page is a summary — the
          signed DPA attached to your order form is the legally-binding document.
        </p>
      </div>
    </LegalPage>
  );
}
