/**
 * /onboarding — Step 1: Welcome.
 *
 * Briefly introduces Eden, names the upcoming steps, and links to a
 * "join" path up-front so users who already have a token or pending
 * invite know there's a faster way through. The "Continue" button
 * persists step=org_setup so a refresh resumes correctly.
 */
"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { onboardingApi } from "@/lib/api";
import { ArrowRight, Eye, GitBranch, KeyRound, Sparkles, UserPlus } from "lucide-react";

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
        <h1 className="text-3xl font-bold tracking-tight">Welcome to Eden</h1>
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
              already invited you. Both paths take the same number of
              steps from here.
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

      {/* Side-channel: skip the wizard for users who just need to redeem
          a token. Keeps the primary CTA clean (create org) but doesn't
          make the join path invisible. */}
      <div className="rounded-lg border border-dashed border-[var(--border-default)] bg-[var(--bg-secondary)]/50 p-4">
        <div className="mb-2 text-sm font-medium text-[var(--text-secondary)]">
          Joining a team?
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/onboarding/org?intent=join"
            onClick={(e) => {
              // Light pre-navigation hint so the org page lands on the
              // join branch directly. Falls back to the menu if the
              // page can't honour the hint yet.
              e.stopPropagation();
            }}
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
