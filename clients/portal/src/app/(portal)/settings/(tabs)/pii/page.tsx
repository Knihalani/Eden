"use client";

import { PiiPolicyTab } from "../../_components/pii-policy-tab";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { ShieldAlert } from "lucide-react";

/**
 * Deep-link route — mirrors the in-page "PII policy" tab on
 * /settings. The tab renders its own card-level header; we add
 * the page-level header here so deep links have a proper
 * PageHeader with eyebrow/back context.
 */
export default function PiiSettingsPage() {
  return (
    <PageContent size="default">
      <PageHeader
        eyebrow="Settings"
        title="PII redaction policy"
        icon={ShieldAlert}
        subtitle="Control which sensitive categories get masked before traces leave your agent — emails, SSNs, JWTs, credential URLs, and more."
      />
      <PiiPolicyTab />
    
    </PageContent>
  );
}
