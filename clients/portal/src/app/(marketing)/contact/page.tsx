import Link from "next/link";
import { ContactForm } from "@/components/marketing/contact-form";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import {
  DOCS_URL,
  DOCS_QUICKSTART_URL,
  SALES_EMAIL,
  SECURITY_EMAIL,
  SUPPORT_EMAIL,
} from "@/lib/constants";
import { marketingMetadata } from "@/lib/seo";

export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/contact",
  title: "Contact Eden — Support, Sales & Security",
  description:
    "Reach Eden for product support, sales, or vulnerability disclosure. Docs, security@, and a contact form — no invented phone numbers.",
});

const linkClass =
  "text-[var(--accent)] hover:text-[var(--accent-hover)]";

const PATHS = [
  {
    t: "Product & support",
    d: "Account access, ingest, billing credits, or how a feature works.",
    href: `mailto:${SUPPORT_EMAIL}`,
    label: SUPPORT_EMAIL,
  },
  {
    t: "Sales & Enterprise",
    d: "Team or Enterprise roadmap questions, SSO/SCIM needs, or DPA requests.",
    href: `mailto:${SALES_EMAIL}`,
    label: SALES_EMAIL,
  },
  {
    t: "Security disclosure",
    d: "Report a vulnerability privately. Do not file public GitHub issues for security bugs.",
    href: `mailto:${SECURITY_EMAIL}`,
    label: SECURITY_EMAIL,
  },
] as const;

export default function ContactPage() {
  return (
    <main>
      <MarketingShell
        kicker="Contact"
        title="Talk to us"
        lead="Sales, support, or security — pick the path that matches. One real inbox per topic; the form opens your mail client."
      >
        <div className="max-w-2xl space-y-12">
          <div className="overflow-hidden border border-[var(--line)] divide-y divide-[var(--line)]">
            {PATHS.map((row) => (
              <div
                key={row.t}
                className="flex flex-col gap-2 px-5 py-5 sm:flex-row sm:items-start sm:justify-between sm:gap-8"
              >
                <div>
                  <p className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-[var(--text-faint)]">
                    {row.t}
                  </p>
                  <p className="mt-2 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
                    {row.d}
                  </p>
                </div>
                <a
                  href={row.href}
                  className={`mt-1 shrink-0 font-mono text-[0.8125rem] ${linkClass}`}
                >
                  {row.label}
                </a>
              </div>
            ))}
          </div>

          <section className="space-y-4">
            <h2 className="text-[1.15rem] font-semibold tracking-[-0.02em] text-[var(--text)]">
              Prefer docs first?
            </h2>
            <p className="text-[1rem] leading-relaxed text-[var(--text-secondary)]">
              Most ingest and SDK questions are answered in the{" "}
              <a
                href={DOCS_QUICKSTART_URL}
                className={linkClass}
                rel="noopener noreferrer"
              >
                quickstart
              </a>{" "}
              and full{" "}
              <a href={DOCS_URL} className={linkClass} rel="noopener noreferrer">
                documentation
              </a>
              . For live API health, see{" "}
              <Link href="/status" className={linkClass}>
                Status
              </Link>
              . Security posture and disclosure policy live on{" "}
              <Link href="/security" className={linkClass}>
                Security
              </Link>{" "}
              (and in{" "}
              <a
                href={`${DOCS_URL}/operations/security`}
                className={linkClass}
                rel="noopener noreferrer"
              >
                docs · Security
              </a>
              ).
            </p>
          </section>

          <section className="space-y-4">
            <h2 className="text-[1.15rem] font-semibold tracking-[-0.02em] text-[var(--text)]">
              Send a message
            </h2>
            <p className="text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
              The form below opens your mail client addressed to{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`} className={linkClass}>
                {SUPPORT_EMAIL}
              </a>
              . Nothing is stored on our servers from this page.
            </p>
            <ContactForm />
          </section>
        </div>
      </MarketingShell>
    </main>
  );
}
