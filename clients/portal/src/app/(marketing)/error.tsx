"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
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
    <div className="flex items-center justify-center min-h-screen px-space-4 bg-[var(--bg-base)]">
      <div className="max-w-md w-full text-center space-y-space-5">
        <div className="w-16 h-16 bg-[var(--error-dim)] border border-[var(--error)]/20 rounded-2xl flex items-center justify-center mx-auto">
          <AlertTriangle className="w-8 h-8 text-[var(--error)]" />
        </div>
        <div className="space-y-space-2">
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">
            The page failed to load
          </h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Reloading usually clears this. If it keeps happening, drop us a
            line at <a href={`mailto:${SUPPORT_EMAIL}`} className="text-[var(--accent)] hover:underline">{SUPPORT_EMAIL}</a>.
          </p>
        </div>
        <div className="flex items-center justify-center gap-space-3">
          <Button type="button" onClick={reset} className="min-h-11">
            <RefreshCw className="w-4 h-4" />
            Retry
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
