import Link from "next/link";
import { Layers } from "lucide-react";

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
    <div className="min-h-screen grid grid-cols-1 md:grid-cols-[55%_1fr] bg-[var(--bg-secondary)]">
      {/* Left: Brand panel — hidden on mobile (compact header above replaces it) */}
      <div className="hidden md:block relative">{brandPanel}</div>

      {/* Mobile-only compact header with logo + tagline */}
      <div className="md:hidden flex items-center justify-between px-6 py-4 border-b border-[var(--border-subtle)] bg-[var(--bg-primary)]">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-[var(--accent)] rounded-lg flex items-center justify-center shadow-md shadow-[var(--accent)]/30">
            <Layers className="w-4 h-4 text-[var(--bg-base)]" strokeWidth={2.5} />
          </div>
          <span className="text-base font-bold text-[var(--text-primary)] tracking-tight">
            Eden
          </span>
        </Link>
        <p className="text-[11px] font-mono text-[var(--text-muted)] tracking-wide">
          v3.0 · observability
        </p>
      </div>

      {/* Right: Form content */}
      <div className="flex items-center justify-center px-6 py-10 md:p-8 md:py-12 bg-[var(--bg-secondary)]">
        {children}
      </div>
    </div>
  );
}