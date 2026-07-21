"use client";

import Link from "next/link";
import { Copy, Download, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { improveHref } from "@/lib/portal-cross-links";

export function CodingAgentHandoff({
  orgId,
  issueId,
  fingerprint,
  title,
  kind,
  onCopy,
}: {
  orgId: string;
  issueId: string;
  fingerprint: string;
  title: string;
  kind: string;
  onCopy: () => void;
}) {
  const prompt = [
    `# Eden issue handoff`,
    `org: ${orgId}`,
    `issue_id: ${issueId}`,
    `fingerprint: ${fingerprint}`,
    `kind: ${kind}`,
    `title: ${title}`,
    ``,
    `Fix this production agent failure. Export the Eden fixture from the issue`,
    `page, reproduce locally, open a PR. Prefer Eden Improve plan approve`,
    `when an N20 improvement_plan already exists for this fingerprint.`,
  ].join("\n");

  return (
    <div
      data-testid="coding-agent-handoff"
      className="space-y-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Wrench className="h-4 w-4" /> Open in coding agent
        </h3>
        <Button
          size="sm"
          variant="secondary"
          className="min-h-11"
          onClick={() => {
            void navigator.clipboard.writeText(prompt).then(onCopy);
          }}
        >
          <Copy className="h-3 w-3 mr-1" /> Copy prompt
        </Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-[var(--text-secondary)]">
        {prompt}
      </pre>
    </div>
  );
}

export function IssueHandoffPanel({
  orgId,
  issueId,
  fingerprint,
  title,
  kind,
  busy,
  onExportFixture,
  onCopy,
}: {
  orgId: string;
  issueId: string;
  fingerprint: string;
  title: string;
  kind: string;
  busy: boolean;
  onExportFixture: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-4 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
      <p className="text-sm text-[var(--text-secondary)]">
        Ship a fix via the Improve queue, coding-agent handoff, or fixture export. Copy the
        handoff prompt below into your coding agent.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" className="min-h-11" asChild>
          <Link href={improveHref(issueId)} data-testid="issue-improve-link">
            View improvement plan
          </Link>
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={onExportFixture}
        >
          <Download className="h-3 w-3 mr-1" /> Export fixture
        </Button>
      </div>
      <CodingAgentHandoff
        orgId={orgId}
        issueId={issueId}
        fingerprint={fingerprint}
        title={title}
        kind={kind}
        onCopy={onCopy}
      />
    </div>
  );
}
