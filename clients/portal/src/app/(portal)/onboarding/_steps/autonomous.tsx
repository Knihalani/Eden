"use client";

/**
 * /onboarding/autonomous — Step 2: Autonomous disclosure.
 *
 * The /heal + /repos/{id}/learn + /patches/{id}/generate routes
 * are on by default since June 2026 (intelligence_gap_v0 +
 * autonomous_actions_v0 = true). This step surfaces that to the
 * new user before they hit the dashboard so the implications
 * are clear. The user can opt out per-org here, or later via
 * Settings > Autonomous.
 */
import Link from "next/link";
import { useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { api as orgsApi, onboardingApi } from "@/lib/api";
import {
  ArrowRight,
  Bot,
  GitPullRequest,
  ShieldCheck,
  ShieldOff,
  Wrench,
} from "lucide-react";

export default function OnboardingAutonomousPage() {
  const { currentOrg, refreshOrg } = useOrg();
  const [optOut, setOptOut] = useState(false);
  const [busy, setBusy] = useState(false);

  async function persistAndNext() {
    // FIX-S: use window.location.assign (hard nav) instead of
    // router.push. The Next.js app-router push was observed
    // silently no-op'ing on the onboarding route group.
    const next = "/onboarding/connect";
    if (!currentOrg?.id) {
      window.location.assign(next);
      return;
    }
    setBusy(true);
    try {
      if (optOut) {
        // Disable the destructive flag per-org; the next settings
        // page exposes the same toggle for the user to re-enable.
        await orgsApi.updateOrgSettings(currentOrg.id, {
          autonomous_actions_v0: false,
          intelligence_gap_v0: true,
        });
      }
      await onboardingApi.patchState(currentOrg.id, { step: "connect_github" });
      await refreshOrg();
    } catch {
      // Best-effort — never block the onboarding flow on a
      // settings-write failure.
    } finally {
      setBusy(false);
    }
    window.location.assign(next);
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <p className="text-xs font-mono uppercase tracking-wider text-[var(--accent)] mb-2">
          Step 2 of 4
        </p>
        <h1 className="text-3xl font-bold tracking-tight">
          Autonomous features are on
        </h1>
        <p className="mt-2 text-[var(--text-secondary)] leading-relaxed">
          Eden ships with two flags enabled by default. They unlock the
          Inbox (auto-suggested patches for failing traces) and the
          SelfHealer (queued canary rollbacks, cache busts, model
          reweights). Both{" "}
          <span className="text-[var(--text-primary)] font-medium">
            require a human approval
          </span>{" "}
          before any code is changed or model is swapped.
        </p>
      </div>

      <div className="rounded-xl border border-[var(--border-default)] divide-y divide-[var(--border-default)]">
        <div className="p-5 flex items-start gap-4">
          <div className="rounded-lg bg-[var(--accent-faint)] p-2 shrink-0">
            <GitPullRequest className="w-5 h-5 text-[var(--accent)]" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">
              Cat 23: PR Inbox + auto-suggested patches
            </h3>
            <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
              When a trace fails, the Inbox proposes a unified-diff
              patch with style + PR-pattern matching. An admin must
              click &quot;Open PR&quot; before anything reaches your repo.
              Drafts are auto-closed if no human acts within 7 days.
            </p>
          </div>
        </div>

        <div className="p-5 flex items-start gap-4">
          <div className="rounded-lg bg-[var(--accent-faint)] p-2 shrink-0">
            <Wrench className="w-5 h-5 text-[var(--accent)]" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">
              Cat 14: SelfHealer + recommendations
            </h3>
            <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
              Auto-queues canary rollbacks, cache busts, and model
              reweights when drift is detected. Every action is{" "}
              <code className="font-mono text-[var(--text-primary)]">
                pending_approval
              </code>{" "}
              until an org admin signs off via{" "}
              <code className="font-mono text-[var(--text-primary)]">
                /heal/{`{id}`}/approve
              </code>
              . Without approval, no state changes.
            </p>
          </div>
        </div>

        <div className="p-5 flex items-start gap-4">
          <div className="rounded-lg bg-[var(--accent-faint)] p-2 shrink-0">
            <Bot className="w-5 h-5 text-[var(--accent)]" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">
              What Eden Agent can and can&apos;t do
            </h3>
            <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
              <span className="text-[var(--success)]">Can:</span> propose
              patches, open draft PRs, queue rollbacks, score code
              quality, learn your repo&apos;s style.{" "}
              <span className="text-[var(--error)]">Cannot:</span> merge to
              main, push to a protected branch, or modify{" "}
              <code className="font-mono text-[var(--text-primary)]">
                protected_paths
              </code>{" "}
              without an explicit two-stage opt-in per action.
            </p>
          </div>
        </div>
      </div>

      <label className="flex items-start gap-3 p-4 rounded-xl border border-[var(--border-default)] cursor-pointer hover:border-[var(--accent)]/40 transition-colors">
        <input
          type="checkbox"
          checked={optOut}
          onChange={(e) => setOptOut(e.target.checked)}
          className="mt-1 h-4 w-4 accent-[var(--accent)]"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            {optOut ? (
              <ShieldOff className="w-4 h-4 text-[var(--error)]" />
            ) : (
              <ShieldCheck className="w-4 h-4 text-[var(--success)]" />
            )}
            Turn off autonomous features for this org
          </div>
          <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
            You can re-enable anytime in{" "}
            <Link
              href="/settings"
              className="text-[var(--accent)] hover:underline"
            >
              Settings &rarr; Autonomous
            </Link>
            . Recommended only if you want a fully manual workflow.
          </p>
        </div>
      </label>

      <div className="flex items-center justify-between pt-2">
        <Link
          href="/onboarding/org"
          className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          &larr; Back
        </Link>
        <button
          onClick={persistAndNext}
          disabled={busy}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[var(--accent)] text-[var(--bg-primary)] font-medium text-sm hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving..." : "Continue"}
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
