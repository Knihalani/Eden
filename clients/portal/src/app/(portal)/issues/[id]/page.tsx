"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageContent } from "@/components/layout/page-content";
import { IssueDetailHeader } from "../_components/issue-detail-header";
import { IssueStumblesList } from "../_components/issue-stumbles-list";
import { IssueTriagePanel } from "../_components/issue-triage-panel";
import { IssueHandoffPanel } from "../_components/issue-handoff";
import { IssueExperimentPanel } from "../_components/issue-experiment-panel";
import { IssueRegressionPanel } from "../_components/issue-regression-panel";
import { IssueStat } from "../_components/issue-stat";
import { useIssueDetail } from "../_components/use-issue-detail";

export default function IssueDetailPage() {
  const params = useParams<{ id: string }>();
  const issueId = params?.id;
  const d = useIssueDetail(issueId);

  if (!d.currentOrg) {
    return (
      <NoOrgState feature="Agent Issues" icon={ShieldAlert} description="Select an organization" />
    );
  }

  return (
    <PageContent size="default">
      <Link
        href="/issues"
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      >
        <ArrowLeft className="h-4 w-4" /> Back to issues
      </Link>

      {d.loading ? (
        <div
          role="status"
          aria-busy="true"
          className="flex items-center justify-center p-12 text-sm text-[var(--text-muted)]"
        >
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : d.isNotFound || (!d.issue && !d.error) ? (
        <Card padding="lg">
          <p className="text-sm text-[var(--text-muted)]">Issue not found.</p>
        </Card>
      ) : d.error || !d.issue ? (
        <ErrorState
          title="Could not load issue"
          message={d.error ?? "Could not load issue."}
          action={
            <Button variant="outline" size="sm" onClick={() => void d.issueQuery.refetch()}>
              Try again
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          <IssueDetailHeader
            issue={d.issue}
            tab={d.tab}
            onTabChange={d.setTab}
            busy={d.busy}
            onResolve={d.onResolve}
            onTriage={d.onTriage}
            onExportFixture={d.onExportFixture}
            onSaveRegression={d.onSaveRegression}
            onOpenHandoff={() => d.setTab("handoff")}
          />

          {d.tab === "overview" ? (
            <>
              <section aria-label="Evidence" data-testid="issue-detail-evidence-first">
                <IssueStumblesList
                  stumbles={d.stumbles}
                  error={d.stumblesError}
                  onRetry={() => void d.stumblesQuery.refetch()}
                  preserve={d.preserve}
                />
              </section>
              <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <IssueStat label="Stumbles" value={d.issue.stumble_count} />
                <IssueStat label="Users" value={d.issue.user_count} />
                <IssueStat label="Repeats" value={d.issue.repetition_count} />
                <IssueStat label="Agent" value={d.issue.agent_id ?? "—"} />
              </div>
              <IssueRegressionPanel
                cases={d.regressionCases}
                caseId={d.issue.regression_case_id}
                onSave={() => void d.onSaveRegression()}
                busy={d.busy === "regression"}
                error={d.regressionError}
                onRetry={() => void d.regressionQuery.refetch()}
              />
              {d.issue.triage_result && Object.keys(d.issue.triage_result).length > 0 ? (
                <details className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
                  <summary className="cursor-pointer text-sm font-semibold">Triage result</summary>
                  <pre className="mt-2 overflow-x-auto rounded bg-[var(--bg-tertiary)] p-2 font-mono text-xs">
                    {JSON.stringify(d.issue.triage_result, null, 2)}
                  </pre>
                </details>
              ) : null}
            </>
          ) : null}

          {d.tab === "triage" ? (
            <IssueTriagePanel
              triageResult={d.issue.triage_result}
              stumbles={d.stumbles}
              stumblesError={d.stumblesError}
              onStumblesRetry={() => void d.stumblesQuery.refetch()}
              preserve={d.preserve}
            />
          ) : null}

          {d.tab === "handoff" && d.orgId && issueId ? (
            <IssueHandoffPanel
              orgId={d.orgId}
              issueId={issueId}
              fingerprint={d.issue.fingerprint}
              title={d.issue.title}
              kind={d.issue.kind}
              busy={d.busy !== null}
              onExportFixture={() => void d.onExportFixture()}
              onCopy={() => d.toast.success("Handoff prompt copied")}
            />
          ) : null}

          {d.tab === "experiment" ? (
            <IssueExperimentPanel
              issueId={issueId}
              experimentResult={d.issue.experiment_result as Record<string, unknown> | null}
              experiments={d.experiments as Record<string, unknown>[]}
              experimentsError={d.experimentsError}
              busy={d.busy !== null}
              onCreateExperiment={() => void d.onCreateExperiment()}
              onExperimentReport={(id) => void d.onExperimentReport(id)}
              onRetry={() => void d.experimentsQuery.refetch()}
            />
          ) : null}
        </div>
      )}
    </PageContent>
  );
}
