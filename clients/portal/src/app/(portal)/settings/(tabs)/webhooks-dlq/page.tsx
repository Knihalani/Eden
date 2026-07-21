"use client";

import { useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

/**
 * Dual FS stub — redirect only (S14).
 * Canonical UI lives on `/settings?tab=webhooks-dlq`.
 */
function WebhooksDlqRedirectInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "webhooks-dlq");
    const qs = params.toString();
    router.replace(`/settings${qs ? `?${qs}` : ""}`);
  }, [router, searchParams]);

  return (
    <div
      className="flex items-center justify-center gap-2 p-12 text-sm text-[var(--text-muted)]"
      role="status"
      aria-live="polite"
      data-ws7-dlq-redirect
    >
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      Redirecting to Webhook DLQ settings…
    </div>
  );
}

export default function WebhooksDlqRedirect() {
  return (
    <Suspense
      fallback={
        <div
          className="flex items-center justify-center gap-2 p-12 text-sm text-[var(--text-muted)]"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading…
        </div>
      }
    >
      <WebhooksDlqRedirectInner />
    </Suspense>
  );
}
