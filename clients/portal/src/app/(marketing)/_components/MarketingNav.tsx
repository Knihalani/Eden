"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Menu, X } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { isExternalHref } from "@/lib/utils";
import { NAV_LINKS } from "./marketing-data";

export function MarketingNav({ signedIn }: { signedIn: boolean }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const menuId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileMenuOpen(false);
        menuButtonRef.current?.focus();
        return;
      }
      if (e.key !== "Tab" || !menuPanelRef.current) return;
      const focusables = menuPanelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileMenuOpen]);

  useEffect(() => {
    if (!mobileMenuOpen || !menuPanelRef.current) return;
    const first = menuPanelRef.current.querySelector<HTMLElement>("a[href]");
    first?.focus();
  }, [mobileMenuOpen]);

  const linkClass =
    "px-3 py-2 min-h-11 inline-flex items-center text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]";

  const primaryCtaClass =
    "inline-flex items-center justify-center gap-2 min-h-11 px-4 py-2 text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]";

  const secondaryCtaClass =
    "inline-flex items-center justify-center min-h-11 px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]";

  return (
    <nav
      className="sticky top-0 z-40 h-16 bg-[var(--bg-primary)]/80 backdrop-blur-xl border-b border-[var(--border-subtle)]"
      style={{ backdropFilter: "blur(16px)" }}
      aria-label="Marketing"
    >
      <div className="max-w-7xl mx-auto px-6 h-full flex items-center justify-between gap-4">
        <Logo size="md" showWordmark priority href="/" />

        <div className="hidden md:flex items-center gap-0.5">
          {NAV_LINKS.map((link) =>
            isExternalHref(link.href) ? (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClass}
              >
                {link.label}
              </a>
            ) : (
              <Link key={link.label} href={link.href} className={linkClass}>
                {link.label}
              </Link>
            ),
          )}
        </div>

        <div className="hidden md:flex items-center gap-2 shrink-0">
          {signedIn ? (
            <Link href="/dashboard" className={primaryCtaClass}>
              Open dashboard
              <ArrowRight className="w-4 h-4" aria-hidden />
            </Link>
          ) : (
            <>
              <Link href="/sign-in" className={secondaryCtaClass}>
                Sign in
              </Link>
              <Link href="/sign-up" className={primaryCtaClass}>
                Start free
                <ArrowRight className="w-4 h-4" aria-hidden />
              </Link>
            </>
          )}
        </div>

        <button
          ref={menuButtonRef}
          type="button"
          className="md:hidden p-2 min-h-11 min-w-11 inline-flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          onClick={() => setMobileMenuOpen((open) => !open)}
          aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileMenuOpen}
          aria-controls={menuId}
        >
          {mobileMenuOpen ? (
            <X className="w-5 h-5" aria-hidden />
          ) : (
            <Menu className="w-5 h-5" aria-hidden />
          )}
        </button>
      </div>

      {mobileMenuOpen && (
        <div
          id={menuId}
          ref={menuPanelRef}
          className="md:hidden absolute top-16 left-0 right-0 bg-[var(--bg-primary)] border-b border-[var(--border-subtle)] px-6 py-4 flex flex-col gap-1 max-h-[calc(100dvh-4rem)] overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
        >
          <div className="mb-1 flex items-center justify-end">
            <button
              type="button"
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              aria-label="Close menu"
              onClick={() => {
                setMobileMenuOpen(false);
                menuButtonRef.current?.focus();
              }}
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          {NAV_LINKS.map((link) =>
            isExternalHref(link.href) ? (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClass}
                onClick={() => setMobileMenuOpen(false)}
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.label}
                href={link.href}
                className={linkClass}
                onClick={() => setMobileMenuOpen(false)}
              >
                {link.label}
              </Link>
            ),
          )}
          <div className="flex flex-col gap-2 mt-2 pt-3 border-t border-[var(--border-subtle)]">
            {signedIn ? (
              <Link
                href="/dashboard"
                className={`${primaryCtaClass} w-full`}
                onClick={() => setMobileMenuOpen(false)}
              >
                Open dashboard
              </Link>
            ) : (
              <>
                <Link
                  href="/sign-in"
                  className="inline-flex items-center justify-center min-h-11 px-4 py-2.5 text-sm text-center text-[var(--text-secondary)] border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  Sign in
                </Link>
                <Link
                  href="/sign-up"
                  className={`${primaryCtaClass} w-full`}
                  onClick={() => setMobileMenuOpen(false)}
                >
                  Start free
                </Link>
              </>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
