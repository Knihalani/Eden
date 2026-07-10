/**
 * /agents/connect — post-onboarding "+ Connect new agent" flow.
 *
 * Same OnboardingConnectFlow component as the wizard's step 4, but
 * standalone — no progress bar, lives inside the regular portal
 * layout. After a successful PR open, polls the PR-run status and
 * surfaces it in-page so the user doesn't have to leave for GitHub.
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, GitBranch } from "lucide-react";
import { OnboardingConnectFlow } from "@/components/onboarding/OnboardingConnectFlow";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { usePermissions } from "@/hooks/use-permissions";
import type { OnboardingPRRun } from "@/lib/api";

export default function ConnectAgentPage() {
  const [lastRun, setLastRun] = useState<OnboardingPRRun | null>(null);
  const { hasPermission } = usePermissions();

  // Gate on the permission the inner ``OnboardingConnectFlow`` actually
  // enforces (owner/admin only) — not the generic ``jobs:write`` which
  // is granted to plain ``member``. Previously a member passed this
  // gate then hit a ``PanelLocked`` wall inside the flow, while an
  // ``owner`` demoted by the Clerk webhook race got the same wall.
  // June 2026 fix aligns the page gate with the inner flow's
  // ``canIntegrate = role === "owner" || role === "admin"`` check.
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
        eyebrow="Fleet"
        title="Connect a new agent"
        subtitle="Wire another repo into Eden. Same flow as the onboarding wizard — pick a repo, Eden opens an SDK-integration PR."
        icon={GitBranch}
      />

      {lastRun && lastRun.pr_url && (
        <div
          role="status"
          aria-live="polite"
          className="mb-6 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent-faint)] p-4"
        >
          <div className="text-sm font-medium text-[var(--accent)]">
            PR opened for {lastRun.repo_full_name}
          </div>
          <a
            href={lastRun.pr_url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs underline hover:text-[var(--text-primary)]"
          >
            View on GitHub
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </div>
      )}

      <OnboardingConnectFlow onIntegrated={setLastRun} />
    
    </PageContent>
  );
}
