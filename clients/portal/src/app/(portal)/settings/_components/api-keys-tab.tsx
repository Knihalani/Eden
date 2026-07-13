"use client";

/**
 * ApiKeysTab — extracted from settings/page.tsx (June 2026 Phase 5).
 * Create / list / revoke org API keys with the one-time key display
 * + scope selection.
 */

import { useState } from "react";
import { Check, Copy, Key, Loader2, Plus, Trash2 } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { api } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";

interface ApiKeysTabProps {
  org: { id: string; name: string; role: string } | null;
}

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_at?: string;
  last_used_at?: string;
}

const ALL_SCOPES = [
  { id: "references:read", label: "Read References" },
  { id: "references:write", label: "Write References" },
  { id: "jobs:read", label: "Read Jobs" },
  { id: "jobs:write", label: "Submit Jobs" },
];

export function ApiKeysTab({ org }: ApiKeysTabProps) {
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const orgId = org?.id ?? null;
  const keysQuery = useOrgQuery(
    queryKeys.settings.apiKeys(orgId),
    orgId,
    () => api.listApiKeys(orgId!) as Promise<ApiKey[]>,
  );
  const keys = keysQuery.data ?? [];
  const loading = keysQuery.isLoading;
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadKeys = () => keysQuery.refetch();

  const handleCreate = async () => {
    if (!org || !newKeyName.trim() || selectedScopes.length === 0) return;
    setCreating(true);
    try {
      // PT-11: the backend's createApiKey returns ``raw_key`` (not
      // ``key``) so the secret is one-time-readable only on creation.
      // Pre-fix the tab read ``data.key`` and silently copied an
      // empty string.
      const data: { raw_key?: string } = await api.createApiKey(
        org.id,
        newKeyName,
        selectedScopes,
      );
      // data.raw_key is the one-time-secret the user needs to copy.
      setCreatedKey(data.raw_key ?? null);
      setNewKeyName("");
      setSelectedScopes([]);
      setShowCreate(false);
      await loadKeys();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to create API key");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (keyId: string) => {
    if (!org) return;
    if (
      !(await confirm({
        title: "Revoke API key",
        description: "Any systems using this key will immediately lose access. This cannot be undone.",
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
      toast.error(err instanceof Error ? err.message : "Failed to revoke API key");
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!org) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to manage API keys
      </div>
    );
  }

  const canManage = org.role === "owner" || org.role === "admin";

  const columns: DataTableColumn<ApiKey>[] = [
    { key: "name", header: "Name", sortable: true, sticky: true, cell: (k) => <span className="font-medium text-[var(--text-primary)]">{k.name}</span> },
    {
      key: "key_prefix",
      header: "Key",
      cell: (k) => (
        <code className="text-sm text-[var(--text-muted)] font-mono">...{k.key_prefix}</code>
      ),
    },
    {
      key: "scopes",
      header: "Scopes",
      cell: (k) => (
        <div className="flex flex-wrap gap-1">
          {k.scopes.map((scope) => (
            <span
              key={scope}
              className="px-2 py-0.5 bg-[var(--accent-faint)] text-[var(--accent)] rounded text-xs"
            >
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
      cell: (k) =>
        k.created_at ? (
          <span className="text-sm text-[var(--text-muted)]">{new Date(k.created_at).toLocaleDateString()}</span>
        ) : (
          <span className="text-sm text-[var(--text-muted)]">-</span>
        ),
    },
    {
      key: "last_used_at",
      header: "Last Used",
      sortable: true,
      cell: (k) =>
        k.last_used_at ? (
          <span className="text-sm text-[var(--text-muted)]">{new Date(k.last_used_at).toLocaleDateString()}</span>
        ) : (
          <span className="text-sm text-[var(--text-muted)]">Never</span>
        ),
    },
    {
      key: "id",
      header: "",
      align: "right",
      cell: (k) =>
        canManage ? (
          <button
            onClick={() => handleRevoke(k.id)}
            className="p-2 text-[var(--error)] hover:bg-[var(--error-dim)] rounded-lg"
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
      {(org.role === "owner" || org.role === "admin") && (
        <SettingsCard>
          {!showCreate && !createdKey && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium hover:opacity-90"
            >
              <Plus className="w-4 h-4" />
              Create API Key
            </button>
          )}

          {showCreate && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Create new API key
              </h3>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="Key name (e.g., CI/CD Pipeline)"
                aria-label="Key name"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
              />
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)] mb-2">Permissions</p>
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
                  className="px-4 py-2 text-sm text-[var(--text-muted)]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={creating || !newKeyName.trim() || selectedScopes.length === 0}
                  className="px-4 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Create Key
                </button>
              </div>
            </div>
          )}

          {createdKey && (
            <div className="space-y-4">
              <div className="p-4 bg-[var(--terminal-faint)] border border-[var(--terminal)] rounded-lg">
                <p className="text-sm font-medium text-[var(--terminal)] mb-2">
                  API key created
                </p>
                <p className="text-xs text-[var(--terminal)] mb-3">
                  Copy this key now. You will not be able to see it again.
                </p>
                <div className="flex items-center gap-2 p-2 bg-[var(--bg-primary)] border border-[var(--terminal)] rounded">
                  <code className="flex-1 text-sm font-mono break-all text-[var(--text-primary)]">
                    {createdKey}
                  </code>
                  <button
                    onClick={() => copyToClipboard(createdKey)}
                    className="p-1.5 hover:bg-[var(--terminal-faint)] rounded text-[var(--text-muted)]"
                    title="Copy to clipboard"
                    aria-label="Copy API key"
                  >
                    {copied ? <Check className="w-4 h-4 text-[var(--terminal)]" /> : <Copy className="w-4 h-4" />}
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

      <SettingsCard contentClassName="p-0">
        <DataTable
          columns={columns}
          rows={keys}
          rowKey={(k) => k.id}
          loading={loading}
          defaultSort={{ key: "name", direction: "asc" }}
          emptyTitle="No API keys yet"
          emptyDescription="Create an API key to authenticate programmatic access to Eden."
          emptyIcon={Key}
          emptyAction={
            canManage ? (
              <Button onClick={() => setShowCreate(true)}>
                <Plus className="w-4 h-4" />
                Create API key
              </Button>
            ) : undefined
          }
          selectable={canManage}
          bulkActions={
            canManage
              ? [
                  {
                    label: "Revoke selected",
                    variant: "destructive",
                    onClick: async (rows) => {
                      if (!org) return;
                      if (
                        !(await confirm({
                          title: "Revoke API keys",
                          description: `Permanently revoke ${rows.length} API key${rows.length === 1 ? "" : "s"}? Any systems using ${rows.length === 1 ? "it" : "them"} will immediately lose access.`,
                          confirmLabel: "Revoke",
                          variant: "destructive",
                        }))
                      )
                        return;
                      try {
                        await Promise.all(rows.map((k) => api.revokeApiKey(org.id, k.id)));
                        await loadKeys();
                        toast.success(`Revoked ${rows.length} key${rows.length === 1 ? "" : "s"}`);
                      } catch (err: unknown) {
                        toast.error(err instanceof Error ? err.message : "Failed to revoke keys");
                      }
                    },
                  },
                ]
              : undefined
          }
          pageSize={25}
        />
      </SettingsCard>
      {ConfirmDialog}
    </div>
  );
}
