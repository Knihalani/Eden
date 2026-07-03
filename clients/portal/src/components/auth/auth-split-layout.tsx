import Link from "next/link";
import { Layers } from "lucide-react";
import { PRODUCT_VERSION } from "@/lib/constants";

interface AuthSplitLayoutProps {
  brandPanel: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Two-column auth chrome used by /sign-in, /sign-up, /login,
 * /signup, /forgot-password, and /reset-password.
 *
 * Desktop (md+): brand panel on the left, form on the right.
 * Mobile: brand panel collapses to a compact header (logo +
 * product tagline), form fills the rest of the viewport. We
 * intentionally don't show the full brand panel on mobile — it
 * would push the form below the fold and force excessive
 * scrolling on the smallest screens.
 *
 * The brandPanel prop is rendered as-is; the panel component is
 * responsible for its own min-height + background so the
 * split-layout stays purely structural.
 */
export function AuthSplitLayout({ brandPanel, children }: AuthSplitLayoutProps) {
  return (
    // Site-wide fix (July 2026): ``min-h-dvh`` (not ``h-screen``)
    // so the layout grows past the viewport when the auth form is
    // tall (multi-step verification, password reset, sso-callback).
    // Combined with the root layout's ``html min-h-full`` + body
    // ``min-h-full``, the document now scrolls natively instead of
    // clipping. Brand panel uses ``md:min-h-dvh`` so it stays full
    // height on desktop but doesn't force the row taller than the
    // form content on mobile.
    <div className="grid min-h-dvh grid-cols-1 bg-[var(--bg-secondary)] md:grid-cols-[55%_1fr]">
      {/* Left: Brand panel — hidden on mobile (compact header above replaces it) */}
      <div className="relative hidden md:block md:min-h-dvh">{brandPanel}</div>

      {/* Mobile-only compact header with logo + tagline */}
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-primary)] px-6 py-4 md:hidden">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)] shadow-md shadow-[var(--accent)]/30">
            <Layers className="h-4 w-4 text-[var(--bg-base)]" strokeWidth={2.5} />
          </div>
          <span className="text-base font-bold tracking-tight text-[var(--text-primary)]">
            Eden
          </span>
        </Link>
        <p className="font-mono text-[11px] tracking-wide text-[var(--text-muted)]" aria-label="Eden product version">
          {PRODUCT_VERSION} · observability
        </p>
      </div>

      {/* Right: Form content — grows past viewport on tall forms.
          ``items-start md:items-center`` so mobile users land at the
          top of the form (no need to scroll to reach the first
          input) while desktop centers the form vertically within
          the viewport. */}
      <div className="flex items-start justify-center bg-[var(--bg-secondary)] px-6 py-10 md:items-center md:p-8 md:py-12">
        {children}
      </div>
    </div>
  );
}