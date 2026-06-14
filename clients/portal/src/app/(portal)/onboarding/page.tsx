/**
 * /onboarding — Step 1: Welcome
 *
 * Briefly introduces Eden, names the upcoming steps. The "Continue"
 * button persists step=org_setup so a refresh resumes correctly.
 */
"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { onboardingApi } from "@/lib/api";
import { ArrowRight, Eye, GitBranch, Sparkles } from "lucide-react";

export default function OnboardingWelcomePage() {
  const router = useRouter();
  const { currentOrg } = useOrg();

  async function next() {
    if (currentOrg?.id) {
      try {
        await onboardingApi.patchState(currentOrg.id, { step: "org_setup" });
      } catch {
        // Best-effort — if the backend hasn't surfaced the org yet
        // (race on first signup), continue anyway.
      }
    }
    router.push("/onboarding/org");
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Welcome to Eden 🌱</h1>
        <p className="mt-2 text-[var(--text-secondary)]">
          The next ~2 minutes get you from signup to seeing your first
          agent trace in the dashboard. You can leave at any time and
          resume where you left off.
        </p>
      </div>

      <ul className="space-y-3 text-sm">
        <li className="flex items-start gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent)]" />
          <div>
            <div className="font-medium">Set up your organisation</div>
            <div className="text-[var(--text-muted)]">
              Create a new one — or join an existing one if a teammate
              already invited you.
            </div>
          </div>
        </li>
        <li className="flex items-start gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
          <GitBranch className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent)]" />
          <div>
            <div className="font-medium">Install the SDK + connect a repo</div>
            <div className="text-[var(--text-muted)]">
              We&apos;ll open a pull request that auto-instruments your
              agent. Admins only — members and viewers can skip and ask
              an admin to do it later.
            </div>
          </div>
        </li>
        <li className="flex items-start gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
          <Eye className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent)]" />
          <div>
            <div className="font-medium">Watch your first trace land</div>
            <div className="text-[var(--text-muted)]">
              Traces appear in <Link href="/traces" className="text-[var(--accent)] underline">/traces</Link> within a minute of merging the PR.
            </div>
          </div>
        </li>
      </ul>

      <div className="flex justify-end">
        <button
          onClick={next}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90"
        >
          Get started
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
