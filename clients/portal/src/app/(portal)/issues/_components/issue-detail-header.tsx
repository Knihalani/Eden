"use client";

import Link from "next/link";
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  Database,
  Download,
  Package,
  Stethoscope,
  Wrench,
  Bug,
} from "lucide-react";
import type { AgentIssue } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { improveHref } from "@/lib/portal-cross-links";
import {
  RegressionBadge,
  RepeatBadge,
  IssueSeverityBadge,
  StatusBadge,
} from "./issue-badges";

export type IssueDetailTab = "overview" | "triage" | "handoff" | "experiment";

const TABS: { id: IssueDetailTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "triage", label: "Triage" },
  { id: "handoff", label: "Handoff" },
  { id: "experiment", label: "Experiment" },
];

export function IssueDetailHeader({
  issue,
  tab,
  onTabChange,
  busy,
  onResolve,
  onTriage,
  onExportFixture,
  onSaveRegression,
  onOpenHandoff,
}: {
  issue: AgentIssue;
  tab: IssueDetailTab;
  onTabChange: (tab: IssueDetailTab) => void;
  busy: string | null;
  onResolve: (status: "resolved" | "ignored") => void;
  onTriage: () => void;
  onExportFixture: () => void;
  onSaveRegression: () => void;
  onOpenHandoff: () => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <IssueSeverityBadge severity={issue.severity} />
        <StatusBadge status={issue.status} />
        <RegressionBadge regressionCaseId={issue.regression_case_id} status={issue.status} />
        <span className="rounded bg-[var(--bg-tertiary)] px-2 py-0.5 font-mono text-xs text-[var(--text-muted)]">
          {issue.kind}
        </span>
        {issue.repetition_count > 1 ? <RepeatBadge count={issue.repetition_count} /> : null}
      </div>
      <h1 className="text-lg font-semibold text-[var(--text-primary)]">{issue.title}</h1>
      <p className="mt-1 break-all font-mono text-xs text-[var(--text-muted)]">
        fingerprint: {issue.fingerprint}
      </p>

      <Tabs value={tab} onValueChange={(v) => onTabChange(v as IssueDetailTab)} className="mt-space-4">
        <TabsList
          variant="underline"
          aria-label="Issue sections"
          className="h-auto w-full justify-start gap-space-1 bg-transparent"
        >
          {TABS.map((t) => (
            <TabsTrigger key={t.id} variant="underline" value={t.id} className="min-h-11">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div
        className="mt-space-4 flex flex-wrap items-center gap-space-2"
        data-testid="issue-detail-actions"
      >
        <Button
          size="sm"
          variant="default"
          className="min-h-11"
          disabled={busy !== null || issue.status === "resolved"}
          onClick={() => onResolve("resolved")}
        >
          <CheckCircle2 className="mr-1 h-3 w-3" /> Resolve
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="min-h-11"
              disabled={busy !== null}
              aria-label="Secondary actions"
            >
              Actions
              <ChevronDown className="h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[14rem]">
            <DropdownMenuItem disabled={busy !== null} onSelect={() => void onTriage()}>
              <Stethoscope className="mr-2 h-3 w-3" /> Re-triage
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy !== null} onSelect={() => void onExportFixture()}>
              <Download className="mr-2 h-3 w-3" /> Export fixture
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy !== null} onSelect={() => void onSaveRegression()}>
              <Database className="mr-2 h-3 w-3" /> Save regression
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={improveHref(issue.id)} data-testid="issue-improve-link">
                <Bug className="mr-2 h-3 w-3" /> Improvement plan
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/artifacts">
                <Package className="mr-2 h-3 w-3" /> Open artifacts
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenHandoff}>
              <Wrench className="mr-2 h-3 w-3" /> Open in coding agent
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={busy !== null || issue.status === "ignored"}
              onSelect={() => void onResolve("ignored")}
            >
              <Ban className="mr-2 h-3 w-3" /> Ignore
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
