"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ds/primitives";

/**
 * Legacy GitHub App callback target.
 * ``GITHUB_APP_CALLBACK_URL`` historically pointed here; keep the route
 * so installs still land, then hand off to ``/agents/connect``.
 */
function RedirectInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    const q = params.toString();
    router.replace(q ? `/agents/connect?${q}` : "/agents/connect");
  }, [router, searchParams]);

  return (
    <div className="ds-page">
      <PageHeader
        title="Connecting GitHub…"
        meta={<span className="type-meta">Taking you to choose a repository</span>}
      />
    </div>
  );
}

export default function OnboardingConnectRedirectPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader title="Connecting GitHub…" />
        </div>
      }
    >
      <RedirectInner />
    </Suspense>
  );
}
