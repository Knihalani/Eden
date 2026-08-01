"use client";

import Link from "next/link";
import {
  DOCS_URL,
  DOCS_QUICKSTART_URL,
  PRODUCT_COPYRIGHT_YEAR,
  PRODUCT_NAME,
  SUPPORT_EMAIL,
} from "@/lib/constants";
import { MarketingRail } from "@/components/marketing/marketing-primitives";
import {
  MARKETING_APP_HREF,
  MARKETING_APP_LABEL,
} from "@/lib/marketing-cta";
import { useMarketingSignedIn } from "@/lib/marketing-signed-in-client";

type FooterLink = {
  href: string;
  label: string;
  external?: boolean;
};

function productLinks(signedIn: boolean): FooterLink[] {
  if (signedIn) {
    return [
      { href: "/pricing", label: "Pricing" },
      { href: MARKETING_APP_HREF, label: MARKETING_APP_LABEL },
      { href: "/about", label: "About" },
      { href: "/contact", label: "Contact" },
    ];
  }
  return [
    { href: "/pricing", label: "Pricing" },
    { href: "/sign-up", label: "Sign up" },
    { href: "/sign-in", label: "Sign in" },
    { href: "/about", label: "About" },
    { href: "/contact", label: "Contact" },
  ];
}

const RESOURCE_LINKS: FooterLink[] = [
  { href: DOCS_URL, label: "Documentation", external: true },
  { href: DOCS_QUICKSTART_URL, label: "Quickstart", external: true },
  { href: "/changelog", label: "Changelog" },
  { href: "/status", label: "Status" },
  { href: "/security", label: "Security" },
];

const LEGAL_LINKS: FooterLink[] = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/dpa", label: "DPA" },
  { href: "/subprocessors", label: "Subprocessors" },
  // CCPA Sec. 1798.135 wants the opt-out link titled for what it does, not
  // abbreviated. "Do Not Sell" alone reads as a category header; keep the
  // "My Info" so the link states the consumer right on its face.
  // Guarded by tests/unit/portal/test_legal_page_footer_f71.py.
  { href: "/do-not-sell", label: "Do Not Sell My Info" },
];

export function MarketingFooter() {
  const signedIn = useMarketingSignedIn();
  const columns = [
    { title: "Product", links: productLinks(signedIn) },
    { title: "Resources", links: RESOURCE_LINKS },
    { title: "Legal", links: LEGAL_LINKS },
  ];

  return (
    <footer className="mt-auto border-t border-[var(--line)] bg-[var(--bg)]">
      <MarketingRail className="py-12 sm:py-16">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <p className="type-title !text-[0.9375rem]">{PRODUCT_NAME.toLowerCase()}</p>
            <p className="type-meta mt-3 max-w-xs text-[var(--text-faint)]">
              Observability and improvement for AI agents.
            </p>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="type-meta mt-4 inline-block text-[var(--accent)] transition-colors hover:text-[var(--accent-hover)]"
            >
              {SUPPORT_EMAIL}
            </a>
          </div>
          {columns.map((col) => (
            <div key={col.title}>
              <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
                {col.title}
              </p>
              <ul className="mt-4 flex flex-col gap-2.5">
                {col.links.map((link) => (
                  <li key={`${col.title}:${link.href}`}>
                    {link.external ? (
                      <a
                        href={link.href}
                        className="type-ui text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
                        rel="noopener noreferrer"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="type-ui text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="type-meta mt-12 border-t border-[var(--line)] pt-6 text-[var(--text-faint)]">
          © {PRODUCT_COPYRIGHT_YEAR} {PRODUCT_NAME}. All rights reserved.
        </p>
      </MarketingRail>
    </footer>
  );
}
