/**
 * ConnectStep — wizard step body for /onboarding/connect.
 *
 * Step 4 of the activation path. Lets the user pick a GitHub repo
 * (via the Eden GitHub App), Eden opens an SDK-integration PR, and
 * the wizard advances to /onboarding/wait on success. The wiring
 * reuses the shared <OnboardingConnectFlow> — same as the standalone
 * /onboarding/connect and /agents/connect pages, so the wizard
 * surface and the deep-link surface stay in sync.
 *
 * The step is non-blocking for member/viewer roles
 * (`integrations:write` missing) — the wizard skips to /done and
 * the user can ask an admin to wire up the repo later.
 */
"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { NoOrgState } from "@/components/ui/no-org-state";
import { OnboardingConnectFlow } from "@/components/onboarding/OnboardingConnectFlow";
import { onboardingApi, type OnboardingPRRun } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";

export function ConnectStep() {
  const searchParams = useSearchParams();
  const { currentOrg } = useOrg();
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const [preselected, setPreselected] = useState<number | null>(null);

  useEffect(() => {
    const idStr = searchParams.get("installation_id");
    if (idStr) setPreselected(Number(idStr));
  }, [searchParams]);

  if (!user) return null;

  if (!hasPermission("jobs:write")) {
    return (
      <NoOrgState
        feature="Admins only"
        description="The GitHub connect step requires the `jobs:write` permission. Switch to an org where you're an owner/admin, or ask one to complete this step. The wizard will advance to the Done step."
      />
    );
  }

  async function handleIntegrated(run: OnboardingPRRun) {
    if (!currentOrg?.id) return;
    try {
      await onboardingApi.patchState(currentOrg.id, {
        step: "wait_for_pr",
        mark_agent_onboarded: {
          agent_id: run.agent_id ?? undefined,
          agent_name: run.repo_full_name,
        },
      });
    } catch {
      // best effort — failing the state patch shouldn't block the
      // user from continuing to /wait (the /wait page will show
      // the latest PRs regardless).
    }
    // FIX-S: hard nav (see welcome.tsx) — router.push silently
    // no-ops on this route group.
    window.location.assign("/onboarding/wait");
  }

  return (
    <OnboardingConnectFlow
      onIntegrated={handleIntegrated}
      inWizard
      preselectedInstallationId={preselected}
    />
  );
}
