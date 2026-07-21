"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw, Home, Bug } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

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
        <div className="w-16 h-16 bg-[var(--error-dim)] border border-[var(--error)]/20 rounded-2xl flex items-center justify-center mx-auto">
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
          <div className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded-xl p-4 text-left">
            <div className="flex items-center gap-2 mb-2">
              <Bug className="w-4 h-4 text-[var(--text-muted)]" />
              <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide font-mono">
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
          <Button type="button" onClick={reset}>
            <RefreshCw className="w-4 h-4" />
            Try again
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
  );
}
