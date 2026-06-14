/**
 * /onboarding/done — Step 6: Success + CTAs into the product.
 *
 * Cleans up the local skipRepo flag so the wizard rebuilds cleanly
 * if the user re-enters via /agents/connect later.
 */
"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { onboardingApi } from "@/lib/api";
import { ArrowRight, CheckCircle2, Eye, GitBranch, Settings } from "lucide-react";

export default function OnboardingDonePage() {
  const { currentOrg } = useOrg();

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("eden:onboarding:skipRepo");
    }
    if (currentOrg?.id) {
      onboardingApi.patchState(currentOrg.id, { step: "done" }).catch(() => {
        // best effort — the wait page already advanced state
      });
    }
  }, [currentOrg?.id]);

  return (
    <div className="space-y-8">
      <div className="rounded-xl border border-[var(--terminal)]/40 bg-[var(--terminal-faint)] p-6">
        <CheckCircle2 className="mb-3 h-10 w-10 text-[var(--terminal)]" />
        <h1 className="text-3xl font-bold tracking-tight">You&apos;re set up 🌱</h1>
        <p className="mt-2 text-[var(--text-secondary)]">
          Eden is wired up. Once traces start flowing, you&apos;ll see them
          in the Trace Explorer and the rest of the platform lights up
          (cost, judges, alerts, the lot).
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Link
          href="/traces"
          className="flex items-start gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4 transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
        >
          <Eye className="mt-0.5 h-5 w-5 text-[var(--accent)]" />
          <div className="flex-1">
            <div className="text-sm font-semibold">Go to Trace Explorer</div>
            <div className="text-xs text-[var(--text-muted)]">
              Search, filter, drill into the timeline.
            </div>
          </div>
          <ArrowRight className="mt-1 h-4 w-4 text-[var(--text-muted)]" />
        </Link>
        <Link
          href="/agents/connect"
          className="flex items-start gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4 transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
        >
          <GitBranch className="mt-0.5 h-5 w-5 text-[var(--accent)]" />
          <div className="flex-1">
            <div className="text-sm font-semibold">Connect another agent</div>
            <div className="text-xs text-[var(--text-muted)]">
              Repeat the GitHub flow for a different repo.
            </div>
          </div>
          <ArrowRight className="mt-1 h-4 w-4 text-[var(--text-muted)]" />
        </Link>
        <Link
          href="/settings"
          className="flex items-start gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4 transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
        >
          <Settings className="mt-0.5 h-5 w-5 text-[var(--accent)]" />
          <div className="flex-1">
            <div className="text-sm font-semibold">Invite teammates</div>
            <div className="text-xs text-[var(--text-muted)]">
              Add admins, members, or viewers from Settings.
            </div>
          </div>
          <ArrowRight className="mt-1 h-4 w-4 text-[var(--text-muted)]" />
        </Link>
        <Link
          href="/dashboard"
          className="flex items-start gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4 transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
        >
          <Eye className="mt-0.5 h-5 w-5 text-[var(--accent)]" />
          <div className="flex-1">
            <div className="text-sm font-semibold">Open dashboard</div>
            <div className="text-xs text-[var(--text-muted)]">
              All the headlines on one page.
            </div>
          </div>
          <ArrowRight className="mt-1 h-4 w-4 text-[var(--text-muted)]" />
        </Link>
      </div>
    </div>
  );
}
