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
import { openCookiePreferences } from "@/lib/analytics";

const linkClass =
  "inline-flex items-center min-h-11 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)] rounded-md";

export function MarketingFooter() {
  const t = useTranslations();

  return (
    <footer className="border-t border-[var(--border-subtle)] py-space-8 px-space-5">
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-space-7">
        <div className="md:col-span-5 flex flex-col gap-space-3">
          <Logo size="sm" showWordmark href="/" />
          <p className="text-sm text-[var(--text-muted)] max-w-xs leading-relaxed">
            {PRODUCT_TAGLINE}
          </p>
          <p className="text-xs font-mono text-[var(--text-faint)]">
            © {PRODUCT_COPYRIGHT_YEAR} Eden · {PRODUCT_VERSION}
          </p>
        </div>

        <div className="md:col-span-7 grid grid-cols-2 sm:grid-cols-4 gap-space-6">
          <nav aria-label={t("footer.product")} className="flex flex-col gap-space-1">
            <span className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--text-muted)] mb-space-2">
              {t("footer.product")}
            </span>
            <Link href="/pricing" className={linkClass}>
              {t("footer.pricing")}
            </Link>
            <Link href="/security" className={linkClass}>
              {t("footer.security")}
            </Link>
            <Link href="/status" className={linkClass}>
              {t("footer.status")}
            </Link>
            <Link href="/contact" className={linkClass}>
              {t("footer.contact")}
            </Link>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              {t("footer.documentation")}
            </a>
            <Link href="/sign-up" className={linkClass}>
              {t("footer.signup")}
            </Link>
            <Link href="/sign-in" className={linkClass}>
              {t("footer.signin")}
            </Link>
          </nav>
          <nav aria-label={t("footer.resources")} className="flex flex-col gap-space-1">
            <span className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--text-muted)] mb-space-2">
              {t("footer.resources")}
            </span>
            <a
              href={DOCS_QUICKSTART_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              {t("footer.quickstart")}
            </a>
            <Link href="/about" className={linkClass}>
              {t("footer.about")}
            </Link>
            <Link href="/changelog" className={linkClass}>
              {t("footer.changelog")}
            </Link>
            <a
              href={`${DOCS_URL}/reference/`}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              {t("footer.apiReference")}
            </a>
          </nav>
          <nav aria-label={t("footer.legal")} className="flex flex-col gap-space-1">
            <span className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--text-muted)] mb-space-2">
              {t("footer.legal")}
            </span>
            <Link href="/privacy" className={linkClass}>
              {t("footer.privacy")}
            </Link>
            <button
              type="button"
              onClick={() => openCookiePreferences()}
              className={linkClass}
            >
              {t("footer.cookiePreferences")}
            </button>
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
          <div className="flex flex-col gap-space-1">
            <span className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--text-muted)] mb-space-2">
              {t("footer.locale")}
            </span>
            <LocaleSwitcher />
            <span className="inline-flex flex-wrap items-baseline gap-space-2 text-sm mt-space-1">
              <Link href="/do-not-sell" className={linkClass} title={t("footer.doNotSell")}>
                {t("footer.doNotSell")}
              </Link>
              <span className="text-2xs font-mono uppercase tracking-[0.18em] text-[var(--text-faint)]">
                CCPA
              </span>
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
