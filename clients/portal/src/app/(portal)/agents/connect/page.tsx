/**
 * /agents/connect — optional GitHub App install + repo link.
 *
 * Traces work via SDK/gateway without Connect. SDK install is manual.
 * Permission denial is handled inside OnboardingConnectFlow (PanelLocked);
 * this page only gates the orgless case so non-admins are not shown
 * a misleading NoOrgState "create a workspace" CTA.
 *
 * GitHub App callback lands here with ?installation_id=… (via
 * /onboarding/connect rewrite). We persist that id and pass it into
 * OnboardingConnectFlow so the claim step runs after install.
 */
"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Check, GitBranch } from "lucide-react";
import { OnboardingConnectFlow } from "@/components/onboarding/OnboardingConnectFlow";
import { NoOrgState } from "@/components/ui/no-org-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useOrg } from "@/hooks/use-org";
import type { GitHubRepo } from "@/lib/api";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import {
  parseInstallationId,
  storeInstallationId,
} from "@/lib/github-install";

function ConnectAgentPageInner() {
  const searchParams = useSearchParams();
  const installationId = parseInstallationId(
    searchParams.get("installation_id"),
  );
  const callbackError = searchParams.get("error");
  const [linked, setLinked] = useState<GitHubRepo | null>(null);
  const { currentOrg } = useOrg();

  useEffect(() => {
    if (installationId != null) {
      storeInstallationId(installationId);
    }
  }, [installationId]);

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={GitBranch}
        feature="Connect repository"
        description="Create or select an organization before linking a GitHub repo. Connect is optional — you can still install the SDK yourself."
      />
    );
  }

  return (
    <PageContent size="narrow">
      <div className="space-y-space-6" data-wave10-connect="polished">
        <Button asChild variant="ghost" className="min-h-11 -ml-2 w-fit px-2">
          <Link href="/agents">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to agents
          </Link>
        </Button>

        <PageHeader
          eyebrow="Optional"
          title="Connect a repository"
          subtitle="Optional after first ingestion. Link a repo for listing; install the SDK yourself to send traces."
          icon={GitBranch}
          description="Traces work via SDK or gateway without a linked repo. Connect only when you want GitHub listing for agents and improvement plans."
          className="mb-0"
        />

        {callbackError && (
          <div
            role="alert"
            className="rounded-lg border border-[var(--error)]/20 bg-[var(--error-bg)] p-space-4 text-sm text-[var(--error)]"
          >
            GitHub connection failed ({callbackError}). Try connecting again.
          </div>
        )}

        {linked && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-xl border border-[var(--accent)]/40 bg-[var(--accent-faint)] p-space-5"
          >
            <div className="flex items-center gap-space-2 text-sm font-medium text-[var(--accent)]">
              <Check className="h-4 w-4" aria-hidden="true" />
              Linked {linked.full_name}
            </div>
            <p className="mt-space-2 text-sm text-[var(--text-secondary)]">
              Next: install the Eden SDK manually so traces appear on the dashboard.
            </p>
            <div className="mt-space-4 flex flex-wrap gap-space-3">
              <Button asChild variant="default" className="min-h-11">
                <a
                  href={DOCS_QUICKSTART_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Install SDK (docs)
                </a>
              </Button>
              <Button asChild variant="ghost" className="min-h-11">
                <Link href="/agents">Back to agents</Link>
              </Button>
            </div>
          </div>
        )}

        <OnboardingConnectFlow
          showHero={false}
          preselectedInstallationId={installationId}
          onLinked={(repo) => setLinked(repo)}
        />
      </div>
    </PageContent>
  );
}

// Wrap ConnectAgentPageInner in a Suspense boundary because it reads
// ``useSearchParams()``. Without the boundary Next.js cannot
// statically optimise the page and the RSC prefetch
// (``?._rsc=...``) returns a partial / erroring payload, which
// surfaces in the browser console as a 404.
export default function ConnectAgentPage() {
  return (
    <Suspense fallback={<LoadingSkeleton variant="default" />}>
      <ConnectAgentPageInner />
    </Suspense>
  );
}
