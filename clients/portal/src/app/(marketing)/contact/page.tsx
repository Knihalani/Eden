import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/layout/legal-page";
import { SUPPORT_EMAIL } from "@/lib/constants";
import { ContactForm } from "./contact-form";

const DESCRIPTION =
  "Reach Eden about soft launch, volume, or security questions. Privacy rights requests go through the Privacy page.";

export const metadata: Metadata = {
  title: "Contact · Eden",
  description: DESCRIPTION,
  openGraph: {
    title: "Contact · Eden",
    description: DESCRIPTION,
  },
  twitter: {
    title: "Contact · Eden",
    description: DESCRIPTION,
  },
};

/** P19 — RSC shell; interactive form is a client island. */
export default function ContactPage() {
  return (
    <LegalPage
      eyebrow="Contact"
      title="Get in touch"
      description={
        <>
          Soft launch, volume, or security questions — open your email client or write{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
          >
            {SUPPORT_EMAIL}
          </a>
          . We reply within a few business days. Privacy rights requests belong on the{" "}
          <Link
            href="/privacy"
            className="text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
          >
            Privacy
          </Link>{" "}
          page, not this form.
        </>
      }
      size="medium"
    >
      <ContactForm />
      <p className="mt-10 text-sm text-[var(--text-muted)]">
        <Link
          href="/about"
          className="text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
        >
          About
        </Link>
        {" · "}
        <Link
          href="/pricing"
          className="text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
        >
          Pricing
        </Link>
        {" · "}
        <Link
          href="/security"
          className="text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
        >
          Security
        </Link>
      </p>
    </LegalPage>
  );
}
