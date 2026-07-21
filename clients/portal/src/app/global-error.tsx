"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { Button } from "@/components/ui/button";

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
                clears it; if it persists, contact{" "}
                <a
                  href="mailto:hello@edenobservability.com"
                  className="text-[var(--accent)] hover:underline"
                >
                  hello@edenobservability.com
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
              <Button type="button" onClick={reset}>
                <RefreshCw className="w-4 h-4" />
                Reload
              </Button>
              <Button asChild variant="outline">
                <Link href="/dashboard">
                  <Home className="w-4 h-4" />
                  Dashboard
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
