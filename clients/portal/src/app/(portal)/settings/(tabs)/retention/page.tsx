"use client";

import { RetentionPolicyTab } from "../../_components/retention-policy-tab";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Database } from "lucide-react";

/**
 * Deep-link route — mirrors the in-page "Retention policy" tab
 * on /settings. The tab renders its own card-level header; we
 * add a page-level header here so deep links have proper
 * PageHeader with eyebrow/back context.
 */
export default function RetentionSettingsPage() {
  return (
    <PageContent size="default">
      <PageHeader
        eyebrow="Settings"
        title="Data retention policy"
        icon={Database}
        subtitle="Per-table TTLs across hot/warm/cold tiers, with auto-deletion after the cold window expires."
      />
      <RetentionPolicyTab />
    
    </PageContent>
  );
}
