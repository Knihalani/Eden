/**
 * ConnectStep — wizard step body for /onboarding/connect.
 *
 * Step 2 of the activation path (after welcome). Lets the user pick a
 * GitHub repo via the Eden GitHub App; Eden opens an SDK-integration PR,
 * then the wizard advances to /onboarding/wait (PR opened) so the
 * user can track merge before installing the SDK.
 */
"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { NoOrgState } from "@/components/ui/no-org-state";
import { OnboardingConnectFlow } from "@/components/onboarding/OnboardingConnectFlow";
import { onboardingApi, type OnboardingPRRun } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { useOrg } from "@/hooks/use-org";

export function ConnectStep() {
  const searchParams = useSearchParams();
  const { currentOrg, orgSyncing, orgSyncTimedOut, refreshOrgs } = useOrg();
  const { user } = useAuth();
  const [preselected, setPreselected] = useState<number | null>(null);

  useEffect(() => {
    const idStr = searchParams.get("installation_id");
    if (idStr) setPreselected(Number(idStr));
  }, [searchParams]);

  if (!user) return null;

  if (!currentOrg) {
    return (
      <NoOrgState
        feature="GitHub connect"
        syncing={orgSyncing && !orgSyncTimedOut}
        syncTimedOut={orgSyncTimedOut}
        onRetrySync={() => void refreshOrgs()}
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
      // best effort
    }
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
