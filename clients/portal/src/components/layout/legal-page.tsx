import * as React from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Logo } from "@/components/brand/logo";
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
        <div className="max-w-5xl mx-auto px-6 h-full flex items-center justify-between">
          <Logo size="md" showWordmark href="/" />
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Back to home
          </Link>
        </div>
      </nav>

      <main className={cn("mx-auto px-6 py-16", maxW)}>
        <p className="text-[11px] font-mono font-semibold uppercase tracking-widest text-[var(--accent)] mb-3">
          {eyebrow}
        </p>
        <h1
          className="text-4xl md:text-5xl font-bold text-[var(--text-primary)] mb-4"
          style={{ letterSpacing: "-0.03em", lineHeight: 1.05 }}
        >
          {title}
        </h1>
        <p className="text-base text-[var(--text-secondary)] mb-12 leading-relaxed">
          {description}
        </p>
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
        <div className="mx-auto px-6 py-8 max-w-5xl flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-[var(--text-secondary)]">
            <Link
              href="/privacy"
              className="hover:text-[var(--text-primary)] transition-colors"
            >
              Privacy
            </Link>
            <Link
              href="/terms"
              className="hover:text-[var(--text-primary)] transition-colors"
            >
              Terms
            </Link>
            <Link
              href="/dpa"
              className="hover:text-[var(--text-primary)] transition-colors"
            >
              DPA
            </Link>
            <Link
              href="/security"
              className="hover:text-[var(--text-primary)] transition-colors"
            >
              Security
            </Link>
            <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
              <Link
                href="/api/v1/me/do-not-sell"
                prefetch={false}
                className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              >
                Do Not Sell My Info
              </Link>
              <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)]">
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
