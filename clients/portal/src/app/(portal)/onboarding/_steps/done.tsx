"use client";

/**
 * DoneStep — final step. Renders a celebratory success card + 4
 * "What's next?" link cards (Trace Explorer, Connect another agent,
 * Invite teammates, Open dashboard).
 */

import { useEffect } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Eye, GitBranch, Settings } from "lucide-react";
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
        <h1 className="text-3xl font-bold tracking-tight">You&apos;re set up 🌱</h1>
        <p className="mt-2 text-[var(--text-secondary)]">
          Eden is wired up. Once traces start flowing, you&apos;ll see them in the Trace
          Explorer and the rest of the platform lights up (cost, judges, alerts, the lot).
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {[
          { href: "/traces", icon: Eye, title: "Go to Trace Explorer", body: "Search, filter, drill into the timeline." },
          { href: "/agents/connect", icon: GitBranch, title: "Connect another agent", body: "Repeat the GitHub flow for a different repo." },
          { href: "/settings", icon: Settings, title: "Invite teammates", body: "Add admins, members, or viewers from Settings." },
          { href: "/dashboard", icon: Eye, title: "Open dashboard", body: "All the headlines on one page." },
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
