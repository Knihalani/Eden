"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

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
    <div className="flex items-center justify-center min-h-screen px-space-4 bg-[var(--bg-base)]">
      <div className="max-w-md w-full text-center space-y-space-5 page-enter">
        <div className="w-16 h-16 bg-[var(--error-dim)] border border-[var(--error)]/20 rounded-2xl flex items-center justify-center mx-auto">
          <AlertTriangle className="w-8 h-8 text-[var(--error)]" />
        </div>

        <div className="space-y-space-2">
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">
            Authentication error
          </h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Something went wrong while loading this page. Please try again.
          </p>
        </div>

        <div className="flex items-center justify-center gap-space-3">
          <Button type="button" onClick={reset} className="min-h-11">
            <RefreshCw className="w-4 h-4" />
            Try again
          </Button>
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/">
              <Home className="w-4 h-4" />
              Home
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
