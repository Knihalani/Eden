"use client";

import { useEffect } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ds/primitives";

export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[portal]", error);
  }, [error]);

  return (
    <div className="ds-page overflow-y-auto">
      <PageHeader title="Something went wrong" />
      <div className="mx-auto flex max-w-md flex-col gap-4 px-5 py-10">
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
          <Link href="/home" className="ds-btn ds-btn-sm">
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}
