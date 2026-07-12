/**
 * WaitStep — wizard step body for /onboarding/wait.
 *
 * Step 5 of the activation path. Polls /pr-runs every 5s for the
 * PR the previous step opened. Shows each PR's status + GitHub link,
 * and lets the user advance to /done once it's merged (or skip +
 * mark integrated if they wired up manually).
 *
 * Imported from the standalone /onboarding/wait page so the wizard
 * surface and the deep-link surface share the exact same body.
 */
"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { usePolling } from "@/hooks/use-polling";
import { onboardingApi, type OnboardingPRRun } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { ArrowRight, CheckCircle2, ExternalLink, Loader2, RefreshCw, SkipForward } from "lucide-react";

const POLL_INTERVAL_MS = 5_000;

export function WaitStep() {
  const toast = useToast();
  const { currentOrg } = useOrg();
  const [runs, setRuns] = useState<OnboardingPRRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [advancing, setAdvancing] = useState(false);

  // PQ-2: route polling through the shared usePolling hook. It
  // owns the setInterval lifecycle + jitter, full-jitter backoff
  // on auth errors, and pauses while the tab is hidden.
  const poll = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    try {
      const list = await onboardingApi.listPrRuns(currentOrg.id, 20);
      setRuns(list);
    } catch {
      // tolerated — empty list is fine, the user can refresh manually
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id]);

  usePolling(poll, {
    intervalMs: POLL_INTERVAL_MS,
    enabled: Boolean(currentOrg?.id),
    pauseWhenHidden: true,
  });

  const anyMerged = runs.some((r) => r.status === "merged");
  const anyOpen = runs.some((r) => r.status === "opened" || r.status === "pending");

  async function finish() {
    if (!currentOrg?.id) return;
    setAdvancing(true);
    try {
      await onboardingApi.patchState(currentOrg.id, { step: "install_sdk" });
      // Hard nav — router.push silently no-ops on this route group.
      window.location.assign("/onboarding/install");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not advance");
    } finally {
      setAdvancing(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Waiting for your pull request</h1>
        <p className="mt-2 text-[var(--text-secondary)]">
          {anyMerged
            ? "Your integration PR was merged — Eden is wired in. Continue to your dashboard."
            : anyOpen
            ? "Your PR is open. Review it on GitHub and merge when you're ready — or skip and merge later."
            : "No integration PRs yet. Refresh once GitHub has the branch."}
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)]">
        <div className="flex items-center justify-between border-b border-[var(--border-default)] px-4 py-2">
          <span className="text-sm font-medium">Integration PRs</span>
          <button
            onClick={poll}
            disabled={loading}
            className="flex items-center gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
        {runs.length === 0 ? (
          <div className="p-6 text-center text-sm text-[var(--text-muted)]">
            {loading ? "Loading…" : "No PRs yet."}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border-default)]/50">
            {runs.map((r) => (
              <li key={r.id} className="flex items-start justify-between p-4">
                <div>
                  <div className="text-sm font-medium text-[var(--text-primary)]">
                    {r.repo_full_name}
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                    {r.framework ? `${r.framework} · ${r.language}` : "detecting…"}
                    {r.branch ? ` · ${r.branch}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={r.status} />
                  {r.pr_url ? (
                    <a
                      href={r.pr_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                    >
                      <ExternalLink className="h-3 w-3" />
                      View PR
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Link
          href="/onboarding/connect"
          className="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          ← Connect another agent
        </Link>
        <div className="flex items-center gap-2">
          <button
            onClick={finish}
            disabled={advancing}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            <SkipForward className="h-4 w-4" />
            Skip — finish setup
          </button>
          <button
            onClick={finish}
            disabled={advancing || (!anyMerged && runs.length === 0)}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-50"
          >
            {advancing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : anyMerged ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : null}
            Continue
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: OnboardingPRRun["status"] }) {
  const map: Record<OnboardingPRRun["status"], { label: string; cls: string }> = {
    pending: { label: "Detecting", cls: "text-[var(--text-muted)] border-[var(--border-default)]" },
    opened: { label: "PR open", cls: "text-[var(--accent)] border-[var(--accent)]/40 bg-[var(--accent-faint)]" },
    merged: { label: "Merged", cls: "text-[var(--terminal)] border-[var(--terminal)]/40 bg-[var(--terminal-faint)]" },
    closed: { label: "Closed", cls: "text-[var(--text-muted)] border-[var(--border-default)]" },
    skipped: { label: "Skipped", cls: "text-[var(--text-muted)] border-[var(--border-default)]" },
    failed: { label: "Failed", cls: "text-[var(--error)] border-[var(--error)]/40" },
  };
  const e = map[status];
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${e.cls}`}>
      {e.label}
    </span>
  );
}
