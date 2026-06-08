"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import Link from "next/link";

export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Auth error:", error);
  }, [error]);

  return (
    <div className="flex items-center justify-center min-h-screen px-4 bg-[var(--bg-secondary)]">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="w-16 h-16 bg-[var(--error-bg)] rounded-2xl flex items-center justify-center mx-auto">
          <AlertTriangle className="w-8 h-8 text-[var(--error)]" />
        </div>

        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">
            Authentication error
          </h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Something went wrong while loading this page. Please try again.
          </p>
        </div>

        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-[var(--bg-primary)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-xl transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-[var(--text-primary)] bg-[var(--surface)] hover:bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-xl transition-colors"
          >
            <Home className="w-4 h-4" />
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}
