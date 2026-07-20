"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, Circle, Loader2, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage } from "@/components/portal-os";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOrg } from "@/hooks/use-org";
import { learnApi } from "@/lib/api";
import { errorFromCaught } from "@/lib/safe-error-message";
import { cn } from "@/lib/utils";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

type LoopStep = {
  id: string;
  label: string;
  href: string;
  done: boolean;
};

export default function ImprovementLoopOnboardingPage() {
  const { currentOrg } = useOrg();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<LoopStep[]>([]);
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(0);
  const [nextStep, setNextStep] = useState<LoopStep | null>(null);

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const res = await learnApi.improvementLoopStatus(currentOrg.id);
      const data = res.data as {
        steps?: LoopStep[];
        completed?: number;
        total?: number;
        next_step?: LoopStep | null;
      };
      setSteps(data?.steps ?? []);
      setCompleted(Number(data?.completed ?? 0));
      setTotal(Number(data?.total ?? 0));
      setNextStep(data?.next_step ?? null);
    } catch (e) {
      setError(errorFromCaught(e, "Failed to load improvement loop status"));
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!currentOrg) return <NoOrgState feature="Improvement loop" />;

  return (
    <CoreResourcePage
      header={
        <PageHeader
          title="Improvement loop"
          description="Live progress from your org — Autonomy stays Off or Preview only until you promote."
          actions={
            <div className="flex flex-wrap items-center gap-space-2">
              <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
                <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                Refresh
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="min-h-11" aria-label="Related surfaces">
                    More
                    <ChevronDown className="h-4 w-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[12rem]">
                  <DropdownMenuLabel>Go to</DropdownMenuLabel>
                  <DropdownMenuItem asChild>
                    <Link href="/improve">Improve</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/artifacts">Artifacts</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/ledger">Ledger</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/traces">Traces</Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          }
        />
      }
      toolbar={undefined}
      table={
        <>
          {error ? (
            <ErrorState
              message={error}
              action={
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  Try again
                </Button>
              }
            />
          ) : null}

          {loading && steps.length === 0 ? (
            <div className="flex justify-center py-space-8">
              <Loader2 className="h-8 w-8 animate-spin text-[var(--text-muted)]" />
            </div>
          ) : steps.length === 0 ? (
            <EmptyState
              title="Loop status unavailable"
              description="Send traces via SDK or gateway first. Linking a GitHub repo is optional — Connect is not required to teach the loop."
              action={
                <div className="flex flex-wrap items-center justify-center gap-space-2">
                  <Button asChild className="min-h-11">
                    <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                      Docs quickstart
                    </a>
                  </Button>
                  <Button asChild variant="outline" className="min-h-11">
                    <Link href="/settings?tab=api-keys">Create API key</Link>
                  </Button>
                </div>
              }
            />
          ) : (
            <>
              <p className="mb-space-3 text-sm text-[var(--text-secondary)]">
                {completed}/{total} complete
                {nextStep ? (
                  <>
                    {" · "}
                    Next:{" "}
                    <Link href={nextStep.href} className="text-[var(--accent)] hover:underline">
                      {nextStep.label}
                    </Link>
                  </>
                ) : (
                  " · Loop teachable — keep promoting proven Artifacts into the Ledger."
                )}
              </p>
              <Card className="divide-y">
                {steps.map((step) => (
                  <Link
                    key={step.id}
                    href={step.href}
                    className="flex items-center gap-space-3 p-space-4 hover:bg-[var(--bg-subtle)]"
                  >
                    {step.done ? (
                      <CheckCircle2 className="h-5 w-5 text-[var(--accent)]" aria-label="done" />
                    ) : (
                      <Circle className="h-5 w-5 text-[var(--text-muted)]" aria-label="todo" />
                    )}
                    <span className={cn(step.done && "text-[var(--text-muted)]")}>{step.label}</span>
                  </Link>
                ))}
              </Card>
              <p className="mt-space-4 text-sm text-[var(--text-secondary)]">
                Production traces become Artifacts; proven Artifacts and resolved issues write the
                Ledger.
              </p>
            </>
          )}
        </>
      }
    />
  );
}
