import * as React from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { SignedInGate } from "@/app/(marketing)/_components/SignedInGate";
import { cn } from "@/lib/utils";


export interface LegalPageProps {
  /** Eyebrow label above the H1 (e.g. "Legal", "Security"). */
  eyebrow: string;
  /** H1 text — already wraps in the right tracking + sizing. */
  title: string;
  /** Lead paragraph below the H1. ReactNode so legal pages can embed <strong>/<Link>. */
  description: React.ReactNode;
  /** Page content. */
  children: React.ReactNode;
  /** Tailwind: max-w-3xl (default), max-w-4xl, or max-w-5xl. */
  size?: "narrow" | "medium" | "wide";
  /** When true, show a counsel-review draft banner above the content. */
  draft?: boolean;
}

/**
 * LegalPage — shared shell for /privacy, /terms, /security, /dpa.
 * Replaces the four hand-rolled `min-h-screen bg-[var(--bg-secondary)]`
 * + sticky nav + back-link + heading stacks that were drifting across
 * the marketing legal surface. Keeps each page free to focus on its
 * section content (the actual clauses).
 */
export function LegalPage({
  eyebrow,
  title,
  description,
  children,
  size = "narrow",
  draft = false,
}: LegalPageProps) {
  const maxW =
    size === "wide"
      ? "max-w-5xl"
      : size === "medium"
        ? "max-w-4xl"
        : "max-w-3xl";
  return (
    <div className="min-h-screen bg-[var(--bg-secondary)]">
      <nav className="sticky top-0 z-50 h-16 bg-[var(--bg-primary)]/90 backdrop-blur-xl border-b border-[var(--border-subtle)]">
        <div className="max-w-5xl mx-auto px-space-5 h-full flex items-center justify-between gap-space-4">
          <Logo size="md" showWordmark href="/" />
          <div className="flex items-center gap-space-1 sm:gap-space-2">
            <Link
              href="/pricing"
              className="hidden sm:inline-flex items-center min-h-11 px-space-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded-lg"
            >
              Pricing
            </Link>
            <Link
              href="/contact"
              className="hidden md:inline-flex items-center min-h-11 px-space-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded-lg"
            >
              Contact
            </Link>
            <SignedInGate
              signedIn={
                <Link
                  href="/dashboard"
                  className="inline-flex items-center justify-center min-h-11 px-space-4 text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
                >
                  Open dashboard
                </Link>
              }
              signedOut={
                <>
                  <Link
                    href="/sign-in"
                    className="hidden sm:inline-flex items-center justify-center min-h-11 px-space-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded-lg"
                  >
                    Sign in
                  </Link>
                  <Link
                    href="/sign-up"
                    className="inline-flex items-center justify-center min-h-11 px-space-4 text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
                  >
                    Start free
                  </Link>
                </>
              }
            />

            <Link
              href="/"
              className="inline-flex items-center gap-space-2 min-h-11 px-space-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded-lg"
            >
              <ChevronLeft className="w-4 h-4" aria-hidden />
              Back to home
            </Link>
          </div>
        </div>
      </nav>

      <main className={cn("mx-auto px-space-5 py-14 md:py-20", maxW)}>
        <p className="text-xs font-mono font-semibold uppercase tracking-widest text-[var(--accent)] mb-space-3">
          {eyebrow}
        </p>
        <h1 className="h1-fluid mb-space-4 text-[var(--text-primary)]">
          {title}
        </h1>
        <p className="text-base text-[var(--text-secondary)] mb-space-7 md:mb-space-8 leading-relaxed max-w-2xl">
          {description}
        </p>
        {draft && (
          <div
            role="status"
            className="mb-space-6 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]/60 px-space-4 py-space-3"
          >
            <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--text-muted)] mb-space-2">
              Draft
            </p>
            <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
              For counsel review — this page has not received final legal sign-off.
              Do not rely on it for contractual purposes until published.
            </p>
          </div>
        )}
        {children}
      </main>

      {/* F71 — marketing footer with CCPA "Do Not Sell" link.
       * Per the prod-ready checklist §1.5: every marketing page
       * MUST surface the "Do Not Sell My Personal Information"
       * link so California residents can opt out. The link
       * posts to the CCPA endpoint exposed by the backend
       * (compliance.do_not_sell); the page itself is just a
       * "we received your request" confirmation via the API
       * envelope.
       *
       * Layout: a single column of small, muted links on a
       * border-top divider. The Do Not Sell link is visually
       * grouped with Privacy / Terms / DPA / Security so
       * the legal context is obvious — CCPA isn't an
       * afterthought; it's part of the same footer rail. */}
      <footer className="border-t border-[var(--border-subtle)] mt-16">
        <div className="mx-auto px-space-5 py-space-6 max-w-5xl flex flex-col gap-space-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-space-2 text-sm text-[var(--text-secondary)]">
            <Link
              href="/about"
              className="hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
            >
              About
            </Link>
            <Link
              href="/pricing"
              className="hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
            >
              Pricing
            </Link>
            <Link
              href="/contact"
              className="hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
            >
              Contact
            </Link>
            <Link
              href="/changelog"
              className="hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
            >
              Changelog
            </Link>
            <Link
              href="/privacy"
              className="hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
            >
              Privacy
            </Link>
            <Link
              href="/terms"
              className="hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
            >
              Terms
            </Link>
            <Link
              href="/dpa"
              className="hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
            >
              DPA
            </Link>
            <Link
              href="/security"
              className="hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
            >
              Security
            </Link>
            <Link
              href="/subprocessors"
              className="hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
            >
              Subprocessors
            </Link>
            <span className="inline-flex items-baseline gap-space-2 whitespace-nowrap">
              <Link
                href="/do-not-sell"
                className="hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
              >
                Do Not Sell My Info
              </Link>
              <span className="text-2xs font-mono uppercase tracking-[0.18em] text-[var(--text-faint)]">
                CCPA
              </span>
            </span>
          </div>
          <p className="text-xs text-[var(--text-faint)]">
            &copy; {new Date().getFullYear()} Eden
          </p>
        </div>
      </footer>
    </div>
  );
}
