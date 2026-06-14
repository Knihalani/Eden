/**
 * /traces — Trace Explorer (June 2026)
 *
 * The user's mental model is "Trace Explorer is a top-level surface"
 * but historically traces have lived inside /observability as a tab.
 * This page makes the surface a real route so the sidebar entry has
 * a stable URL + the deep-links from email alerts ("3 new failed
 * traces") have somewhere to land.
 *
 * Under the hood it currently redirects to /observability so the
 * existing 6-tab page renders unchanged. We pre-select the "traces"
 * tab via the hash so users land in the right place. If we later
 * extract the Traces tab into a standalone component, we'll render
 * it inline here without the redirect.
 */
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

export default function TracesPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/observability#traces");
  }, [router]);

  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
      <span className="ml-3 text-sm text-[var(--text-muted)]">
        Loading trace explorer…
      </span>
    </div>
  );
}
