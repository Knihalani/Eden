/**
 * /agents/connect — post-onboarding "+ Connect new agent" flow.
 *
 * GitHub App install + repo link only. SDK auto-integrate PRs are retired.
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, GitBranch } from "lucide-react";
import { OnboardingConnectFlow } from "@/components/onboarding/OnboardingConnectFlow";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { usePermissions } from "@/hooks/use-permissions";
import type { GitHubRepo } from "@/lib/api";

export default function ConnectAgentPage() {
  const [linked, setLinked] = useState<GitHubRepo | null>(null);
  const { hasPermission } = usePermissions();

  if (!hasPermission("integrations:write")) {
    return (
      <NoOrgState
        feature="Admins only"
        description="Connecting a new agent requires the `integrations:write` permission. Ask an org owner or admin to perform this step."
      />
    );
  }

  return (
    <PageContent size="narrow">
      <Link
        href="/agents"
        className="inline-flex items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] mb-3 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to agents
      </Link>

      <PageHeader
        eyebrow="Agents"
        title="Connect a repository"
        subtitle="Install the Eden GitHub App and link a repo. Then install the SDK manually to start sending traces."
        icon={GitBranch}
        description="Link a GitHub repository so Eden can list it for agents and improvement plans."
      />

      {linked && (
        <div
          role="status"
          aria-live="polite"
          className="mb-6 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent-faint)] p-4"
        >
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--accent)]">
            <Check className="h-4 w-4" aria-hidden="true" />
            Linked {linked.full_name}
          </div>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Next: install the Eden SDK in that repo so traces appear on the dashboard.
          </p>
          <Link
            href="/agents"
            className="mt-2 inline-block text-xs text-[var(--accent)] underline"
          >
            Back to agents
          </Link>
        </div>
      )}

      <OnboardingConnectFlow
        onLinked={(repo) => setLinked(repo)}
      />
    </PageContent>
  );
}
