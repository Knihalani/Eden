/**
 * /onboarding/connect — Step 4: GitHub repo link
 *
 * Thin wrapper around the shared OnboardingConnectFlow. Adds:
 *   * Reads ?installation_id from the URL (set by the OAuth callback)
 *     to pre-select the right install.
 *   * On successful PR open, advances onboarding_state and pushes to
 *     /wait.
 *
 * If the user joined as member/viewer (`integrations:write` missing),
 * the flow renders the locked panel and offers a skip → /done link.
 */
"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { NoOrgState } from "@/components/ui/no-org-state";
import { onboardingApi, type OnboardingPRRun } from "@/lib/api";
import { OnboardingConnectFlow } from "@/components/onboarding/OnboardingConnectFlow";

export default function OnboardingConnectPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { currentOrg } = useOrg();
  const { hasPermission } = usePermissions();
  const [preselected, setPreselected] = useState<number | null>(null);

  if (!hasPermission("jobs:write")) {
    return (
      <NoOrgState
        feature="Admins only"
        description="The GitHub connect step requires the `jobs:write` permission. Switch to an org where you're an owner/admin, or ask one to complete this step."
      />
    );
  }

  useEffect(() => {
    const idStr = searchParams.get("installation_id");
    if (idStr) setPreselected(Number(idStr));
  }, [searchParams]);

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
    router.push("/onboarding/wait");
  }

  return (
    <OnboardingConnectFlow
      inWizard
      preselectedInstallationId={preselected}
      onIntegrated={handleIntegrated}
    />
  );
}
