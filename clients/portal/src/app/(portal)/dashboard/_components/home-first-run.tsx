"use client";

import Link from "next/link";
import {
  BookOpen,
  CheckCircle2,
  GitBranch,
  Key,
  Radio,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { DoctorCommandChip } from "@/components/onboarding/WaitingForFirstEvent";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { FIRST_EVENT_WAIT } from "@/lib/portal-polish";

/**
 * First-run waiting UX — Laminar-class listening + one next step (Wave 8).
 * Distinct from period-empty failures and QueryState error.
 */
export function HomeFirstRun({
  firstTraceAt,
  canManageKeys,
  canConnect,
  checking,
  onCheck,
}: {
  firstTraceAt: string | null;
  canManageKeys: boolean;
  canConnect: boolean;
  checking: boolean;
  onCheck: () => void;
}) {
  const received = Boolean(firstTraceAt);

  return (
    <Panel
      data-testid="dashboard-first-run"
      data-wave11-first-event="polished"
      data-home-shell-state="first-run"
      data-home-shell-listening={received ? "received" : "listening"}
      tone="flat"
      padding="lg"
      className="sm:p-space-8"
      role="region"
      aria-labelledby="home-first-run-title"
    >
      <div className="max-w-xl flex flex-col gap-space-5">
        <div className="flex flex-col gap-space-2">
          <div className="flex flex-wrap items-center gap-space-2">
            <h2
              id="home-first-run-title"
              className="text-lg font-semibold text-[var(--text-primary)] m-0"
            >
              {received
                ? FIRST_EVENT_WAIT.titleReceived
                : FIRST_EVENT_WAIT.title}
            </h2>
            {!received ? (
              <span
                className="live-append-pulse inline-flex h-2.5 w-2.5 rounded-full bg-[var(--accent)]"
                role="status"
                aria-label="Listening for first event"
              />
            ) : (
              <CheckCircle2
                className="h-5 w-5 text-[var(--success)]"
                aria-hidden
              />
            )}
          </div>
          <p className="text-sm text-[var(--text-secondary)] m-0">
            {received
              ? FIRST_EVENT_WAIT.descriptionReceived
              : FIRST_EVENT_WAIT.description}
          </p>
        </div>

        {!received ? (
          <div
            className="flex flex-col gap-space-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40 p-space-4"
            data-testid="dashboard-doctor-commands"
            data-home-shell-next-step="doctor"
          >
            <div className="flex flex-col gap-space-1">
              <p className="text-xs font-medium text-[var(--text-muted)] m-0">
                One next step
              </p>
              <p className="text-sm text-[var(--text-primary)] m-0">
                {canManageKeys
                  ? "Run doctor to verify ingest, then send traffic via the SDK or gateway."
                  : "Ask an admin for an API key, then run doctor to verify ingest."}
              </p>
            </div>
            <p className="text-xs font-mono text-[var(--text-faint)] m-0">
              {FIRST_EVENT_WAIT.doctorHint}
            </p>
            <div className="flex flex-col sm:flex-row flex-wrap gap-space-2">
              <DoctorCommandChip command={FIRST_EVENT_WAIT.doctorNpx} />
              <DoctorCommandChip command={FIRST_EVENT_WAIT.doctorPython} />
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-space-2">
          <Button
            className="min-h-11"
            loading={checking}
            onClick={onCheck}
            aria-label={FIRST_EVENT_WAIT.checkCta}
          >
            <Radio className="h-4 w-4" aria-hidden />
            {FIRST_EVENT_WAIT.checkCta}
          </Button>
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/traces">Open Traces</Link>
          </Button>
        </div>

        <nav
          aria-label="First-run shortcuts"
          className="flex flex-wrap items-center gap-space-1 pt-space-1 border-t border-[var(--border-subtle)]"
        >
          {canManageKeys ? (
            <Button asChild variant="ghost" size="sm" className="min-h-11">
              <Link href="/settings?tab=api-keys">
                <Key className="h-3.5 w-3.5" aria-hidden />
                API keys
              </Link>
            </Button>
          ) : null}
          <Button asChild variant="ghost" size="sm" className="min-h-11">
            <a
              href={DOCS_QUICKSTART_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <BookOpen className="h-3.5 w-3.5" aria-hidden />
              Docs
            </a>
          </Button>
          {canConnect ? (
            <Button asChild variant="ghost" size="sm" className="min-h-11">
              <Link href="/agents/connect">
                <GitBranch className="h-3.5 w-3.5" aria-hidden />
                Connect a repo
              </Link>
            </Button>
          ) : null}
        </nav>
      </div>
    </Panel>
  );
}
