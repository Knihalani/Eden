"use client";

import { ExportsTab } from "../../_components/exports-tab";
import { useOrg } from "@/hooks/use-org";
import { PageHeader } from "@/components/layout/page-header";
import { Download } from "lucide-react";

// Standalone /settings/exports deep-link that wraps the same
// ExportsTab used by the main settings page. The portal nav
// already surfaces this via the in-page tab list — this route
// exists for shareable URLs and SSR-friendly deep links.
export default function ExportsPage() {
  const { currentOrg } = useOrg();
  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <PageHeader
        eyebrow="Settings"
        title="Data exports"
        icon={Download}
        subtitle="Export traces, agents, audit logs, and other workspace data. Exports respect your retention policy."
      />
      <ExportsTab
        orgId={currentOrg?.id || ""}
        canManage={currentOrg?.role === "owner" || currentOrg?.role === "admin"}
      />
    </div>
  );
}
