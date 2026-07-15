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
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { NoOrgState } from "@/components/ui/no-org-state";
import { OnboardingConnectFlow } from "@/components/onboarding/OnboardingConnectFlow";
import { onboardingApi, type OnboardingPRRun } from "@/lib/api";
import {
  parseInstallationId,
  readStoredInstallationId,
  storeInstallationId,
} from "@/lib/github-install";
import { useAuth } from "@/hooks/use-auth";
import { useOrg } from "@/hooks/use-org";

const GITHUB_CALLBACK_ERRORS: Record<string, string> = {
  state_not_found:
    "Your GitHub install session expired or was started in another tab. Connect again below.",
  installation_token_failed:
    "Eden could not verify the GitHub installation. Retry connect or grant repo access again.",
};

export function ConnectStep() {
  const searchParams = useSearchParams();
  const { currentOrg, orgSyncing, orgSyncTimedOut, refreshOrgs } = useOrg();
  const { user } = useAuth();
  const initialInstallId = useMemo(() => {
    const fromUrl = parseInstallationId(searchParams.get("installation_id"));
    if (fromUrl != null) {
      storeInstallationId(fromUrl);
      return fromUrl;
    }
    return readStoredInstallationId();
  }, [searchParams]);
  const [preselected, setPreselected] = useState<number | null>(initialInstallId);
  const [callbackNotice, setCallbackNotice] = useState<string | null>(null);

  useEffect(() => {
    const fromUrl = parseInstallationId(searchParams.get("installation_id"));
    const fromStore = readStoredInstallationId();
    const installId = fromUrl ?? fromStore;
    if (fromUrl != null) {
      storeInstallationId(fromUrl);
    }
    if (installId != null) {
      setPreselected(installId);
    }

    const setupAction = searchParams.get("setup_action");
    const errCode = searchParams.get("error");
    let notice: string | null = null;
    if (setupAction === "cancel") {
      notice = "GitHub install was cancelled. You can try again or skip to SDK install.";
    } else if (errCode && GITHUB_CALLBACK_ERRORS[errCode]) {
      notice = GITHUB_CALLBACK_ERRORS[errCode];
    } else if (errCode) {
      notice = "GitHub connect did not complete. Try again or skip to SDK install.";
    } else if (installId != null && setupAction !== "cancel") {
      notice = "GitHub App installed — Eden is registering access and opening your integration PR.";
    }
    setCallbackNotice(notice);

    // Drop one-shot callback query params (installation_id lives in
    // sessionStorage until claim succeeds).
    if (typeof window !== "undefined" && (searchParams.get("setup_action") || errCode)) {
      const url = new URL(window.location.href);
      url.searchParams.delete("error");
      url.searchParams.delete("setup_action");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
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
    <div className="space-y-4">
      {callbackNotice && (
        <div
          role="status"
          className="rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-faint)] p-4 text-sm text-[var(--text-secondary)]"
        >
          <AlertCircle className="mr-1.5 inline h-4 w-4 text-[var(--accent)]" />
          {callbackNotice}
          <span className="mt-2 block text-xs text-[var(--text-muted)]">
            <Link href="/onboarding/install" className="text-[var(--accent)] hover:underline">
              Skip / continue with SDK only
            </Link>
            {" "}if you prefer to wire up manually.
          </span>
        </div>
      )}
      <OnboardingConnectFlow
        onIntegrated={handleIntegrated}
        inWizard
        preselectedInstallationId={preselected}
      />
    </div>
  );
}
