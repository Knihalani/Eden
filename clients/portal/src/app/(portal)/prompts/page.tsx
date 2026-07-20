"use client";

import { useState, useCallback, useEffect } from "react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { errorFromCaught } from "@/lib/safe-error-message";
import {
  FileText,
  GitBranch,
  Loader2,
  Plus,
  History,
  ChevronDown,
  ChevronRight,
  ArrowLeftRight,
  Save,
} from "lucide-react";
import { PromptEnvironmentsPanel } from "@/components/prompts/PromptEnvironmentsPanel";

/** Mirror of prompts list empty gate — keep in sync with page render.
 * Not exported: Next.js App Router rejects non-standard page exports. */
function showPromptsEmpty(opts: {
  isLoading: boolean;
  isError: boolean;
  promptCount: number;
}): boolean {
  return !opts.isLoading && !opts.isError && opts.promptCount === 0;
}

interface PromptEntry {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  auto_eval_on_save: boolean;
  created_at: string;
}

interface VersionEntry {
  id: string;
  version: number;
  template: string;
  template_hash: string;
  model: string;
  params: Record<string, unknown>;
  variables: string[];
  change_note: string | null;
  created_by: string;
  created_at: string;
}

/**
 * D.9 prompt versioning page.
 *
 * ponytail: per upgradespec §D.9, customers get a per-org
 * prompt registry with a version timeline + auto-eval on
 * save. The page renders the registry list + a per-prompt
 * version timeline with a diff column comparing each version
 * to its predecessor.
 */
export default function PromptsPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const toast = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, VersionEntry[]>>({});
  const [versionsLoading, setVersionsLoading] = useState<string | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [showNewPrompt, setShowNewPrompt] = useState(false);
  const [newPromptName, setNewPromptName] = useState("");
  const [newPromptDesc, setNewPromptDesc] = useState("");
  const [newPromptAutoEval, setNewPromptAutoEval] = useState(false);
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null);
  const [draftTemplate, setDraftTemplate] = useState("");
  const [draftModel, setDraftModel] = useState("gpt-4o");
  const [draftNote, setDraftNote] = useState("");
  const [versionDirty, setVersionDirty] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);

  const promptsQuery = useOrgQuery(
    queryKeys.prompts.list(orgId),
    orgId,
    () => api.get<{ data: { prompts: PromptEntry[] } }>(`/orgs/${orgId}/prompts?limit=100`),
  );
  const prompts = promptsQuery.data?.data?.prompts ?? [];

  const createMutation = useOrgMutation(
    (payload: { name: string; description: string | null; tags: string[]; auto_eval_on_save: boolean }) =>
      api.post(`/orgs/${orgId}/prompts`, payload),
    { invalidateKeys: [queryKeys.prompts.list(orgId)] },
  );

  const fetchVersions = useCallback(
    async (name: string, opts?: { quiet?: boolean }) => {
      if (!orgId) return;
      if (!opts?.quiet) setVersionsLoading(name);
      setVersionsError(null);
      try {
        const d = await api.get<{ data: { versions: VersionEntry[] } }>(
          `/orgs/${orgId}/prompts/${encodeURIComponent(name)}`
        );
        setVersions((prev) => ({ ...prev, [name]: d.data?.versions || [] }));
      } catch (err) {
        setVersionsError(errorFromCaught(err, "Failed to load prompt versions"));
      } finally {
        setVersionsLoading(null);
      }
    },
    [orgId]
  );

  const resetVersionDraft = useCallback((seed?: VersionEntry | null) => {
    setDraftTemplate(seed?.template ?? "");
    setDraftModel(seed?.model ?? "gpt-4o");
    setDraftNote("");
    setVersionDirty(false);
  }, []);

  const handleToggle = useCallback(
    (name: string) => {
      if (expanded === name) {
        if (versionDirty) {
          const leave = window.confirm(
            "You have an unsaved prompt version. Discard changes?",
          );
          if (!leave) return;
        }
        setExpanded(null);
        setVersionsError(null);
        resetVersionDraft();
      } else {
        if (expanded && versionDirty) {
          const leave = window.confirm(
            "You have an unsaved prompt version. Discard changes?",
          );
          if (!leave) return;
        }
        setExpanded(name);
        setVersionsError(null);
        resetVersionDraft(versions[name]?.[0] ?? null);
        if (!versions[name]) {
          fetchVersions(name);
        }
      }
    },
    [expanded, versions, fetchVersions, versionDirty, resetVersionDraft]
  );

  useEffect(() => {
    if (!expanded || versionDirty) return;
    const latest = versions[expanded]?.[0];
    if (!latest) return;
    if (!draftTemplate) {
      setDraftTemplate(latest.template);
      setDraftModel(latest.model || "gpt-4o");
    }
  }, [expanded, versions, versionDirty, draftTemplate]);

  useEffect(() => {
    if (!versionDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [versionDirty]);

  const handleSaveVersion = useCallback(
    async (name: string) => {
      if (!orgId) return;
      if (!draftTemplate.trim()) {
        toast.error("Template required", "Prompt template cannot be empty.");
        return;
      }
      if (!draftModel.trim()) {
        toast.error("Model required", "Model name cannot be empty.");
        return;
      }
      setSavingVersion(true);
      try {
        await api.post(`/orgs/${orgId}/prompts/${encodeURIComponent(name)}/versions`, {
          template: draftTemplate,
          model: draftModel.trim(),
          params: {},
          variables: [],
          change_note: draftNote.trim() || null,
        });
        toast.success("Version saved");
        setVersionDirty(false);
        await fetchVersions(name, { quiet: true });
      } catch (err) {
        toast.error("Save failed", errorFromCaught(err, "Please try again."));
      } finally {
        setSavingVersion(false);
      }
    },
    [orgId, draftTemplate, draftModel, draftNote, toast, fetchVersions],
  );

  const handleCreate = useCallback(async () => {
    if (!orgId || !newPromptName.trim()) {
      toast.error("Name required", "Prompt name cannot be empty.");
      return;
    }
    try {
      await createMutation.mutateAsync({
        name: newPromptName.trim(),
        description: newPromptDesc || null,
        tags: [],
        auto_eval_on_save: newPromptAutoEval,
      });
      toast.success("Prompt created");
      setShowNewPrompt(false);
      setNewPromptName("");
      setNewPromptDesc("");
      setNewPromptAutoEval(false);
    } catch (err) {
      toast.error("Create failed", errorFromCaught(err, "Please try again."));
    }
  }, [orgId, newPromptName, newPromptDesc, newPromptAutoEval, toast, createMutation]);

  if (!currentOrg) return <NoOrgState icon={FileText} feature="Prompt Versions" />;

  return (
    <PageContent size="wide">
      <PageHeader
        title="Prompt Versions"
        subtitle="Per-org prompt registry with version timeline and auto-eval."
        description="Track template changes over time; optionally auto-eval on every save."
        actions={
          <Button type="button" size="sm" onClick={() => setShowNewPrompt(!showNewPrompt)}>
            <Plus className="h-4 w-4" />
            New prompt
          </Button>
        }
      />

      {showNewPrompt && (
        <Panel tone="flat" padding="md" className="space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            New prompt entry
          </h2>
          <Input
            type="text"
            value={newPromptName}
            onChange={(e) => setNewPromptName(e.target.value)}
            placeholder="Prompt name (e.g. support_reply_v1)"
            className="bg-[var(--bg-inset)]"
          />
          <Textarea
            value={newPromptDesc}
            onChange={(e) => setNewPromptDesc(e.target.value)}
            placeholder="Description (optional)"
            rows={2}
            className="bg-[var(--bg-inset)]"
          />
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={newPromptAutoEval}
              onChange={(e) => setNewPromptAutoEval(e.target.checked)}
              className="h-4 w-4"
            />
            Auto-eval on every new version save
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowNewPrompt(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleCreate}
              loading={createMutation.isPending}
            >
              Create
            </Button>
          </div>
        </Panel>
      )}

      {promptsQuery.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : promptsQuery.isError ? (
        <ErrorState
          message={promptsQuery.error?.message}
          action={
            <Button size="sm" variant="outline" onClick={() => promptsQuery.refetch()}>
              Try again
            </Button>
          }
        />
      ) : showPromptsEmpty({
          isLoading: promptsQuery.isLoading,
          isError: promptsQuery.isError,
          promptCount: prompts.length,
        }) ? (
        <EmptyState
          icon={FileText}
          title="No prompts yet"
          description="Create your first prompt to start the version timeline."
          action={
            <Button size="sm" onClick={() => setShowNewPrompt(true)}>
              <Plus className="h-4 w-4" />
              New prompt
            </Button>
          }
        />
      ) : (
        <div className="divide-y divide-[var(--border-subtle)] rounded-xl bg-[var(--bg-secondary)] overflow-hidden">
          {prompts.map((p) => {
            const isOpen = expanded === p.name;
            const v = versions[p.name] || [];
            return (
              <div key={p.id}>
                <button
                  type="button"
                  onClick={() => handleToggle(p.name)}
                  className="flex w-full items-center justify-between p-4 text-left hover:bg-[var(--bg-tertiary)]/40 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[var(--text-primary)] truncate">
                        {p.name}
                      </div>
                      {p.description && (
                        <div className="mt-0.5 text-xs text-[var(--text-muted)] truncate">
                          {p.description}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-[var(--text-muted)] shrink-0">
                    {p.auto_eval_on_save && (
                      <span className="rounded bg-[var(--terminal-faint)] px-1.5 py-0.5 text-[var(--terminal)] font-mono uppercase tracking-wide text-[length:var(--font-size-2xs)]">
                        auto-eval
                      </span>
                    )}
                    <span>
                      Created {new Date(p.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </button>
                {isOpen && (
                  <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-inset)] p-4">
                    <div className="mb-3 flex items-center gap-2 text-xs font-medium text-[var(--text-muted)]">
                      <History className="h-3 w-3" />
                      Version timeline ({v.length})
                    </div>
                    {versionsLoading === p.name ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
                      </div>
                    ) : versionsError && expanded === p.name && !versions[p.name] ? (
                      <ErrorState
                        size="sm"
                        title="Could not load prompt versions"
                        message={versionsError}
                        action={
                          <Button size="sm" variant="outline" onClick={() => fetchVersions(p.name)}>
                            Try again
                          </Button>
                        }
                      />
                    ) : (
                      <>
                        {v.length === 0 ? (
                          <div className="text-xs text-[var(--text-muted)] mb-3">
                            No versions yet — save a template below to create v1.
                          </div>
                        ) : (
                      <div className="space-y-2">
                        {v.map((ver, idx) => {
                          const prev = idx < v.length - 1 ? v[idx + 1] : null;
                          const diffKey = `${p.name}:v${ver.version}`;
                          const diffStats = prev
                            ? summarizeTemplateDiff(prev.template, ver.template)
                            : null;
                          const showDiff = expandedDiff === diffKey;
                          return (
                            <Panel
                              key={ver.id}
                              tone="subtle"
                              padding="sm"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <GitBranch className="h-3 w-3 text-[var(--text-muted)]" />
                                  <span className="text-sm font-medium text-[var(--text-primary)]">
                                    v{ver.version}
                                  </span>
                                  <span className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-xs text-[var(--text-muted)] font-mono">
                                    {ver.model}
                                  </span>
                                  <code className="text-xs text-[var(--text-muted)]">
                                    {ver.template_hash.slice(0, 12)}
                                  </code>
                                </div>
                                <div className="flex items-center gap-3">
                                  {diffStats && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setExpandedDiff(showDiff ? null : diffKey)
                                      }
                                      className="inline-flex items-center gap-1.5 text-xs text-[var(--accent)] hover:underline"
                                      aria-expanded={showDiff}
                                    >
                                      <ArrowLeftRight className="h-3 w-3" />
                                      {diffStats.added > 0 && (
                                        <span className="text-[var(--terminal)]">+{diffStats.added}</span>
                                      )}
                                      {diffStats.removed > 0 && (
                                        <span className="text-[var(--error)]">-{diffStats.removed}</span>
                                      )}
                                      {diffStats.added === 0 && diffStats.removed === 0 && (
                                        <span className="text-[var(--text-muted)]">no changes</span>
                                      )}
                                    </button>
                                  )}
                                  <div className="text-xs text-[var(--text-muted)]">
                                    {new Date(ver.created_at).toLocaleString()}
                                  </div>
                                </div>
                              </div>
                              {showDiff && prev && (
                                <div className="mt-3 rounded-md overflow-hidden font-mono text-xs ring-1 ring-inset ring-[var(--border-subtle)]">
                                  {buildTemplateDiff(prev.template, ver.template).map((line, li) => (
                                    <div
                                      key={li}
                                      className={
                                        line.type === "added"
                                          ? "bg-[var(--terminal)]/5 text-[var(--terminal)] px-3 py-0.5"
                                          : line.type === "removed"
                                            ? "bg-[var(--error)]/5 text-[var(--error)] px-3 py-0.5"
                                            : "text-[var(--text-muted)] px-3 py-0.5"
                                      }
                                    >
                                      <span className="select-none w-4 inline-block">
                                        {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                                      </span>
                                      {line.content || " "}
                                    </div>
                                  ))}
                                </div>
                              )}
                              <pre className="mt-2 max-h-32 overflow-auto rounded bg-[var(--bg-base)] p-2 text-xs text-[var(--text-primary)]">
                                {ver.template}
                              </pre>
                              {ver.change_note && (
                                <div className="mt-2 text-xs text-[var(--text-muted)]">
                                  Note: {ver.change_note}
                                </div>
                              )}
                            </Panel>
                          );
                        })}
                      </div>
                        )}

                        <Panel tone="flat" padding="md" className="mt-3 space-y-3">
                          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                            {v.length === 0 ? "Create first version" : "Save new version"}
                            {versionDirty ? (
                              <span className="ml-2 text-xs font-normal text-[var(--warning)]">
                                Unsaved changes
                              </span>
                            ) : null}
                          </h3>
                          <Textarea
                            value={draftTemplate}
                            onChange={(e) => {
                              setDraftTemplate(e.target.value);
                              setVersionDirty(true);
                            }}
                            placeholder="Prompt template (supports {{variables}})"
                            rows={6}
                            className="bg-[var(--bg-inset)] font-mono text-xs"
                            aria-label={`Draft template for ${p.name}`}
                            disabled={savingVersion}
                          />
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <Input
                              type="text"
                              value={draftModel}
                              onChange={(e) => {
                                setDraftModel(e.target.value);
                                setVersionDirty(true);
                              }}
                              placeholder="Model (e.g. gpt-4o)"
                              className="bg-[var(--bg-inset)]"
                              aria-label={`Model for ${p.name}`}
                              disabled={savingVersion}
                            />
                            <Input
                              type="text"
                              value={draftNote}
                              onChange={(e) => {
                                setDraftNote(e.target.value);
                                setVersionDirty(true);
                              }}
                              placeholder="Change note (optional)"
                              className="bg-[var(--bg-inset)]"
                              aria-label={`Change note for ${p.name}`}
                              disabled={savingVersion}
                            />
                          </div>
                          <div className="flex justify-end">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void handleSaveVersion(p.name)}
                              loading={savingVersion}
                              disabled={savingVersion || !draftTemplate.trim()}
                            >
                              <Save className="h-4 w-4" />
                              Save version
                            </Button>
                          </div>
                        </Panel>
                      </>
                    )}
                    {orgId ? (
                      <PromptEnvironmentsPanel
                        orgId={orgId}
                        promptName={p.name}
                        latestVersion={v[0]?.version}
                      />
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </PageContent>
  );
}

type DiffLineType = "added" | "removed" | "unchanged";

function summarizeTemplateDiff(oldText: string, newText: string) {
  const lines = buildTemplateDiff(oldText, newText);
  return {
    added: lines.filter((l) => l.type === "added").length,
    removed: lines.filter((l) => l.type === "removed").length,
  };
}

function buildTemplateDiff(
  oldText: string,
  newText: string,
): Array<{ type: DiffLineType; content: string }> {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const lcs = longestCommonSubsequence(oldLines, newLines);
  const out: Array<{ type: DiffLineType; content: string }> = [];
  let oldIdx = 0;
  let newIdx = 0;

  for (const common of lcs) {
    while (oldIdx < common.oldIdx) {
      out.push({ type: "removed", content: oldLines[oldIdx] });
      oldIdx++;
    }
    while (newIdx < common.newIdx) {
      out.push({ type: "added", content: newLines[newIdx] });
      newIdx++;
    }
    out.push({ type: "unchanged", content: common.line });
    oldIdx++;
    newIdx++;
  }
  while (oldIdx < oldLines.length) {
    out.push({ type: "removed", content: oldLines[oldIdx] });
    oldIdx++;
  }
  while (newIdx < newLines.length) {
    out.push({ type: "added", content: newLines[newIdx] });
    newIdx++;
  }
  return out;
}

function longestCommonSubsequence(
  oldLines: string[],
  newLines: string[],
): Array<{ oldIdx: number; newIdx: number; line: string }> {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  const lcs: Array<{ oldIdx: number; newIdx: number; line: string }> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      lcs.unshift({ oldIdx: i - 1, newIdx: j - 1, line: oldLines[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return lcs;
}
