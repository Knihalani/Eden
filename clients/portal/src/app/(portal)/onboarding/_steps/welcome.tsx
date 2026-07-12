"use client";

/**
 * Welcome — first onboarding step.
 *
 * Clerk already created a workspace at signup; Eden syncs it on the
 * first authenticated /auth/me. This page confirms that sync (or
 * offers join-by-invite) then sends the user straight to SDK install.
 */

import Link from "next/link";
import { ArrowRight, GitBranch, KeyRound, Loader2, Package, UserPlus } from "lucide-react";
import { useOrganization } from "@clerk/nextjs";
import { useOrg } from "@/hooks/use-org";
import { onboardingApi } from "@/lib/api";

export function WelcomeStep() {
  const { currentOrg, orgSyncing, orgSyncTimedOut, refreshOrgs } = useOrg();
  const { organization: clerkOrg } = useOrganization();

  const workspaceName =
    currentOrg?.name ?? clerkOrg?.name ?? "your workspace";
  const hasWorkspace = Boolean(currentOrg?.id);
  const isProvisioning = Boolean(orgSyncing && !orgSyncTimedOut && !currentOrg?.id);

  async function goNext() {
    if (isProvisioning) {
      await refreshOrgs();
      return;
    }
    if (currentOrg?.id) {
      try {
        await onboardingApi.patchState(currentOrg.id, { step: "install" });
      } catch {
        // best-effort
      }
    }
    window.location.assign("/onboarding/install");
  }

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
          Welcome to Eden
        </h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)] leading-relaxed">
          {hasWorkspace
            ? `${workspaceName} is ready. Install the SDK, send a trace, and you’ll see it in the dashboard.`
            : isProvisioning
              ? "Your workspace is syncing from Clerk — this usually takes a few seconds."
              : "Install the SDK to start capturing agent traces. If a teammate invited you, join their workspace below."}
        </p>
      </div>

      {orgSyncTimedOut && !currentOrg?.id && (
        <div className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning-faint)] p-4 text-sm text-[var(--text-secondary)]">
          Sync is taking longer than expected.{" "}
          <button
            type="button"
            onClick={() => void refreshOrgs()}
            className="font-medium text-[var(--accent)] hover:underline"
          >
            Try again
          </button>
          {" "}or continue — Eden will retry in the background.
        </div>
      )}

      {isProvisioning && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4"
        >
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-[var(--accent)]" />
          <div className="text-sm text-[var(--text-secondary)]">
            Syncing <span className="font-medium text-[var(--text-primary)]">{workspaceName}</span>…
          </div>
        </div>
      )}

      {hasWorkspace && (
        <div className="rounded-lg border border-[var(--terminal)]/40 bg-[var(--terminal-faint)] p-4 text-sm">
          <div className="text-xs font-medium text-[var(--terminal)] mb-1">
            Workspace ready
          </div>
          <div className="text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">{workspaceName}</span>
            {" — no extra setup needed."}
          </div>
        </div>
      )}

      <ul className="space-y-2 text-sm">
        {[
          {
            icon: Package,
            title: "Install the SDK",
            body: "Copy a snippet for Python or TypeScript and wrap your agent calls.",
          },
          {
            icon: GitBranch,
            title: "Connect a repo (optional)",
            body: "Admins can open a PR that auto-instruments your codebase. Everyone else can skip.",
          },
        ].map(({ icon: Icon, title, body }) => (
          <li
            key={title}
            className="flex items-start gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3"
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
            <div>
              <div className="text-sm font-medium text-[var(--text-primary)]">{title}</div>
              <div className="text-xs text-[var(--text-muted)] leading-snug">{body}</div>
            </div>
          </li>
        ))}
      </ul>

      {!hasWorkspace && !isProvisioning && (
        <div className="rounded-lg border border-dashed border-[var(--border-default)] bg-[var(--bg-secondary)]/50 p-4">
          <div className="mb-2 text-xs font-medium text-[var(--text-secondary)]">
            Joining a team?
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/onboarding/org?intent=join"
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              <UserPlus className="h-3.5 w-3.5" />
              Accept an invite
            </Link>
            <Link
              href="/onboarding/org?intent=join"
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              <KeyRound className="h-3.5 w-3.5" />
              Paste invite token
            </Link>
          </div>
        </div>
      )}

      <div className="flex justify-end pt-2">
        <button
          type="button"
          onClick={() => void goNext()}
          disabled={isProvisioning}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-[var(--accent-foreground)] hover:opacity-90 disabled:opacity-50"
        >
          {isProvisioning ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Syncing…
            </>
          ) : (
            <>
              {hasWorkspace ? "Continue to install" : "Get started"}
              <ArrowRight className="h-4 w-4" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}
