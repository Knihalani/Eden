"use client";

/**
 * DoneStep — final step. Success card + next-action links.
 */

import { useEffect } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Eye, GitBranch, LayoutDashboard, Settings } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { onboardingApi } from "@/lib/api";

export function DoneStep() {
  const { currentOrg } = useOrg();

  useEffect(() => {
    try {
      window.localStorage.removeItem("eden:onboarding:skipRepo");
      window.localStorage.removeItem("eden:onboarding");
    } catch {
      // tolerate
    }
    if (currentOrg?.id) {
      onboardingApi.patchState(currentOrg.id, { step: "done" }).catch(() => {
        // best effort
      });
    }
  }, [currentOrg?.id]);

  return (
    <div className="space-y-8">
      <div className="rounded-xl border border-[var(--terminal)]/40 bg-[var(--terminal-faint)] p-6">
        <CheckCircle2 className="mb-3 h-10 w-10 text-[var(--terminal)]" />
        <h1 className="text-3xl font-bold tracking-tight">You&apos;re set up</h1>
        <p className="mt-2 text-[var(--text-secondary)] leading-relaxed">
          {currentOrg?.name ? (
            <>
              <span className="font-medium text-[var(--text-primary)]">{currentOrg.name}</span>
              {" "}is wired up. Merge the integration PR if you opened one, run your agent with the SDK, and traces will appear in the dashboard.
            </>
          ) : (
            "Run your agent with the SDK snippet — traces will appear in the dashboard within seconds."
          )}
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {[
          { href: "/dashboard", icon: LayoutDashboard, title: "Open dashboard", body: "Telemetry overview, cost, and alerts at a glance." },
          { href: "/traces", icon: Eye, title: "Trace Explorer", body: "Search, filter, and drill into agent runs." },
          { href: "/agents/connect", icon: GitBranch, title: "Connect another repo", body: "Repeat the GitHub flow for a different codebase." },
          { href: "/settings", icon: Settings, title: "Invite teammates", body: "Add admins, members, or viewers." },
        ].map(({ href, icon: Icon, title, body }) => (
          <Link
            key={href}
            href={href}
            className="flex items-start gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4 transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
          >
            <Icon className="mt-0.5 h-5 w-5 text-[var(--accent)]" />
            <div className="flex-1">
              <div className="text-sm font-semibold">{title}</div>
              <div className="text-xs text-[var(--text-muted)]">{body}</div>
            </div>
            <ArrowRight className="mt-1 h-4 w-4 text-[var(--text-muted)]" />
          </Link>
        ))}
      </div>
    </div>
  );
}
