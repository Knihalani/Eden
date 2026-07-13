"use client";

import { ExportsTab } from "../../_components/exports-tab";
import { useOrg } from "@/hooks/use-org";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Download } from "lucide-react";

// Standalone /settings/exports deep-link that wraps the same
// ExportsTab used by the main settings page. The portal nav
// already surfaces this via the in-page tab list — this route
// exists for shareable URLs and SSR-friendly deep links.
export default function ExportsPage() {
  const { currentOrg } = useOrg();
  if (!currentOrg) return <NoOrgState feature="Data exports" />;
  return (
    <PageContent>
      <PageHeader
        eyebrow="Settings"
        title="Data exports"
        icon={Download}
        subtitle="Export traces, agents, audit logs, and other workspace data. Exports respect your retention policy."
      />
      <ExportsTab
        orgId={currentOrg.id}
        canManage={currentOrg.role === "owner" || currentOrg.role === "admin"}
      />
    </PageContent>
  );
}
