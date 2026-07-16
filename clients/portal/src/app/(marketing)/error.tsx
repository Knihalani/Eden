"use client";

import { useEffect } from "react";
import Link from "next/link";
import { SUPPORT_EMAIL } from "@/lib/constants";

/** Marketing 500 — landing page error. Kept minimal so it doesn't
 *  leak server details on a public surface. */
export default function MarketingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
     
    console.error("Marketing error:", error);
  }, [error]);

  return (
    <div className="flex items-center justify-center min-h-screen px-4 bg-[var(--bg-base)]">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="w-16 h-16 bg-[var(--error-dim)] border border-[var(--error)]/20 rounded-2xl flex items-center justify-center mx-auto">
          <AlertTriangle className="w-8 h-8 text-[var(--error)]" />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">
            The page failed to load
          </h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Reloading usually clears this. If it keeps happening, drop us a
            line at <a href={`mailto:${SUPPORT_EMAIL}`} className="text-[var(--accent)] hover:underline">{SUPPORT_EMAIL}</a>.
          </p>
        </div>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-[var(--bg-primary)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-xl transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Retry
          </button>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-xl transition-colors"
          >
            <Home className="w-4 h-4" />
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}