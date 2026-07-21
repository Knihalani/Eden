"use client";

/**
 * ApiKeysTab — create / list / revoke workspace API keys (Wave 5).
 * Default create path is optimized for SDK ingest (all scopes).
 * Reveal-once secret lives in ApiKeysCreatePanel.
 */

import { useState } from "react";
import { ExternalLink, Key, Trash2 } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { api } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { isAdminOrOwner } from "@/lib/roles";
import { ApiKeysCreatePanel } from "./api-keys-create-panel";
import { ApiKeysSdkCredentials } from "./api-keys-sdk-credentials";
import {
  type ApiKeyRow,
  SDK_DEFAULT_SCOPES,
} from "./api-keys-scopes";

export const WS5_KEYS_COMPLETED = true as const;

interface ApiKeysTabProps {
  org: { id: string; name: string; role: string } | null;
}

export function ApiKeysTab({ org }: ApiKeysTabProps) {
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const { refreshOrgs, orgSyncing, orgSyncTimedOut } = useOrg();
  const { role: resolvedRole } = usePermissions();
  const orgId = org?.id ?? null;
  const keysQuery = useOrgQuery(
    queryKeys.settings.apiKeys(orgId),
    orgId,
    () => api.listApiKeys(orgId!) as Promise<ApiKeyRow[]>,
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
              : "Your workspace is not linked yet. Refresh after signup, or create a workspace in Settings — the product tour does not sync your workspace."
        }
      />
    );
  }

  const columns: DataTableColumn<ApiKeyRow>[] = [
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
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => handleRevoke(k.id)}
            className="text-[var(--error)] hover:bg-[var(--error-dim)]"
            title="Revoke key"
            aria-label={`Revoke ${k.name}`}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-space-4" data-ws5-keys>
      {canManage && (
        <ApiKeysCreatePanel
          orgId={org.id}
          showCreate={showCreate}
          creating={creating}
          newKeyName={newKeyName}
          selectedScopes={selectedScopes}
          createdKey={createdKey}
          copied={copied}
          onOpenCreate={openCreate}
          onNameChange={setNewKeyName}
          onScopesChange={setSelectedScopes}
          onCreate={() => void handleCreate()}
          onCancelCreate={() => {
            setShowCreate(false);
            setSelectedScopes(SDK_DEFAULT_SCOPES);
          }}
          onDismissSecret={() => setCreatedKey(null)}
          onCopy={(label, text) => void copyText(label, text)}
        />
      )}

      <ApiKeysSdkCredentials
        orgId={org.id}
        copied={copied}
        onCopy={(label, text) => void copyText(label, text)}
      />

      {!canManage && (
        <p className="text-sm text-[var(--text-muted)]">
          Only workspace owners and admins can create API keys. Ask an admin, or switch workspace.
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
              : "Ask a workspace admin to create a key, or switch to a workspace you admin."
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
                    onClick: async (rows: ApiKeyRow[]) => {
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
