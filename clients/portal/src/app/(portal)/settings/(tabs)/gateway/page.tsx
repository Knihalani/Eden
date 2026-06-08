"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * A2 — /settings/gateway
 *
 * The portal renders the gateway tab as part of the unified
 * ``/settings`` page (the existing single-page tab UI); this
 * route exists so deep links of the form ``/settings/gateway``
 * work for users who bookmark the AI Gateway section. We
 * redirect to ``/settings?tab=gateway`` which the page
 * interprets.
 */
export default function GatewaySettingsRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    // Preserve any query params (e.g. flash messages) while
    // forwarding to the unified page with ``tab=gateway``.
    const params = new URLSearchParams(searchParams.toString());
    if (!params.has("tab")) {
      params.set("tab", "gateway");
    }
    const qs = params.toString();
    router.replace(`/settings${qs ? `?${qs}` : ""}`);
  }, [router, searchParams]);

  return (
    <div className="p-8 text-sm text-[var(--text-muted)]">
      Redirecting to AI Gateway settings…
    </div>
  );
}
