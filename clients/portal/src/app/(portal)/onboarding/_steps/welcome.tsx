"use client";

/**
 * WelcomeStep — the first onboarding step.
 *
 * Renders a hero, 3 step-summary cards, and a side-channel for users
 * who already have a pending invite (skips the org create path).
 */

import Link from "next/link";
import { ArrowRight, Eye, GitBranch, KeyRound, Sparkles, UserPlus } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { onboardingApi } from "@/lib/api";

export function WelcomeStep() {
  const { currentOrg } = useOrg();

  // If Clerk already provisioned an org (signup flow auto-creates
  // one, or the user arrived via an invite link) we surface that
  // as the headline state — the user shouldn't have to "set up
  // their organisation" if one was set up for them. The Org step
  // already auto-skips in this case; this is the equivalent
  // signpost for the welcome page so the user isn't surprised
  // when the next step appears to do nothing.
  const provisionedOrg = currentOrg?.id ? currentOrg : null;

  async function goNext() {
    if (currentOrg?.id) {
      try {
        // The org-setup step is the next page in the flow.
        // ``step`` is set to "org_setup" so a refresh resumes
        // at the right place. Best-effort: the user might
        // not have a Clerk-synced org yet (the page is also
        // reachable while orgless, in which case we skip the
        // PATCH and just navigate).
        await onboardingApi.patchState(currentOrg.id, { step: "org_setup" });
      } catch {
        // best-effort
      }
    }
    // FIX-S: replace ``router.push`` with a plain ``window.location``
    // navigation. The Next.js app-router push was observed
    // silently no-op'ing on the onboarding route group (the
    // (portal) layout's orgless-redirect useEffect re-fires
    // during the navigation window and aborts the push in some
    // Clerk hydration windows). The wizard is in-flow
    // navigation, so a hard reload is acceptable here and
    // 100% reliable. The state PATCH above already landed in
    // the backend, so a hard reload resumes from the right
    // step (or ``/onboarding/org`` if the PATCH failed).
    window.location.assign("/onboarding/org");
  }

  return (
    <div className="space-y-5 flex-1 flex flex-col">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Welcome to Eden 🌱</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          The next ~2 minutes get you from signup to seeing your first
          agent trace in the dashboard. You can leave at any time.
        </p>
      </div>

      {provisionedOrg && (
        <div className="rounded-lg border border-[var(--terminal)]/40 bg-[var(--terminal-faint)] p-3 text-sm">
          <div className="text-xs font-medium text-[var(--terminal)] mb-0.5">
            Workspace ready
          </div>
          <div className="text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">
              {provisionedOrg?.name ?? "Your workspace"}
            </span>{" "}
            is already set up &mdash; we&rsquo;ll skip the org step on the way
            through.
          </div>
        </div>
      )}

      <ul className="space-y-2 text-sm">
        {[
          {
            icon: Sparkles,
            title: provisionedOrg
              ? "Confirm autonomous settings"
              : "Set up your organisation",
            body: provisionedOrg
              ? "Pick how Eden's auto-suggested patches and self-healing work for this org."
              : "Create a new one, or join an existing one if a teammate already invited you.",
          },
          {
            icon: GitBranch,
            title: "Install the SDK + connect a repo",
            body: "We'll open a pull request that auto-instruments your agent. Admins only — others can skip and ask an admin later.",
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
            className="flex items-start gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3"
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
            <div>
              <div className="text-sm font-medium">{title}</div>
              <div className="text-xs text-[var(--text-muted)] leading-snug">{body}</div>
            </div>
          </li>
        ))}
      </ul>

      {!provisionedOrg && (
        <div className="rounded-lg border border-dashed border-[var(--border-default)] bg-[var(--bg-secondary)]/50 p-3">
          <div className="mb-1.5 text-xs font-medium text-[var(--text-secondary)]">
            Joining a team?
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/onboarding/org?intent=join"
              className="inline-flex items-center gap-1.5 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2.5 py-1 text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              <UserPlus className="h-3 w-3" />
              Use a pending invite
            </Link>
            <Link
              href="/onboarding/org?intent=join"
              className="inline-flex items-center gap-1.5 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2.5 py-1 text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              <KeyRound className="h-3 w-3" />
              Paste an invite token
            </Link>
          </div>
        </div>
      )}

      <div className="flex justify-end pt-1">
        <button
          onClick={goNext}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] hover:opacity-90"
        >
          {provisionedOrg ? "Continue" : "Get started"}
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
