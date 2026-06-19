"use client";

/**
 * WelcomeStep — the first onboarding step.
 *
 * Renders a hero, 3 step-summary cards, and a side-channel for users
 * who already have a pending invite (skips the org create path).
 */

import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Eye, GitBranch, KeyRound, Sparkles, UserPlus } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { onboardingApi } from "@/lib/api";
import type { WizardContext } from "@/components/ui/wizard";

export function WelcomeStep(_ctx: WizardContext) {
  const router = useRouter();
  const { currentOrg } = useOrg();

  async function goNext() {
    if (currentOrg?.id) {
      try {
        await onboardingApi.patchState(currentOrg.id, { step: "org_setup" });
      } catch {
        // best-effort
      }
    }
    router.push("/onboarding/org");
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Welcome to Eden 🌱</h1>
        <p className="mt-2 text-[var(--text-secondary)]">
          The next ~2 minutes get you from signup to seeing your first agent trace in the
          dashboard. You can leave at any time and resume where you left off.
        </p>
      </div>

      <ul className="space-y-3 text-sm">
        {[
          {
            icon: Sparkles,
            title: "Set up your organisation",
            body:
              "Create a new one — or join an existing one if a teammate already invited you. Both paths take the same number of steps from here.",
          },
          {
            icon: GitBranch,
            title: "Install the SDK + connect a repo",
            body:
              "We'll open a pull request that auto-instruments your agent. Admins only — members and viewers can skip and ask an admin to do it later.",
          },
          {
            icon: Eye,
            title: "Watch your first trace land",
            body: (
              <>
                Traces appear in{" "}
                <Link href="/traces" className="text-[var(--accent)] underline">
                  /traces
                </Link>{" "}
                within a minute of merging the PR.
              </>
            ),
          },
        ].map(({ icon: Icon, title, body }) => (
          <li
            key={title}
            className="flex items-start gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4"
          >
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent)]" />
            <div>
              <div className="font-medium">{title}</div>
              <div className="text-[var(--text-muted)]">{body}</div>
            </div>
          </li>
        ))}
      </ul>

      <div className="rounded-lg border border-dashed border-[var(--border-default)] bg-[var(--bg-secondary)]/50 p-4">
        <div className="mb-2 text-sm font-medium text-[var(--text-secondary)]">
          Joining a team?
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/onboarding/org?intent=join"
            className="inline-flex items-center gap-1.5 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Use a pending invite
          </Link>
          <Link
            href="/onboarding/org?intent=join"
            className="inline-flex items-center gap-1.5 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Paste an invite token
          </Link>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={goNext}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] hover:opacity-90"
        >
          Get started
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
