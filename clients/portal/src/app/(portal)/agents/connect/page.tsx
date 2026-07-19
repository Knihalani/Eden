/**
 * /agents/connect — optional GitHub App install + repo link.
 *
 * Traces work via SDK/gateway without Connect. SDK install is manual.
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
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

export default function ConnectAgentPage() {
  const [linked, setLinked] = useState<GitHubRepo | null>(null);
  const { hasPermission } = usePermissions();

  if (!hasPermission("integrations:write")) {
    return (
      <NoOrgState
        feature="Admins only"
        description="Linking a repository requires the `integrations:write` permission. Ask an org owner or admin — or install the SDK yourself; Connect is optional."
      />
    );
  }

  return (
    <PageContent size="narrow">
      <Link
        href="/agents"
        className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to agents
      </Link>

      <PageHeader
        eyebrow="Optional"
        title="Connect a repository"
        subtitle="Optional after first ingestion. Link a repo for listing; install the SDK yourself to send traces."
        icon={GitBranch}
        description="Traces work via SDK or gateway without a linked repo. Connect only when you want GitHub listing for agents and improvement plans."
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
            Next: install the Eden SDK manually so traces appear on the dashboard.
          </p>
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            <a
              href={DOCS_QUICKSTART_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center text-[var(--accent)] underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40"
            >
              Docs quickstart
            </a>
            <Link
              href="/settings?tab=api-keys"
              className="inline-flex min-h-11 items-center text-[var(--accent)] underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40"
            >
              Create API key
            </Link>
            <Link
              href="/agents"
              className="inline-flex min-h-11 items-center text-[var(--accent)] underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40"
            >
              Back to agents
            </Link>
          </div>
        </div>
      )}

      <OnboardingConnectFlow
        showHero={false}
        onLinked={(repo) => setLinked(repo)}
      />
    </PageContent>
  );
}
