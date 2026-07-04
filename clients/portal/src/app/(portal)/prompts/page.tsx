"use client";

import { useEffect, useState, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { PageHeader } from "@/components/layout/page-header";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useToast } from "@/components/ui/toast";
import {
  FileText,
  GitBranch,
  Loader2,
  Plus,
  History,
  ChevronDown,
  ChevronRight } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

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
  const toast = useToast();
  const [prompts, setPrompts] = useState<PromptEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, VersionEntry[]>>({});
  const [showNewPrompt, setShowNewPrompt] = useState(false);
  const [newPromptName, setNewPromptName] = useState("");
  const [newPromptDesc, setNewPromptDesc] = useState("");
  const [newPromptAutoEval, setNewPromptAutoEval] = useState(false);

  const fetchData = useCallback(async () => {
    if (!currentOrg?.id) return;
    try {
      const res = await fetch(
        `${API_BASE}/orgs/${currentOrg.id}/prompts?limit=100`,
        { credentials: "include" }
      );
      if (res.ok) {
        const d = await res.json();
        setPrompts(d.data?.prompts || []);
      }
    } catch (err) {
      console.error("Prompts fetch failed", err);
      toast.error(err instanceof Error ? err.message : "Failed to load prompts");
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    if (!currentOrg?.id) return;
    fetchData();
  }, [currentOrg?.id, fetchData]);

  const fetchVersions = useCallback(
    async (name: string) => {
      if (!currentOrg?.id) return;
      try {
        const res = await fetch(
          `${API_BASE}/orgs/${currentOrg.id}/prompts/${encodeURIComponent(name)}`,
          { credentials: "include" }
        );
        if (res.ok) {
          const d = await res.json();
          setVersions((prev) => ({ ...prev, [name]: d.data?.versions || [] }));
        }
      } catch (err) {
        console.error("Versions fetch failed", err);
        toast.error(err instanceof Error ? err.message : "Failed to load prompt versions");
      }
    },
    [currentOrg?.id]
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
    if (!currentOrg?.id || !newPromptName.trim()) {
      toast.error("Name required", "Prompt name cannot be empty.");
      return;
    }
    try {
      const res = await fetch(
        `${API_BASE}/orgs/${currentOrg.id}/prompts`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: newPromptName.trim(),
            description: newPromptDesc || null,
            tags: [],
            auto_eval_on_save: newPromptAutoEval }) }
      );
      if (res.ok) {
        toast.success("Prompt created");
        setShowNewPrompt(false);
        setNewPromptName("");
        setNewPromptDesc("");
        setNewPromptAutoEval(false);
        await fetchData();
      } else {
        const err = await res.json().catch(() => null);
        toast.error("Create failed", err?.message || `HTTP ${res.status}`);
      }
    } catch (err) {
      toast.error("Create failed", String(err));
    }
  }, [
    currentOrg?.id,
    newPromptName,
    newPromptDesc,
    newPromptAutoEval,
    toast,
    fetchData,
  ]);

  if (!currentOrg) return <NoOrgState feature="Prompt Versions" />;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6 page-enter">
      <PageHeader
        icon={FileText}
        title="Prompt Versions"
        subtitle="D.9 — Per-org prompt registry with version timeline + auto-eval"
      />

      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => setShowNewPrompt(!showNewPrompt)}
          className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent-foreground)] hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New prompt
        </button>
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
              <button
                type="button"
                onClick={handleCreate}
                className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-foreground)] hover:opacity-90"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)]">
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--text-secondary)]" />
          </div>
        ) : prompts.length === 0 ? (
          <div className="p-8 text-center text-sm text-[var(--text-secondary)]">
            <FileText className="mx-auto mb-2 h-8 w-8 text-[var(--text-secondary)]" />
            No prompts yet. Create your first one to start the version timeline.
          </div>
        ) : (
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
                        <span className="rounded bg-green-500/10 px-1.5 py-0.5 text-green-400">
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
                      {v.length === 0 ? (
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
        )}
      </div>
    </div>
  );
}