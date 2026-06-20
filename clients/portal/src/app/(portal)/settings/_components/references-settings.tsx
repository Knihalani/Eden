"use client";

import { useState, useEffect } from "react";
import { Trash2, Code, Plus, Loader2 } from "lucide-react";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { api } from "@/lib/api";
import { SettingsCard } from "@/components/settings/settings-card";
import { EmptyState } from "@/components/ui/empty-state";
import type { CodeReference, Organization } from "@/lib/types";

interface ReferencesSettingsProps {
  org: Organization | null;
}

export function ReferencesSettings({ org }: ReferencesSettingsProps) {
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [references, setReferences] = useState<CodeReference[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState<{ purpose?: string; language?: string }>({});

  const loadReferences = async () => {
    if (!org) return;
    setLoading(true);
    try {
      const data = await api.listReferences(org.id, filter);
      setReferences(data);
    } catch {
      // Fall through with empty
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect -- legitimate pattern: refetch on org/filter change
  useEffect(() => {
    loadReferences();
  }, [org?.id, filter.purpose, filter.language]);

  const handleUpload = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!org) return;

    const formData = new FormData(e.currentTarget);
    setUploading(true);
    try {
      await api.uploadReference(org.id, formData);
      (e.target as HTMLFormElement).reset();
      await loadReferences();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to upload reference";
      toast.error(message);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (refId: string) => {
    if (!org) return;
    if (
      !(await confirm({
        title: "Delete reference",
        description: "Delete this code reference? This cannot be undone.",
        confirmLabel: "Delete",
        variant: "destructive",
      }))
    )
      return;
    try {
      await api.deleteReference(org.id, refId);
      await loadReferences();
      toast.success("Reference deleted");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to delete";
      toast.error(message);
    }
  };

  if (!org) {
    return (
      <SettingsCard title="Code References">
        <EmptyState
          icon={Code}
          title="No organization selected"
          description="Select an organization above to manage its code references."
          size="md"
        />
      </SettingsCard>
    );
  }

  return (
    <div className="space-y-4">
      {hasPermission("references:upload") && (
        <SettingsCard
          title="Upload a code reference"
          description="Help Eden learn your team's coding style. Examples: auth patterns, API clients, error handling."
        >
          <form onSubmit={handleUpload} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                name="name"
                placeholder="Display name"
                required
                className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
              />
              <input
                name="purpose"
                placeholder="Purpose (e.g., Auth patterns)"
                required
                className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
              />
            </div>
            <textarea
              name="description"
              placeholder="Description (optional)"
              rows={2}
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
            />
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                name="file"
                type="file"
                required
                accept=".py,.js,.ts,.tsx,.go,.rs,.java,.rb,.php,.c,.cpp,.cs,.swift,.kt,.sql,.sh,.yaml,.yml,.json,.md"
                className="flex-1 text-sm"
              />
              <button
                type="submit"
                disabled={uploading}
                className="px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Upload
              </button>
            </div>
          </form>
        </SettingsCard>
      )}

      <SettingsCard
        title="Filters"
        description="Narrow by purpose or language."
        contentClassName="flex flex-wrap gap-3"
      >
        <select
          value={filter.purpose || ""}
          onChange={(e) => setFilter({ ...filter, purpose: e.target.value || undefined })}
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] text-sm bg-[var(--bg-secondary)] text-[var(--text-primary)]"
        >
          <option value="">All purposes</option>
        </select>
        <select
          value={filter.language || ""}
          onChange={(e) => setFilter({ ...filter, language: e.target.value || undefined })}
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] text-sm bg-[var(--bg-secondary)] text-[var(--text-primary)]"
        >
          <option value="">All languages</option>
          <option value="python">Python</option>
          <option value="javascript">JavaScript</option>
          <option value="typescript">TypeScript</option>
          <option value="go">Go</option>
          <option value="rust">Rust</option>
        </select>
      </SettingsCard>

      <SettingsCard title="References" description={`${references.length} on file`}>
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : references.length === 0 ? (
          <EmptyState
            icon={Code}
            title="No code references yet"
            description="Upload an example file and Eden will mirror your team's coding style across generated environments."
            size="md"
          />
        ) : (
          <div className="space-y-3">
            {references.map((ref) => (
              <div
                key={ref.id}
                className="p-4 bg-[var(--bg-secondary)] rounded-xl border border-[var(--border-default)] flex items-center justify-between"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[var(--text-primary)]">{ref.name}</span>
                    <span className="px-2 py-0.5 bg-[var(--bg-tertiary)] rounded text-xs text-[var(--text-secondary)]">
                      {ref.language}
                    </span>
                  </div>
                  <p className="text-sm text-[var(--text-muted)] truncate">{ref.filename}</p>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className="text-xs px-2 py-0.5 bg-[var(--accent-bg)] text-[var(--accent)] rounded">
                      {ref.purpose}
                    </span>
                    {ref.description && (
                      <span className="text-xs text-[var(--text-secondary)]">{ref.description}</span>
                    )}
                  </div>
                </div>
                {hasPermission("references:delete") && (
                  <button
                    onClick={() => handleDelete(ref.id)}
                    className="p-2 text-[var(--error)] hover:bg-[var(--error-bg)] rounded-lg ml-4"
                    title="Delete reference"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </SettingsCard>
      {ConfirmDialog}
    </div>
  );
}
