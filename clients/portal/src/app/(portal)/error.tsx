"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw, Home, Bug } from "lucide-react";
import Link from "next/link";

export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log error to console in development
    console.error("Portal error:", error);
  }, [error]);

  return (
    <div className="flex items-center justify-center min-h-[60vh] px-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="w-16 h-16 bg-[var(--error-bg)] rounded-2xl flex items-center justify-center mx-auto">
          <AlertTriangle className="w-8 h-8 text-[var(--error)]" />
        </div>

        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">
            Something went wrong
          </h1>
          <p className="text-sm text-[var(--text-secondary)]">
            We encountered an unexpected error. Try refreshing the page or go back to the dashboard.
          </p>
        </div>

        {error.message && (
          <div className="bg-[var(--bg-tertiary)] rounded-xl p-4 text-left">
            <div className="flex items-center gap-2 mb-2">
              <Bug className="w-4 h-4 text-[var(--text-muted)]" />
              <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                Error details
              </span>
            </div>
            <p className="text-xs text-[var(--error)] font-mono break-all">
              {error.message}
            </p>
            {error.digest && (
              <p className="text-xs text-[var(--text-muted)] font-mono mt-1">
                Digest: {error.digest}
              </p>
            )}
          </div>
        )}

        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-[var(--bg-primary)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-xl transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Try again
          </button>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-[var(--text-primary)] bg-[var(--surface)] hover:bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-xl transition-colors"
          >
            <Home className="w-4 h-4" />
            Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
