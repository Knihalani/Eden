"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, BookOpen, Loader2, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Panel } from "@/components/ui/panel";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { DiffViewer } from "@/components/improve/diff-viewer";
import { MarkdownProse, textToUnifiedDiff } from "@/components/improve/markdown-prose";
import { learnApi } from "@/lib/api";
import {
  artifactHref,
  driftHref,
  issueFullHref,
  traceHref,
  tracesFilteredHref,
} from "@/lib/portal-cross-links";
import { errorFromCaught } from "@/lib/safe-error-message";

function CitationChip({ cite }: { cite: string }) {
  if (cite.startsWith("artifact:")) {
    const id = cite.replace("artifact:", "");
    return (
      <Link href={artifactHref(id)} className="rounded bg-[var(--accent-faint)] px-2 py-1 text-xs hover:underline">
        artifact:{id.slice(0, 8)}
      </Link>
    );
  }
  if (cite.startsWith("trace:")) {
    const id = cite.replace("trace:", "");
    return (
      <Link href={traceHref(id)} className="rounded bg-[var(--accent-faint)] px-2 py-1 text-xs hover:underline">
        trace:{id.slice(0, 8)}
      </Link>
    );
  }
  if (cite.length > 8) {
    return (
      <Link
        href={issueFullHref(cite)}
        className="rounded bg-[var(--accent-faint)] px-2 py-1 text-xs hover:underline"
      >
        issue:{cite.slice(0, 8)}
      </Link>
    );
  }
  return <span className="rounded bg-[var(--bg-secondary)] px-2 py-1 text-xs">{cite}</span>;
}

export default function AgentLedgerPage() {
  const params = useParams<{ id: string }>();
  const agentId = useMemo(
    () => (params?.id ? decodeURIComponent(params.id) : ""),
    [params?.id],
  );
  const { currentOrg } = useOrg();
  const { hasPermission } = usePermissions();
  const canMutateLedger = hasPermission("jobs:write");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<Array<Record<string, unknown>>>([]);
  const [enabled, setEnabled] = useState(false);
  const [maxTokens, setMaxTokens] = useState(800);
  const [version, setVersion] = useState(0);
  const [sinceVersion, setSinceVersion] = useState(0);
  const [diff, setDiff] = useState<Array<Record<string, unknown>>>([]);
  const [diffText, setDiffText] = useState("");
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const [task, setTask] = useState("");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrg || !agentId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await learnApi.getLedger(currentOrg.id, agentId);
      const ledger = res.data?.ledger as Record<string, unknown> | undefined;
      const config = res.data?.config as Record<string, unknown> | undefined;
      setEntries((ledger?.entries as Array<Record<string, unknown>>) ?? []);
      setEnabled(Boolean(config?.enabled));
      setMaxTokens(Number(config?.max_tokens ?? 800));
      setVersion(Number(ledger?.version ?? 0));
    } catch (e) {
      setError(errorFromCaught(e, "Failed to load ledger"));
    } finally {
      setLoading(false);
    }
  }, [currentOrg, agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runPreview = async () => {
    if (!currentOrg || !agentId) return;
    const res = await learnApi.previewLedger(currentOrg.id, agentId, { task: task || "Sample task" });
    setPreview((res.data?.preview as Record<string, unknown>) ?? null);
  };

  const loadDiff = async () => {
    if (!currentOrg || !agentId) return;
    const res = await learnApi.ledgerDiff(currentOrg.id, agentId, sinceVersion);
    const rows = (res.data?.diff as Array<Record<string, unknown>>) ?? [];
    setDiff(rows);
    const parts = rows.map((d) => {
      const chapter = String(d.chapter ?? "chapter");
      const before = String(d.before ?? d.old_text ?? "");
      const after = String(d.after ?? d.new_text ?? d.text ?? "");
      if (before || after) return textToUnifiedDiff(before, after, chapter);
      return `--- a/${chapter}\n+++ b/${chapter}\n@@ -1,1 +1,1 @@\n-v${String(d.version ?? "?")}\n+v${String(d.version ?? "?")} · ${chapter}`;
    });
    setDiffText(parts.join("\n") || textToUnifiedDiff("", entries.map((e) => String(e.text ?? "")).join("\n\n"), "ledger"));
  };

  const toggleInject = async (on: boolean) => {
    if (!currentOrg || !agentId || !canMutateLedger) return;
    try {
      await learnApi.patchLedgerConfig(currentOrg.id, agentId, { enabled: on, max_tokens: maxTokens });
      setEnabled(on);
    } catch (e) {
      setError(errorFromCaught(e, "Failed to update ledger config"));
    }
  };

  const saveMaxTokens = async (value: number) => {
    if (!currentOrg || !agentId || !canMutateLedger) return;
    setMaxTokens(value);
    try {
      await learnApi.patchLedgerConfig(currentOrg.id, agentId, { enabled, max_tokens: value });
    } catch (e) {
      setError(errorFromCaught(e, "Failed to update ledger config"));
    }
  };

  const regenerate = async () => {
    if (!currentOrg || !agentId || !canMutateLedger) return;
    setRegenerating(true);
    try {
      await learnApi.regenerateLedger(currentOrg.id, agentId);
      await load();
    } catch (e) {
      setError(errorFromCaught(e, "Regenerate failed"));
    } finally {
      setRegenerating(false);
    }
  };

  useKeyboardShortcuts(
    {
      d: () => void loadDiff(),
      r: () => {
        if (canMutateLedger) void regenerate();
      },
    },
    Boolean(agentId),
  );

  if (!currentOrg) {
    return <NoOrgState feature="Agent ledger" icon={BookOpen} />;
  }

  return (
    <PageContent className="space-y-space-4">
      <PageHeader
        eyebrow="Agent"
        title="The Book"
        description="Living memory — failures, fixes, and gotchas as markdown with citation chips."
      />
      <Button asChild variant="ghost" size="sm" className="min-h-11 px-0 w-fit">
        <Link href={`/agents/${encodeURIComponent(agentId)}`}>
          <ArrowLeft className="h-4 w-4" />
          Back to agent
        </Link>
      </Button>
      <nav
        aria-label="Related"
        data-testid="agent-ledger-related-strip"
        className="flex flex-wrap items-center gap-x-space-3 gap-y-1 text-xs text-[var(--text-muted)]"
      >
        <Link href="/improve" className="text-[var(--accent)] hover:underline">
          Queue
        </Link>
        <Link href={artifactHref()} className="text-[var(--accent)] hover:underline">
          Artifacts
        </Link>
        <Link href="/ledger" className="text-[var(--accent)] hover:underline">
          Ledger
        </Link>
        <Link href={driftHref(agentId)} className="text-[var(--accent)] hover:underline">
          Drift
        </Link>
        <Link
          href={tracesFilteredHref({ agent_id: agentId })}
          className="text-[var(--accent)] hover:underline"
        >
          Traces
        </Link>
      </nav>
      <Panel tone="flat" padding="md" className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <BookOpen className="h-5 w-5" />
          <span className="text-sm">Gateway injection {enabled ? "on" : "off"}</span>
          {canMutateLedger ? (
            <Button variant="outline" size="sm" onClick={() => void toggleInject(!enabled)}>
              {enabled ? "Disable" : "Enable"}
            </Button>
          ) : (
            <span className="text-xs text-[var(--text-muted)]">View only — ask a member to change</span>
          )}
          <span className="text-xs text-[var(--text-muted)]">v{version}</span>
          {canMutateLedger ? (
            <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              Max tokens
              <input
                type="range"
                min={500}
                max={2000}
                step={100}
                value={maxTokens}
                onChange={(e) => void saveMaxTokens(Number(e.target.value))}
                className="w-24"
              />
              {maxTokens}
            </label>
          ) : (
            <span className="text-xs text-[var(--text-muted)]">Max tokens {maxTokens}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Task for inject preview"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            className="w-48"
          />
          <Button variant="outline" size="sm" onClick={() => void runPreview()}>
            Preview inject
          </Button>
          <Button variant="outline" size="sm" onClick={() => void loadDiff()}>
            Version diff
          </Button>
          {canMutateLedger ? (
            <Button variant="outline" size="sm" onClick={() => void regenerate()} disabled={regenerating}>
              {regenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          ) : null}
        </div>
      </Panel>
      {preview ? (
        <Panel tone="inset" padding="md" className="mb-4 space-y-2 text-sm">
          <div className="font-medium">Inject preview</div>
          <div className="flex flex-wrap gap-4 text-xs text-[var(--text-muted)]">
            <span>Tokens: {String(preview.tokens ?? "—")}</span>
            <span>Est. $/match: {String(preview.est_usd_per_match ?? "—")}</span>
          </div>
          <MarkdownProse content={String(preview.injected_block ?? "")} />
        </Panel>
      ) : null}
      {diffText || diff.length > 0 ? (
        <Panel tone="inset" padding="md" className="mb-4 space-y-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-medium">Version diff since v{sinceVersion}</div>
            <Input
              type="number"
              className="w-24"
              value={sinceVersion}
              onChange={(e) => setSinceVersion(Number(e.target.value))}
              aria-label="Compare since version"
            />
          </div>
          {diff.length > 0 ? (
            <div className="flex flex-wrap gap-2 text-xs text-[var(--text-muted)]">
              {diff.map((d, i) => (
                <span key={i}>
                  v{String(d.version)} · {String(d.chapter)}
                </span>
              ))}
            </div>
          ) : null}
          <DiffViewer
            diff={diffText}
            diffMode={diffMode}
            onModeChange={setDiffMode}
            emptyMessage="No chapter text changes in this range."
          />
        </Panel>
      ) : null}
      {error ? (
        <ErrorState
          title="Could not load ledger"
          message={error}
          className="mb-4"
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void load()}
              disabled={loading}
              loading={loading}
            >
              Try again
            </Button>
          }
        />
      ) : null}
      {error ? null : loading ? (
        <Loader2 className="h-8 w-8 animate-spin" />
      ) : entries.length === 0 ? (
        <EmptyState
          title="Ledger draft empty"
          description="Draft is empty. Resolve an issue or promote an Artifact to seed living memory for this agent."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" variant="outline" asChild>
                <Link href="/issues">Resolve an issue</Link>
              </Button>
              <Button size="sm" asChild>
                <Link href={artifactHref()}>Promote an artifact</Link>
              </Button>
            </div>
          }
        />
      ) : (
        <div className="space-y-3" data-testid="ledger-markdown-entries">
          {entries.map((e) => {
            const cites = (e.citations as string[] | undefined) ?? [];
            return (
              <article
                key={String(e.id)}
                className="border-b border-[var(--border-subtle)] pb-space-4 last:border-b-0"
              >
                <div className="text-xs text-[var(--text-muted)]">
                  {String(e.chapter)} · v{String(e.version)}
                </div>
                <MarkdownProse
                  className="mt-1 prose-calm"
                  content={String(e.content_md ?? e.text ?? "")}
                />
                {cites.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1" aria-label="Citations">
                    {cites.map((c) => (
                      <CitationChip key={c} cite={String(c)} />
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
      <p className="mt-4 text-center text-xs text-[var(--text-muted)]">
        <kbd>d</kbd> version diff · <kbd>r</kbd> regenerate
      </p>
    </PageContent>
  );
}
