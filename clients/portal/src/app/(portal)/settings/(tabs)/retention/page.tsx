"use client";

import { RetentionPolicyTab } from "../../_components/retention-policy-tab";
import { PageHeader } from "@/components/layout/page-header";
import { Database } from "lucide-react";

/**
 * Deep-link route — mirrors the in-page "Retention policy" tab
 * on /settings. The tab renders its own card-level header; we
 * add a page-level header here so deep links have proper
 * PageHeader with eyebrow/back context.
 */
export default function RetentionSettingsPage() {
  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      <PageHeader
        eyebrow="Settings"
        title="Data retention policy"
        icon={Database}
        subtitle="Per-table TTLs across hot/warm/cold tiers, with auto-deletion after the cold window expires."
      />
      <RetentionPolicyTab />
    </div>
  );
}
