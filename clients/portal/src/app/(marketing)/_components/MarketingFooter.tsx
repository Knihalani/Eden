"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Logo } from "@/components/brand/logo";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import {
  PRODUCT_VERSION,
  PRODUCT_COPYRIGHT_YEAR,
  PRODUCT_TAGLINE,
  DOCS_URL,
  DOCS_QUICKSTART_URL,
} from "@/lib/constants";

const linkClass =
  "inline-flex items-center min-h-11 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)] rounded-md";

export function MarketingFooter() {
  const t = useTranslations();

  return (
    <footer className="border-t border-[var(--border-subtle)] py-12 px-6">
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-10">
        <div className="md:col-span-5 flex flex-col gap-3">
          <Logo size="sm" showWordmark href="/" />
          <p className="text-sm text-[var(--text-muted)] max-w-xs leading-relaxed">
            {PRODUCT_TAGLINE}
          </p>
          <p className="text-[11px] font-mono text-[var(--text-faint)]">
            © {PRODUCT_COPYRIGHT_YEAR} Eden · {PRODUCT_VERSION}
          </p>
        </div>

        <div className="md:col-span-7 grid grid-cols-2 sm:grid-cols-4 gap-8">
          <nav aria-label="Product" className="flex flex-col gap-1">
            <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)] mb-2">
              Product
            </span>
            <Link href="/pricing" className={linkClass}>
              Pricing
            </Link>
            <Link href="/security" className={linkClass}>
              Security
            </Link>
            <Link href="/contact" className={linkClass}>
              Contact
            </Link>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              Documentation
            </a>
            <Link href="/sign-up" className={linkClass}>
              Sign up
            </Link>
            <Link href="/sign-in" className={linkClass}>
              Sign in
            </Link>
          </nav>
          <nav aria-label="Resources" className="flex flex-col gap-1">
            <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)] mb-2">
              Resources
            </span>
            <a
              href={DOCS_QUICKSTART_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              Quickstart
            </a>
            <Link href="/about" className={linkClass}>
              About
            </Link>
            <Link href="/changelog" className={linkClass}>
              Changelog
            </Link>
            <a
              href={`${DOCS_URL}/reference/`}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              API reference
            </a>
          </nav>
          <nav aria-label="Legal" className="flex flex-col gap-1">
            <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)] mb-2">
              Legal
            </span>
            <Link href="/privacy" className={linkClass}>
              {t("footer.privacy")}
            </Link>
            <Link href="/terms" className={linkClass}>
              {t("footer.terms")}
            </Link>
            <Link href="/dpa" className={linkClass}>
              {t("footer.dpa")}
            </Link>
            <Link href="/security" className={linkClass}>
              {t("footer.security")}
            </Link>
            <Link href="/subprocessors" className={linkClass}>
              {t("footer.subprocessors")}
            </Link>
          </nav>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)] mb-2">
              Locale
            </span>
            <LocaleSwitcher />
            <span className="inline-flex items-baseline gap-1.5 text-sm whitespace-nowrap mt-1">
              <Link href="/do-not-sell" className={linkClass}>
                Do Not Sell My Info
              </Link>
              <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)]">
                CCPA
              </span>
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
