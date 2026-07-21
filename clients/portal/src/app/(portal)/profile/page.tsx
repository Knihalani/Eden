"use client";

/**
 * /profile permanently redirects to /settings?tab=account.
 * Kept as a thin wrapper for any client navigations that land here
 * before the next.config redirect fires.
 */

import { User } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { AccountPanel } from "@/app/(portal)/settings/_components/account-panel";

export default function ProfilePage() {
  return (
    <PageContent size="narrow">
      <PageHeader
        eyebrow="Account"
        title="Profile"
        subtitle="Manage your account settings, security, and authentication."
        icon={User}
      />
      <AccountPanel />
    </PageContent>
  );
}
