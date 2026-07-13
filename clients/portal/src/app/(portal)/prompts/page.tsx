"use client";

import { useState, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { errorFromCaught } from "@/lib/safe-error-message";
import {
  FileText,
  GitBranch,
  Loader2,
  Plus,
  History,
  ChevronDown,
  ChevronRight } from "lucide-react";

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
 * version timeline with a diff column (next to be added in
 * a follow-up).
 */
export default function PromptsPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const toast = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, VersionEntry[]>>({});
  const [versionsLoading, setVersionsLoading] = useState<string | null>(null);
  const [showNewPrompt, setShowNewPrompt] = useState(false);
  const [newPromptName, setNewPromptName] = useState("");
  const [newPromptDesc, setNewPromptDesc] = useState("");
  const [newPromptAutoEval, setNewPromptAutoEval] = useState(false);

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
    async (name: string) => {
      if (!orgId) return;
      setVersionsLoading(name);
      try {
        const d = await api.get<{ data: { versions: VersionEntry[] } }>(
          `/orgs/${orgId}/prompts/${encodeURIComponent(name)}`
        );
        setVersions((prev) => ({ ...prev, [name]: d.data?.versions || [] }));
      } catch (err) {
        toast.error("Failed to load prompt versions", errorFromCaught(err, "Please try again."));
      } finally {
        setVersionsLoading(null);
      }
    },
    [orgId, toast]
  );

  const handleToggle = useCallback(
    (name: string) => {
      if (expanded === name) {
        setExpanded(null);
      } else {
        setExpanded(name);
        if (!versions[name]) {
          fetchVersions(name);
        }
      }
    },
    [expanded, versions, fetchVersions]
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
        icon={FileText}
        title="Prompt Versions"
        subtitle="D.9 — Per-org prompt registry with version timeline + auto-eval"
      />

      <div className="flex items-center justify-end">
        <Button type="button" size="sm" onClick={() => setShowNewPrompt(!showNewPrompt)}>
          <Plus className="h-4 w-4" />
          New prompt
        </Button>
      </div>

      {showNewPrompt && (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-6">
          <h2 className="mb-4 text-lg font-semibold text-[var(--text-primary)]">
            New prompt entry
          </h2>
          <div className="space-y-3">
            <input
              type="text"
              value={newPromptName}
              onChange={(e) => setNewPromptName(e.target.value)}
              placeholder="Prompt name (e.g. support_reply_v1)"
              className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-elev-2)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
            <textarea
              value={newPromptDesc}
              onChange={(e) => setNewPromptDesc(e.target.value)}
              placeholder="Description (optional)"
              rows={2}
              className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-elev-2)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
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
              <button
                type="button"
                onClick={() => setShowNewPrompt(false)}
                className="rounded-md border border-[var(--border-default)] bg-[var(--bg-elev-2)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-elev-1)]"
              >
                Cancel
              </button>
              <Button
                type="button"
                size="sm"
                onClick={handleCreate}
                loading={createMutation.isPending}
              >
                Create
              </Button>
            </div>
          </div>
        </div>
      )}

      {promptsQuery.isLoading ? (
        <div className="flex items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-8">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--text-secondary)]" />
        </div>
      ) : promptsQuery.isError ? (
        <ErrorState
          message={promptsQuery.error?.message}
          action={
            <Button size="sm" onClick={() => promptsQuery.refetch()}>
              Try again
            </Button>
          }
        />
      ) : prompts.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No prompts yet"
          description="Create your first prompt to start the version timeline."
        />
      ) : (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)]">
          <div className="divide-y divide-[var(--border-default)]">
            {prompts.map((p) => {
              const isOpen = expanded === p.name;
              const v = versions[p.name] || [];
              return (
                <div key={p.id}>
                  <button
                    type="button"
                    onClick={() => handleToggle(p.name)}
                    className="flex w-full items-center justify-between p-4 text-left hover:bg-[var(--bg-elev-2)]"
                  >
                    <div className="flex items-center gap-3">
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 text-[var(--text-secondary)]" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-[var(--text-secondary)]" />
                      )}
                      <div>
                        <div className="text-sm font-medium text-[var(--text-primary)]">
                          {p.name}
                        </div>
                        {p.description && (
                          <div className="mt-0.5 text-xs text-[var(--text-secondary)]">
                            {p.description}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-[var(--text-secondary)]">
                      {p.auto_eval_on_save && (
                        <span className="rounded bg-[var(--success-bg)] px-1.5 py-0.5 text-[var(--success)]">
                          auto-eval
                        </span>
                      )}
                      <span>
                        Created {new Date(p.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="border-t border-[var(--border-default)] bg-[var(--bg-elev-2)] p-4">
                      <div className="mb-3 flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                        <History className="h-3 w-3" />
                        Version timeline ({v.length})
                      </div>
                      {versionsLoading === p.name ? (
                        <div className="flex items-center justify-center py-4">
                          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-secondary)]" />
                        </div>
                      ) : v.length === 0 ? (
                        <div className="text-xs text-[var(--text-secondary)]">
                          No versions yet — POST to /prompts/{p.name}/versions
                          with a template + model.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {v.map((ver) => (
                            <div
                              key={ver.id}
                              className="rounded-md border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-3"
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <GitBranch className="h-3 w-3 text-[var(--text-secondary)]" />
                                  <span className="text-sm font-medium text-[var(--text-primary)]">
                                    v{ver.version}
                                  </span>
                                  <span className="rounded bg-[var(--bg-elev-2)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]">
                                    {ver.model}
                                  </span>
                                  <code className="text-xs text-[var(--text-secondary)]">
                                    {ver.template_hash.slice(0, 12)}
                                  </code>
                                </div>
                                <div className="text-xs text-[var(--text-secondary)]">
                                  {new Date(ver.created_at).toLocaleString()}
                                </div>
                              </div>
                              <pre className="mt-2 max-h-32 overflow-auto rounded bg-[var(--bg-elev-2)] p-2 text-xs text-[var(--text-primary)]">
                                {ver.template}
                              </pre>
                              {ver.change_note && (
                                <div className="mt-2 text-xs text-[var(--text-secondary)]">
                                  Note: {ver.change_note}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </PageContent>
  );
}