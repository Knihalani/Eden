"use client";

/**
 * ReferencesTab — extracted from settings/page.tsx (June 2026 Phase 5).
 * Upload / list / filter / delete org-scoped code reference files.
 */

import { useEffect, useState } from "react";
import { Code, Loader2, Plus, Trash2 } from "lucide-react";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { api } from "@/lib/api";
import { SettingsCard } from "@/components/settings/settings-card";
import { FilterBar } from "@/components/ui/filter-bar";
import { Card } from "@/components/ui/card";

interface ReferencesTabProps {
  org: { id: string; name: string; role: string } | null;
}

interface Reference {
  id: string;
  name: string;
  filename: string;
  language: string;
  purpose: string;
  description?: string;
}

export function ReferencesTab({ org }: ReferencesTabProps) {
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [references, setReferences] = useState<Reference[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState<{ purpose?: string; language?: string }>({});

  const loadReferences = async () => {
    if (!org) return;
    setLoading(true);
    try {
      const data = await api.listReferences(org.id, filter);
      setReferences(data as Reference[]);
    } catch (e) {
      console.error("Failed to load references", e);
      toast.error(e instanceof Error ? e.message : "Failed to load references");
    } finally {
      setLoading(false);
    }
  };

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
      toast.error(err instanceof Error ? err.message : "Failed to upload reference");
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (refId: string) => {
    if (
      !org ||
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
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  if (!org) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to manage code references
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {hasPermission("references:upload") && (
        <SettingsCard title="Upload code reference">
          <form onSubmit={handleUpload} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                name="name"
                placeholder="Display name"
                required
                aria-label="Display name"
                className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
              />
              <input
                name="purpose"
                placeholder="Purpose (e.g., Auth patterns)"
                required
                aria-label="Purpose"
                className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
              />
            </div>
            <textarea
              name="description"
              placeholder="Description (optional)"
              rows={2}
              aria-label="Description"
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
            />
            <div className="flex gap-3">
              <input
                name="file"
                type="file"
                required
                accept=".py,.js,.ts,.tsx,.go,.rs,.java,.rb,.php,.c,.cpp,.cs,.swift,.kt,.sql,.sh,.yaml,.yml,.json,.md"
                aria-label="Code file"
                className="flex-1 text-sm"
              />
              <button
                type="submit"
                disabled={uploading}
                className="px-4 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Upload
              </button>
            </div>
          </form>
        </SettingsCard>
      )}

      <FilterBar
        filters={{
          purpose: filter.purpose || "",
          language: filter.language || "",
        }}
        onChange={(next) =>
          setFilter({
            purpose: next.purpose || undefined,
            language: next.language || undefined,
          })
        }
        selects={[
          {
            key: "purpose",
            label: "All purposes",
            value: filter.purpose || "",
            options: [],
          },
          {
            key: "language",
            label: "All languages",
            value: filter.language || "",
            options: [
              { value: "python", label: "Python" },
              { value: "javascript", label: "JavaScript" },
              { value: "typescript", label: "TypeScript" },
              { value: "go", label: "Go" },
              { value: "rust", label: "Rust" },
            ],
          },
        ]}
      />

      <div className="grid gap-3">
        {references.map((ref) => (
          <Card
            key={ref.id}
            padding="md"
            className="flex items-center justify-between"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-[var(--text-primary)]">{ref.name}</span>
                <span className="px-2 py-0.5 bg-[var(--bg-tertiary)] rounded text-xs text-[var(--text-secondary)]">
                  {ref.language}
                </span>
              </div>
              <p className="text-sm text-[var(--text-muted)] truncate">{ref.filename}</p>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs px-2 py-0.5 bg-[var(--accent-faint)] text-[var(--accent)] rounded">
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
                className="p-2 text-[var(--error)] hover:bg-[var(--error-dim)] rounded-lg ml-4"
                title="Delete reference"
                aria-label={`Delete ${ref.name}`}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </Card>
        ))}
        {references.length === 0 && !loading && (
          <div className="text-center py-12 text-[var(--text-secondary)]">
            <Code className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No code references yet</p>
            <p className="text-sm">Upload code examples to help Eden learn your patterns</p>
          </div>
        )}
      </div>
      {ConfirmDialog}
    </div>
  );
}
