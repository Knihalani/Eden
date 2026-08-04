"use client";

import { useEffect } from "react";
import Link from "next/link";
import { reportClientError } from "@/lib/client-error-reporter";

export default function MarketingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[marketing]", error);
    reportClientError("marketing", error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col justify-center gap-4 px-5 py-16">
      <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
        Error
      </p>
      <h1 className="text-[1.5rem] font-semibold tracking-[-0.02em] text-[var(--text)]">
        Something went wrong
      </h1>
      <p className="type-body text-[var(--text-secondary)]">
        {error.message || "This page hit an unexpected error."}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="ds-btn ds-btn-primary ds-btn-sm"
          onClick={reset}
        >
          Try again
        </button>
        <Link href="/" className="ds-btn ds-btn-sm">
          Home
        </Link>
      </div>
    </div>
  );
}
