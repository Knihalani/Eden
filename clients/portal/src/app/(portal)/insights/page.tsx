"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

/** Soft-deleted top-level Insights — lives under Analytics → Insights. */
export default function InsightsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/analytics?tab=insights");
  }, [router]);

  return (
    <div
      className="flex h-48 items-center justify-center"
      aria-busy="true"
      data-wave6-analytics="insights-redirect"
    >
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  );
}
