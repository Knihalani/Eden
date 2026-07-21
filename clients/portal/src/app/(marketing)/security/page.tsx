import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/layout/legal-page";
import { DOCS_URL, SUPPORT_EMAIL } from "@/lib/constants";
import {
  Shield,
  Lock,
  Key,
  FileCheck2,
  AlertTriangle,
  Eye,
} from "lucide-react";

export const metadata: Metadata = {
  title: "Security · Eden",
  description:
    "How Eden protects your data during public beta — TLS, Clerk auth, org RBAC, API keys, and PII masking at ingest.",
};

const CONTROLS = [
  {
    title: "Encryption in transit",
    icon: Lock,
    detail:
      "Client traffic to Eden uses HTTPS (TLS). We do not publish cipher-suite or mTLS details beyond what your browser or SDK negotiates with our edge.",
  },
  {
    title: "Authentication",
    icon: Key,
    detail:
      "Portal sign-in is handled by Clerk (sessions, MFA available). API access uses org-scoped API keys you rotate from Settings.",
  },
  {
    title: "Org RBAC & audit",
    icon: FileCheck2,
    detail:
      "Per-org roles gate workspace and settings access. Sensitive actions are recorded in the audit log where that surface is implemented.",
  },
  {
    title: "PII at ingest",
    icon: Eye,
    detail:
      "Payloads can be masked at ingest using your redaction rules. You control what raw content is retained.",
  },
  {
    title: "Tenant isolation",
    icon: Shield,
    detail:
      "Customer data is scoped by organization. Cross-org access is denied at the API layer.",
  },
];

export default function SecurityPage() {
  return (
    <LegalPage
      eyebrow="Trust Center"
      title="Security"
      description="Eden is in public beta. Observability data is sensitive — this page states what we do today and how to reach us for security questions. We do not claim third-party certifications on marketing surfaces."
      size="narrow"
    >
      <section className="mb-12">
        <h2
          id="today"
          className="text-xl font-semibold text-[var(--text-primary)] mb-4 tracking-tight scroll-mt-20"
        >
          What we do today
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

      <section className="bg-[var(--bg-primary)] border border-[var(--accent)]/30 rounded-xl p-6 mb-8">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-[var(--accent)] mt-0.5 shrink-0" />
          <div>
            <h2
              id="report-vulnerability"
              className="text-base font-semibold text-[var(--text-primary)] mb-1 scroll-mt-20"
            >
              Report a vulnerability
            </h2>
            <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-3">
              Found a security issue? Email{" "}
              <a
                href="mailto:security@eden.dev"
                className="text-[var(--accent)] hover:underline font-mono"
              >
                security@eden.dev
              </a>
              . We acknowledge good-faith reports and will follow up with triage steps.
              Please do not file public GitHub issues for suspected vulnerabilities.
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              Enterprise security questionnaires and formal audit artifacts are not
              available during public beta — contact us to discuss your requirements.
            </p>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap gap-space-3 mt-space-6">
        <Link
          href="/privacy"
          className="inline-flex items-center gap-space-2 min-h-11 px-space-4 py-space-2 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
        >
          Privacy policy
        </Link>
        <Link
          href="/dpa"
          className="inline-flex items-center gap-space-2 min-h-11 px-space-4 py-space-2 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
        >
          DPA
        </Link>
        <a
          href={DOCS_URL}
          className="inline-flex items-center gap-space-2 min-h-11 px-space-4 py-space-2 text-sm font-medium text-[var(--accent)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg transition-colors"
          style={{ color: "var(--accent-foreground)" }}
        >
          Read the docs
        </a>
      </div>

      <div className="mt-12 pt-8 border-t border-[var(--border-subtle)]">
        <p className="text-xs text-[var(--text-muted)]">
          Questions about how we handle your data?{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-[var(--accent)] hover:underline"
          >
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </div>
    </LegalPage>
  );
}
