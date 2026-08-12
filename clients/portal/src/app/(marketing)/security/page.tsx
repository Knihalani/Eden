import type { ReactNode } from "react";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import {
  DOCS_URL,
  SECURITY_EMAIL,
  SUPPORT_EMAIL,
} from "@/lib/constants";
import { marketingMetadata } from "@/lib/seo";

export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/security",
  title: "Security · Eden — Auth, Isolation & Disclosure",
  description:
    "How Eden protects trace data: Clerk auth, org-scoped RBAC, PII redaction, TLS, and private vulnerability disclosure. No invented certifications.",
});

const DOCS_SECURITY_MODEL = `${DOCS_URL}/explanation/security-model`;

const linkClass =
  "text-[var(--accent)] hover:text-[var(--accent-hover)]";

function SectionKicker({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
      {children}
    </p>
  );
}

const CONTROLS = [
  {
    t: "Authentication",
    d: "Portal users authenticate with Clerk (sessions; MFA available). API access uses org-scoped API keys you rotate from Settings. Browser calls are proxied same-origin to avoid cross-site cookie issues.",
  },
  {
    t: "Authorization & isolation",
    d: "Every API call is scoped to organization membership. Org-scoped RBAC gates workspace and settings access. Cross-org access is denied at the API layer. Customer telemetry stays tenant-isolated.",
  },
  {
    t: "Encryption in transit",
    d: "Public endpoints use TLS. Client traffic to Eden is HTTPS. We do not invent cipher-suite marketing beyond what your browser or SDK negotiates with the edge.",
  },
  {
    t: "PII at ingest",
    d: "Payloads can be masked at ingest using your redaction rules. You control retention and PII filtering from Settings. Eden does not sell personal information.",
  },
  {
    t: "Audit",
    d: "Sensitive actions are recorded where the audit surface is implemented. Autonomy allow / deny / budget decisions are meant to be inspectable — not invisible magic.",
  },
] as const;

export default function SecurityPage() {
  return (
    <main>
      <MarketingShell
        kicker="Security"
        title="How Eden protects your data"
        lead="Observability data is sensitive. This page states what we do today — Clerk auth, org-scoped access, PII controls, TLS — and how to report vulnerabilities. We do not claim third-party certifications on marketing surfaces."
      >
        <div className="max-w-3xl space-y-14">
          <section className="space-y-5">
            <SectionKicker>Controls today</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              What ships in the product
            </h2>
            <div className="overflow-hidden border border-[var(--line)] divide-y divide-[var(--line)]">
              {CONTROLS.map((row) => (
                <div key={row.t} className="px-5 py-5">
                  <h3 className="text-[0.9375rem] font-medium tracking-[-0.01em] text-[var(--text)]">
                    {row.t}
                  </h3>
                  <p className="mt-2 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
                    {row.d}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Docs</SectionKicker>
            <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
              Deeper security model
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                For the public security model — tenant isolation, Clerk org
                mapping, API key scoping, PII patterns, encryption, and auth
                modes — read{" "}
                <a
                  href={DOCS_SECURITY_MODEL}
                  className={linkClass}
                  rel="noopener noreferrer"
                >
                  docs · Security model
                </a>
                . Claims on this page stay limited to what the product and that
                doc already describe; we do not invent certifications here.
              </p>
              <p>
                Related legal summaries:{" "}
                <Link href="/privacy" className={linkClass}>
                  Privacy
                </Link>
                ,{" "}
                <Link href="/dpa" className={linkClass}>
                  DPA
                </Link>
                , and{" "}
                <Link href="/subprocessors" className={linkClass}>
                  Subprocessors
                </Link>
                . Those pages are intentionally short during public beta —
                contact us for enterprise agreements rather than treating the
                summaries as counsel-ready contracts.
              </p>
            </div>
          </section>

          <section className="space-y-5">
            <SectionKicker>Disclosure</SectionKicker>
            <h2
              id="report-vulnerability"
              className="scroll-mt-20 text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]"
            >
              Report a vulnerability
            </h2>
            <div className="space-y-4 text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              <p>
                Found a security issue? Email{" "}
                <a
                  href={`mailto:${SECURITY_EMAIL}`}
                  className={`font-mono ${linkClass}`}
                >
                  {SECURITY_EMAIL}
                </a>
                . Please do not file public GitHub issues for suspected
                vulnerabilities. We take good-faith reports seriously and will
                follow up with triage steps. The same contact is listed in{" "}
                <a
                  href="/.well-known/security.txt"
                  className={linkClass}
                >
                  /.well-known/security.txt
                </a>
                .
              </p>
              <p>
                We do not run a public bug bounty yet. Enterprise security
                questionnaires and formal audit artifacts may not be available
                during public beta — email{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} className={linkClass}>
                  {SUPPORT_EMAIL}
                </a>{" "}
                to discuss requirements. Live operational status is on{" "}
                <Link href="/status" className={linkClass}>
                  Status
                </Link>
                .
              </p>
            </div>
          </section>

          <p className="type-meta text-[var(--text-faint)]">
            This page summarizes product posture for customers and reporters. It
            is not a certification claim and not a substitute for a signed DPA.
          </p>
        </div>
      </MarketingShell>
    </main>
  );
}
