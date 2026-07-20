"use client";

/**
 * ApiKeysTab — create / list / revoke org API keys.
 * Default create path is optimized for SDK ingest (all scopes).
 */

import { useState } from "react";
import Link from "next/link";
import { Check, Copy, ExternalLink, Key, Loader2, Plus, Trash2 } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { api } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { isAdminOrOwner } from "@/lib/roles";

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

/** Production API host — SDKs default here; no EDEN_BASE_URL needed. */
const API_HOST = "https://api.edenobservability.com";

/** Subset of VALID_SCOPES in src/eden/api/routes/api_keys.py shown in the UI. */
const ALL_SCOPES = [
  { id: "references:read", label: "Read References" },
  { id: "references:write", label: "Write References" },
  { id: "jobs:read", label: "Read Jobs" },
  { id: "jobs:write", label: "Submit Jobs" },
  { id: "ingest:write", label: "Ingest write" },
  { id: "gateway:write", label: "Gateway write" },
  { id: "mcp:read", label: "MCP read" },
  { id: "mcp:debug", label: "MCP debug" },
  { id: "mcp:fix", label: "MCP fix" },
  { id: "mcp:*", label: "MCP all" },
];

/** Defaults for first-run SDK / gateway — includes ingest so traces land. */
const SDK_DEFAULT_SCOPES = [
  "references:read",
  "references:write",
  "jobs:read",
  "jobs:write",
  "ingest:write",
  "gateway:write",
];
const MCP_DEFAULT_SCOPES = ["mcp:read", "mcp:debug", "mcp:fix"];

export function ApiKeysTab({ org }: ApiKeysTabProps) {
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const { refreshOrgs, orgSyncing, orgSyncTimedOut } = useOrg();
  const { role: resolvedRole } = usePermissions();
  const orgId = org?.id ?? null;
  const keysQuery = useOrgQuery(
    queryKeys.settings.apiKeys(orgId),
    orgId,
    () => api.listApiKeys(orgId!) as Promise<ApiKey[]>,
  );
  const keys = keysQuery.data ?? [];
  const loading = keysQuery.isLoading;
  const loadError = keysQuery.isError;
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState("SDK");
  const [selectedScopes, setSelectedScopes] = useState<string[]>(SDK_DEFAULT_SCOPES);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Prefer resolved role (Clerk org:admin → admin/owner fallback) over raw
  // Eden membership role, which can lag webhook sync for the org creator.
  const canManage =
    isAdminOrOwner(resolvedRole) || isAdminOrOwner(org?.role);

  const loadKeys = () => keysQuery.refetch();

  const openCreate = () => {
    setShowCreate(true);
    setSelectedScopes(SDK_DEFAULT_SCOPES);
    setNewKeyName("SDK");
  };

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
      toast.error("Copy failed — select the text and copy manually");
    }
  };

  if (!org) {
    return (
      <NoOrgState
        feature="API keys"
        icon={Key}
        syncing={orgSyncing && !orgSyncTimedOut}
        syncTimedOut={orgSyncTimedOut}
        onRetrySync={() => void refreshOrgs()}
        description={
          orgSyncTimedOut
            ? undefined
            : orgSyncing
              ? undefined
              : "Your workspace is not linked yet. Refresh after signup, or create an organization under Organization — the product tour does not sync your org."
        }
        secondaryAction={
          <Link
            href="/settings?tab=org"
            className="inline-flex min-h-11 items-center text-sm text-[var(--accent)] hover:underline"
          >
            Open Organization settings
          </Link>
        }
      />
    );
  }

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
            type="button"
            onClick={() => handleRevoke(k.id)}
            className="inline-flex min-h-11 min-w-11 items-center justify-center text-[var(--error)] hover:bg-[var(--error-dim)] rounded-lg"
            title="Revoke key"
            aria-label={`Revoke ${k.name}`}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-space-4">
      <SettingsCard>
        <div className="space-y-space-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              SDK credentials
            </h3>
            <p className="mt-1 text-sm text-[var(--text-secondary)] leading-relaxed">
              Set <code className="text-xs font-mono">EDEN_API_KEY</code> and{" "}
              <code className="text-xs font-mono">EDEN_ORG_ID</code>, then follow the{" "}
              <a
                href={DOCS_QUICKSTART_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--accent)] hover:underline"
              >
                docs quickstart
              </a>
              {" "}
              (use <span className="font-medium text-[var(--text-primary)]">Fill in</span> when
              signed in). SDKs default to{" "}
              <code className="text-xs font-mono">{API_HOST}</code>.
            </p>
          </div>

          <div className="rounded-lg bg-[var(--bg-secondary)] p-3 space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  EDEN_ORG_ID
                </p>
                <code className="mt-0.5 block truncate text-sm font-mono text-[var(--text-primary)]">
                  {org.id}
                </code>
              </div>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 shrink-0"
                onClick={() => void copyText("EDEN_ORG_ID", org.id)}
                aria-label="Copy EDEN_ORG_ID"
              >
                {copied === "EDEN_ORG_ID" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied === "EDEN_ORG_ID" ? "Copied" : "Copy"}
              </Button>
            </div>
            <div className="flex flex-col gap-2 border-t border-[var(--border-default)] pt-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Shell export
                </p>
                <code className="mt-0.5 block break-all text-xs font-mono text-[var(--text-primary)]">
                  export EDEN_ORG_ID=&quot;{org.id}&quot;
                </code>
              </div>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 shrink-0"
                onClick={() =>
                  void copyText("org export", `export EDEN_ORG_ID="${org.id}"`)
                }
                aria-label="Copy EDEN_ORG_ID export"
              >
                {copied === "org export" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied === "org export" ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>

          <a
            href={DOCS_QUICKSTART_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-1.5 text-sm text-[var(--accent)] hover:underline"
          >
            Open docs quickstart
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </SettingsCard>

      {canManage && (
        <SettingsCard>
          {!showCreate && !createdKey && (
            <Button type="button" className="min-h-11" onClick={openCreate}>
              <Plus className="w-4 h-4" />
              Create API key
            </Button>
          )}

          {showCreate && (
            <div className="space-y-space-4">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Create new API key
              </h3>
              <p className="text-xs text-[var(--text-muted)]">
                SDK presets include ingest. The secret is shown once after create — copy it
                immediately.
              </p>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="Key name (e.g., SDK, production)"
                aria-label="Key name"
                className="w-full min-h-11 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
              />
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)] mb-2">
                  Permissions
                </p>
                <div className="mb-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="min-h-11 px-2 text-sm text-[var(--accent)] hover:underline"
                    onClick={() => setSelectedScopes(SDK_DEFAULT_SCOPES)}
                  >
                    SDK presets
                  </button>
                  <button
                    type="button"
                    className="min-h-11 px-2 text-sm text-[var(--accent)] hover:underline"
                    onClick={() => {
                      setNewKeyName("MCP");
                      setSelectedScopes(MCP_DEFAULT_SCOPES);
                    }}
                  >
                    MCP presets
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {ALL_SCOPES.map((scope) => (
                    <label
                      key={scope.id}
                      className="flex min-h-11 items-center gap-2 rounded-md bg-[var(--bg-secondary)] px-3 py-2 text-sm cursor-pointer hover:bg-[var(--bg-tertiary)]"
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
              <div className="flex flex-wrap gap-2">
                <Button
                  className="min-h-11"
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
                  className="min-h-11"
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
            <div
              className="space-y-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/5 p-4"
              role="status"
              aria-live="polite"
            >
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Copy this secret now — shown once
              </h3>
              <p className="text-xs text-[var(--text-muted)]">
                Paste into your shell, or use{" "}
                <span className="font-medium text-[var(--text-primary)]">Fill in</span> on the{" "}
                <a
                  href={DOCS_QUICKSTART_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--accent)] hover:underline"
                >
                  docs quickstart
                </a>
                . Closing this panel hides the key permanently.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 break-all rounded-md bg-[var(--bg-secondary)] px-3 py-2 text-xs font-mono">
                  {createdKey}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 shrink-0"
                  onClick={() => void copyText("EDEN_API_KEY", createdKey)}
                  aria-label="Copy API key"
                >
                  {copied === "EDEN_API_KEY" ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied === "EDEN_API_KEY" ? "Copied" : "Copy key"}
                </Button>
              </div>
              <div className="rounded-md bg-[var(--bg-secondary)] p-3">
                <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                    Shell exports
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 shrink-0"
                    onClick={() =>
                      void copyText(
                        "env exports",
                        `export EDEN_API_KEY="${createdKey}"\nexport EDEN_ORG_ID="${org.id}"`,
                      )
                    }
                    aria-label="Copy EDEN_API_KEY and EDEN_ORG_ID exports"
                  >
                    {copied === "env exports" ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copied === "env exports" ? "Copied" : "Copy both"}
                  </Button>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs font-mono text-[var(--text-primary)]">{`export EDEN_API_KEY="${createdKey}"
export EDEN_ORG_ID="${org.id}"`}</pre>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => setCreatedKey(null)}
                >
                  Done
                </Button>
                <a
                  href={DOCS_QUICKSTART_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-3 text-sm text-[var(--accent)] hover:bg-[var(--bg-secondary)]"
                >
                  Docs quickstart
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>
          )}
        </SettingsCard>
      )}

      {!canManage && (
        <p className="text-sm text-[var(--text-muted)]">
          Only org owners and admins can create API keys. Ask an admin, or switch org.
        </p>
      )}

      {loadError ? (
        <ErrorState
          title="Could not load API keys"
          message={
            keysQuery.error instanceof Error
              ? keysQuery.error.message
              : "The API may be cold or unreachable. Retry in a moment."
          }
          action={
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => void loadKeys()}
            >
              Try again
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={keys}
          loading={loading}
          emptyTitle="No API keys yet"
          emptyDescription={
            canManage
              ? "Use Create API key above (SDK presets include ingest), then set EDEN_API_KEY + EDEN_ORG_ID."
              : "Ask an org admin to create a key, or switch to an org you admin."
          }
          emptyAction={
            canManage ? (
              <a
                href={DOCS_QUICKSTART_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-3 text-sm text-[var(--accent)] hover:bg-[var(--bg-secondary)]"
              >
                Docs Fill-in
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
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
      )}
      {ConfirmDialog}
    </div>
  );
}
