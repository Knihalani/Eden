"use client";

/**
 * ApiKeysTab — extracted from settings/page.tsx (June 2026 Phase 5).
 * Create / list / revoke org API keys with the one-time key display
 * + scope selection.
 */

import { useEffect, useState } from "react";
import { Check, Copy, Key, Loader2, Plus, Trash2 } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { api } from "@/lib/api";
import { SettingsCard } from "@/components/settings/settings-card";

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
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadKeys = async () => {
    if (!org) return;
    setLoading(true);
    try {
      const data = await api.listApiKeys(org.id);
      setKeys(data as ApiKey[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  const handleCreate = async () => {
    if (!org || !newKeyName.trim() || selectedScopes.length === 0) return;
    setCreating(true);
    try {
      const data = await api.createApiKey(org.id, newKeyName, selectedScopes);
      setCreatedKey((data as { key?: string }).key ?? null);
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

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
        </div>
      ) : keys.length === 0 ? (
        <div className="text-center py-12 text-[var(--text-secondary)]">
          <Key className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No API keys yet</p>
          <p className="text-sm">Create an API key for programmatic access</p>
        </div>
      ) : (
        <SettingsCard contentClassName="p-0">
          <table className="w-full">
            <thead className="bg-[var(--bg-tertiary)]">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)] sticky left-0 bg-[var(--bg-tertiary)]">
                  Name
                </th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Key</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Scopes</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Created</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Last Used</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr
                  key={key.id}
                  className="border-t border-[var(--border-default)] hover:bg-[var(--bg-tertiary)]/30"
                >
                  <td className="px-4 py-3 font-medium text-[var(--text-primary)] sticky left-0 bg-[var(--bg-primary)]">
                    {key.name}
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-sm text-[var(--text-muted)] font-mono">
                      ...{key.key_prefix}
                    </code>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {key.scopes.map((scope) => (
                        <span
                          key={scope}
                          className="px-2 py-0.5 bg-[var(--accent-faint)] text-[var(--accent)] rounded text-xs"
                        >
                          {scope}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-muted)]">
                    {key.created_at ? new Date(key.created_at).toLocaleDateString() : "-"}
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-muted)]">
                    {key.last_used_at ? new Date(key.last_used_at).toLocaleDateString() : "Never"}
                  </td>
                  <td className="px-4 py-3">
                    {(org.role === "owner" || org.role === "admin") && (
                      <button
                        onClick={() => handleRevoke(key.id)}
                        className="p-2 text-[var(--error)] hover:bg-[var(--error-dim)] rounded-lg"
                        title="Revoke key"
                        aria-label={`Revoke ${key.name}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SettingsCard>
      )}
      {ConfirmDialog}
    </div>
  );
}
