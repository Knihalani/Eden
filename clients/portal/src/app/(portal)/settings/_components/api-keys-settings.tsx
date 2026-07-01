"use client";

import { useState, useEffect } from "react";
import { Plus, Key, Loader2, Trash2, Copy, Check } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { api } from "@/lib/api";
import { SettingsCard } from "@/components/settings/settings-card";
import { EmptyState } from "@/components/ui/empty-state";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import type { Organization } from "@/lib/types";

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_at: string | null;
  last_used_at: string | null;
}

interface ApiKeysSettingsProps {
  org: Organization | null;
}

const ALL_SCOPES = [
  { id: "references:read", label: "Read References" },
  { id: "references:write", label: "Write References" },
  { id: "jobs:read", label: "Read Jobs" },
  { id: "jobs:write", label: "Submit Jobs" },
];

export function ApiKeysSettings({ org }: ApiKeysSettingsProps) {
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadKeys = async () => {
    if (!org) return;
    setLoading(true);
    try {
      const data = await api.listApiKeys(org.id);
      setKeys(data);
    } catch {
      // Fall through
    } finally {
      setLoading(false);
    }
  };

   
  useEffect(() => {
    loadKeys();
  }, [org?.id]);

  const handleCreate = async () => {
    if (!org || !newKeyName.trim() || selectedScopes.length === 0) return;
    setCreating(true);
    try {
      const result = await api.createApiKey(org.id, newKeyName, selectedScopes);
      setCreatedKey(result.raw_key);
      setNewKeyName("");
      setSelectedScopes([]);
      setShowCreate(false);
      await loadKeys();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create API key";
      toast.error(message);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (keyId: string) => {
    if (!org) return;
    if (
      !(await confirm({
        title: "Revoke API key",
        description: "Are you sure you want to revoke this API key? This action cannot be undone.",
        confirmLabel: "Revoke",
        variant: "destructive",
      }))
    )
      return;
    try {
      await api.revokeApiKey(org.id, keyId);
      await loadKeys();
      toast.success("API key revoked");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to revoke API key";
      toast.error(message);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!org) {
    return (
      <SettingsCard title="API Keys">
        <EmptyState
          icon={Key}
          title="No organization selected"
          description="Select an organization above to manage its API keys."
          size="md"
        />
      </SettingsCard>
    );
  }

  const canManage = org.role === "owner" || org.role === "admin";

  const columns: DataTableColumn<ApiKey>[] = [
    { key: "name", header: "Name", sortable: true, sticky: true, cell: (k) => <span className="font-medium text-[var(--text-primary)]">{k.name}</span> },
    {
      key: "key_prefix",
      header: "Key",
      cell: (k) => <code className="text-sm text-[var(--text-muted)] font-mono">...{k.key_prefix}</code>,
    },
    {
      key: "scopes",
      header: "Scopes",
      cell: (k) => (
        <div className="flex flex-wrap gap-1">
          {k.scopes.map((scope) => (
            <span key={scope} className="px-2 py-0.5 bg-[var(--accent-bg)] text-[var(--accent)] rounded text-xs">
              {scope}
            </span>
          ))}
        </div>
      ),
    },
    {
      key: "created_at",
      header: "Created",
      sortable: true,
      cell: (k) => <span className="text-sm text-[var(--text-muted)]">{k.created_at ? new Date(k.created_at).toLocaleDateString() : "—"}</span>,
    },
    {
      key: "last_used_at",
      header: "Last Used",
      sortable: true,
      cell: (k) => <span className="text-sm text-[var(--text-muted)]">{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : "Never"}</span>,
    },
    {
      key: "id",
      header: "",
      align: "right",
      cell: (k) =>
        canManage ? (
          <button
            onClick={() => handleRevoke(k.id)}
            className="p-2 text-[var(--error)] hover:bg-[var(--error-bg)] rounded-lg"
            title="Revoke key"
            aria-label={`Revoke ${k.name}`}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      {canManage && (
        <SettingsCard
          title="API keys"
          description="Create a key to call the Eden API from CI or your own scripts."
        >
          {!showCreate && !createdKey && (
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:opacity-90"
            >
              <Plus className="w-4 h-4" />
              Create API Key
            </button>
          )}

          {showCreate && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Create new key</h3>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="Key name (e.g., CI/CD Pipeline)"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
              />
              <div>
                <p className="text-sm font-medium mb-2 text-[var(--text-primary)]">Permissions</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {ALL_SCOPES.map((scope) => (
                    <label
                      key={scope.id}
                      className="flex items-center gap-2 p-2 border border-[var(--border-default)] rounded-lg cursor-pointer hover:bg-[var(--bg-tertiary)]"
                    >
                      <input
                        type="checkbox"
                        checked={selectedScopes.includes(scope.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedScopes([...selectedScopes, scope.id]);
                          } else {
                            setSelectedScopes(selectedScopes.filter((s) => s !== scope.id));
                          }
                        }}
                        className="rounded"
                      />
                      <span className="text-sm text-[var(--text-primary)]">{scope.label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => {
                    setShowCreate(false);
                    setNewKeyName("");
                    setSelectedScopes([]);
                  }}
                  className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={creating || !newKeyName.trim() || selectedScopes.length === 0}
                  className="px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Create Key
                </button>
              </div>
            </div>
          )}

          {createdKey && (
            <div className="space-y-4">
              <div className="p-4 bg-[var(--success-bg)] border border-[var(--success)]/30 rounded-lg">
                <p className="text-sm font-medium text-[var(--success)] mb-2">API key created</p>
                <p className="text-xs text-[var(--success)]/80 mb-3">
                  Copy this key now. You will not be able to see it again.
                </p>
                <div className="flex items-center gap-2 p-2 bg-[var(--bg-primary)] border border-[var(--success)]/30 rounded">
                  <code className="flex-1 text-sm font-mono break-all text-[var(--text-primary)]">
                    {createdKey}
                  </code>
                  <button
                    onClick={() => copyToClipboard(createdKey)}
                    className="p-1.5 hover:bg-[var(--success-bg)] rounded"
                    title="Copy to clipboard"
                  >
                    {copied ? (
                      <Check className="w-4 h-4 text-[var(--success)]" />
                    ) : (
                      <Copy className="w-4 h-4 text-[var(--text-secondary)]" />
                    )}
                  </button>
                </div>
              </div>
              <button
                onClick={() => setCreatedKey(null)}
                className="text-sm text-[var(--accent)] hover:underline"
              >
                Done
              </button>
            </div>
          )}
        </SettingsCard>
      )}

      <SettingsCard title="Active keys" description={`${keys.length} on file`}>
        <DataTable
          columns={columns}
          rows={keys}
          rowKey={(k) => k.id}
          loading={loading}
          defaultSort={{ key: "name", direction: "asc" }}
          emptyTitle="No API keys yet"
          emptyDescription="Create a key to call the Eden API from CI or your own scripts."
          emptyIcon={Key}
          pageSize={25}
        />
      </SettingsCard>
      {ConfirmDialog}
    </div>
  );
}
