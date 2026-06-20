"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";

/** Global 500 — ponytail: matches (portal)/error.tsx styling but lives
 *  at the root so it catches errors that escape the (portal) error
 *  boundary (root-layout failure, unhandled provider crashes, etc.).
 *  Per Next.js docs, global-error must include <html><body> because it
 *  replaces the entire document on activation. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("Global portal error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--bg-base)] text-[var(--text-primary)] antialiased">
        <div className="flex items-center justify-center min-h-screen px-4">
          <div className="max-w-md w-full text-center space-y-6">
            <div className="w-16 h-16 bg-[var(--error-dim)] border border-[var(--error)]/20 rounded-2xl flex items-center justify-center mx-auto">
              <AlertTriangle className="w-8 h-8 text-[var(--error)]" />
            </div>

            <div className="space-y-2">
              <h1 className="text-xl font-semibold">Something broke server-side</h1>
              <p className="text-sm text-[var(--text-secondary)]">
                Eden hit an unexpected error rendering this page. Reloading usually
                clears it; if it persists, check{" "}
                <a
                  href="https://status.edenobservability.com"
                  className="text-[var(--accent)] hover:underline"
                >
                  status.edenobservability.com
                </a>
                .
              </p>
            </div>

            {error.digest && (
              <p className="text-xs text-[var(--text-muted)] font-mono">
                Error ID: {error.digest}
              </p>
            )}

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={reset}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-[var(--bg-primary)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-xl transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                Reload
              </button>
              <a
                href="/dashboard"
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-xl transition-colors"
              >
                <Home className="w-4 h-4" />
                Dashboard
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}