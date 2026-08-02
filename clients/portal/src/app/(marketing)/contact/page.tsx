import type { Metadata } from "next";

import { ContactForm } from "@/components/marketing/contact-form";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { SUPPORT_EMAIL } from "@/lib/constants";


export const revalidate = 3600;
export const metadata: Metadata = {
  title: "Contact · Eden",
  description: "Sales, support, or security — reach Eden.",
  robots: { index: true, follow: true },
};

export default function ContactPage() {
  return (
    <main>
      <MarketingShell
        kicker="Contact"
        title="Talk to us"
        lead="Sales, support, or security — one inbox."
      >
        <p className="type-body mb-8 !text-[var(--text-secondary)]">
          Email{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-[var(--accent)] hover:text-[var(--accent-hover)]"
          >
            {SUPPORT_EMAIL}
          </a>{" "}
          or use the form below (opens your mail client).
        </p>
        <ContactForm />
      </MarketingShell>
    </main>
  );
}
