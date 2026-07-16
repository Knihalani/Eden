"use client";

/**
 * ApiKeysTab — create / list / revoke org API keys.
 * Default create path is optimized for SDK ingest (all scopes).
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
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import Link from "next/link";

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

/** Must match VALID_SCOPES in src/eden/api/routes/api_keys.py */
const ALL_SCOPES = [
  { id: "references:read", label: "Read References" },
  { id: "references:write", label: "Write References" },
  { id: "jobs:read", label: "Read Jobs" },
  { id: "jobs:write", label: "Submit Jobs" },
];

const SDK_DEFAULT_SCOPES = ALL_SCOPES.map((s) => s.id);

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
  const [newKeyName, setNewKeyName] = useState("SDK");
  const [selectedScopes, setSelectedScopes] = useState<string[]>(SDK_DEFAULT_SCOPES);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const loadKeys = () => keysQuery.refetch();

  const handleCreate = async () => {
    if (!org || !newKeyName.trim() || selectedScopes.length === 0) return;
    setCreating(true);
    try {
      const data: { raw_key?: string } = await api.createApiKey(
        org.id,
        newKeyName,
        selectedScopes,
      );
      setCreatedKey(data.raw_key ?? null);
      setNewKeyName("SDK");
      setSelectedScopes(SDK_DEFAULT_SCOPES);
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

  const copyText = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      toast.success(`Copied ${label}`);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error("Copy failed");
    }
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
    {
      key: "name",
      header: "Name",
      sortable: true,
      sticky: true,
      cell: (k) => (
        <span className="font-medium text-[var(--text-primary)]">{k.name}</span>
      ),
    },
    {
      key: "key_prefix",
      header: "Key",
      cell: (k) => (
        <code className="text-sm text-[var(--text-muted)] font-mono">
          …{k.key_prefix}
        </code>
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
          <span className="text-sm text-[var(--text-muted)]">
            {new Date(k.created_at).toLocaleDateString()}
          </span>
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
          <span className="text-sm text-[var(--text-muted)]">
            {new Date(k.last_used_at).toLocaleDateString()}
          </span>
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
      <SettingsCard>
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-[var(--accent-faint)] p-2">
              <Key className="h-4 w-4 text-[var(--accent)]" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                SDK credentials
              </h3>
              <p className="mt-1 text-sm text-[var(--text-secondary)] leading-relaxed">
                Create an API key here, or use{" "}
                <strong>Fill in</strong> on the{" "}
                <a
                  href={DOCS_QUICKSTART_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--accent)] hover:underline"
                >
                  docs quickstart
                </a>{" "}
                to inject a key into a ready-to-run snippet. Set{" "}
                <code className="text-xs">EDEN_API_KEY</code> and{" "}
                <code className="text-xs">EDEN_ORG_ID</code> — the SDK defaults to{" "}
                <code className="text-xs">api.edenobservability.com</code>.
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Organization ID
                </p>
                <code className="mt-0.5 block truncate text-sm font-mono text-[var(--text-primary)]">
                  {org.id}
                </code>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copyText("org id", org.id)}
                aria-label="Copy organization id"
              >
                {copied === "org id" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                Copy
              </Button>
            </div>
          </div>
        </div>
      </SettingsCard>

      {canManage && (
        <SettingsCard>
          {!showCreate && !createdKey && (
            <button
              onClick={() => {
                setShowCreate(true);
                setSelectedScopes(SDK_DEFAULT_SCOPES);
                setNewKeyName("SDK");
              }}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium hover:opacity-90"
            >
              <Plus className="w-4 h-4" />
              Create API key
            </button>
          )}

          {showCreate && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Create new API key
              </h3>
              <p className="text-xs text-[var(--text-muted)]">
                Defaults are ready for the SDK. The secret is shown once after create.
              </p>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="Key name (e.g., SDK, production)"
                aria-label="Key name"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
              />
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)] mb-2">
                  Permissions
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {ALL_SCOPES.map((scope) => (
                    <label
                      key={scope.id}
                      className="flex items-center gap-2 rounded-md border border-[var(--border-default)] px-3 py-2 text-sm cursor-pointer hover:bg-[var(--bg-tertiary)]"
                    >
                      <input
                        type="checkbox"
                        checked={selectedScopes.includes(scope.id)}
                        onChange={(e) => {
                          setSelectedScopes((prev) =>
                            e.target.checked
                              ? [...prev, scope.id]
                              : prev.filter((s) => s !== scope.id),
                          );
                        }}
                      />
                      {scope.label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => void handleCreate()}
                  disabled={creating || !newKeyName.trim() || selectedScopes.length === 0}
                >
                  {creating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  Create
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowCreate(false);
                    setSelectedScopes(SDK_DEFAULT_SCOPES);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {createdKey && (
            <div className="space-y-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/5 p-4">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                API key created — copy it now
              </h3>
              <p className="text-xs text-[var(--text-muted)]">
                This secret is shown once. Store it as{" "}
                <code className="font-mono">EDEN_API_KEY</code>.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-md bg-[var(--bg-secondary)] px-3 py-2 text-xs font-mono">
                  {createdKey}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void copyText("API key", createdKey)}
                  aria-label="Copy API key"
                >
                  {copied === "API key" ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setCreatedKey(null)}>
                Done
              </Button>
            </div>
          )}
        </SettingsCard>
      )}

      {!canManage && (
        <p className="text-sm text-[var(--text-muted)]">
          Only org owners and admins can create API keys. Ask an admin, or switch org.
        </p>
      )}

      <DataTable
        columns={columns}
        rows={keys}
        loading={loading}
        emptyTitle="No API keys yet"
        emptyDescription="Create an API key to authenticate the SDK and send traces."
        emptyAction={
          canManage ? (
            <Button
              onClick={() => {
                setShowCreate(true);
                setSelectedScopes(SDK_DEFAULT_SCOPES);
              }}
            >
              <Plus className="h-4 w-4" />
              Create API key
            </Button>
          ) : undefined
        }
        selectable={canManage}
        bulkActions={
          canManage
            ? [
                {
                  label: "Revoke",
                  variant: "destructive" as const,
                  onClick: async (rows: ApiKey[]) => {
                    if (
                      !(await confirm({
                        title: "Revoke API keys",
                        description: `Permanently revoke ${rows.length} API key${rows.length === 1 ? "" : "s"}? Any systems using ${rows.length === 1 ? "it" : "them"} will immediately lose access.`,
                        confirmLabel: "Revoke",
                        variant: "destructive",
                      }))
                    )
                      return;
                    await Promise.all(rows.map((k) => api.revokeApiKey(org.id, k.id)));
                    await loadKeys();
                    toast.success("API keys revoked");
                  },
                },
              ]
            : undefined
        }
      />
      {ConfirmDialog}
    </div>
  );
}
