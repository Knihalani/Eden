"use client";

import { ExportsTab } from "../../_components/exports-tab";
import { useOrg } from "@/hooks/use-org";

// Standalone /settings/exports deep-link that wraps the same
// ExportsTab used by the main settings page. The portal nav
// already surfaces this via the in-page tab list — this route
// exists for shareable URLs and SSR-friendly deep links.
export default function ExportsPage() {
  const { currentOrg } = useOrg();
  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <ExportsTab
        orgId={currentOrg?.id || ""}
        canManage={currentOrg?.role === "owner" || currentOrg?.role === "admin"}
      />
    </div>
  );
}
