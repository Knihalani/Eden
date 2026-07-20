"use client";

import { ExportsTab } from "../../_components/exports-tab";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { isAdminOrOwner } from "@/lib/roles";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Download } from "lucide-react";

// Standalone /settings/exports deep-link that wraps the same
// ExportsTab used by the main settings page. The portal nav
// already surfaces this via the in-page tab list — this route
// exists for shareable URLs and SSR-friendly deep links.
export default function ExportsPage() {
  const { currentOrg, refreshOrgs, orgSyncing, orgSyncTimedOut } = useOrg();
  const { role: resolvedRole } = usePermissions();
  if (!currentOrg) {
    return (
      <NoOrgState
        feature="Data exports"
        syncing={orgSyncing && !orgSyncTimedOut}
        syncTimedOut={orgSyncTimedOut}
        onRetrySync={() => void refreshOrgs()}
      />
    );
  }
  const canManage =
    isAdminOrOwner(resolvedRole) || isAdminOrOwner(currentOrg.role);
  return (
    <PageContent>
      <PageHeader
        eyebrow="Settings"
        title="Data exports"
        icon={Download}
        subtitle="Export traces, agents, audit logs, and other workspace data. Exports respect your retention policy."
      />
      <ExportsTab orgId={currentOrg.id} canManage={canManage} />
    </PageContent>
  );
}
