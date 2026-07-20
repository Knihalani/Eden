"use client";

import { useState } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { Loader2, Shield, RefreshCw, Copy, Check, Key, AlertTriangle, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { errorFromCaught } from "@/lib/safe-error-message";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";

interface ScimConfig {
  scim_enabled: boolean;
  last_sync_at: string | null;
  provisioned_user_count: number;
  has_token: boolean;
}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ScimTab({ org }: { org: any }) {
  const { hasPermission } = usePermissions();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const canManageScim = hasPermission("settings:edit");
  const currentOrg = org;
  const orgId = currentOrg?.id ?? null;
  const configQuery = useOrgQuery(
    queryKeys.scim.config(orgId),
    orgId,
    () => api.getScimConfig(orgId!),
  );
  const config = configQuery.data ?? null;
  const loading = configQuery.isLoading;
  const queryError = configQuery.error
    ? errorFromCaught(configQuery.error, "Failed to load SCIM configuration")
    : null;

  const handleToggle = async (enabled: boolean) => {
    if (!currentOrg) return;
    setSaving(true);
    setError(null);
    setNewToken(null);
    try {
      const result = await api.configureScim(currentOrg.id, enabled);
      await configQuery.refetch();
      if (result.bearer_token) {
        setNewToken(result.bearer_token);
      }
    } catch (e) {
      setError(errorFromCaught(e, "Failed to configure SCIM"));
    } finally {
      setSaving(false);
    }
  };

  const handleRotateToken = async () => {
    if (!currentOrg) return;
    setSaving(true);
    setError(null);
    setNewToken(null);
    try {
      const result = await api.rotateScimToken(currentOrg.id);
      setNewToken(result.bearer_token);
      await configQuery.refetch();
    } catch (e) {
      setError(errorFromCaught(e, "Failed to rotate token"));
    } finally {
      setSaving(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatLastSync = (dateStr: string | null) => {
    if (!dateStr) return "Never";
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
    return date.toLocaleDateString();
  };

  if (!canManageScim) {
    return (
      <div className="p-6 bg-[var(--error-dim)] rounded-lg border border-[var(--error)]">
        <p className="text-sm text-[var(--error)]">
          You do not have permission to manage SCIM settings. Contact your organization admin.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
        <span className="ml-2 text-[var(--text-muted)]">Loading SCIM configuration...</span>
      </div>
    );
  }

  // Load failure with no config — do not paint a false "Disabled" toggle.
  if (queryError && !config) {
    return (
      <ErrorState
        title="Could not load SCIM configuration"
        message={queryError}
        action={
          <Button
            type="button"
            variant="outline"
            size="default"
            onClick={() => void configQuery.refetch()}
          >
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-space-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-[var(--accent-faint)] rounded-lg">
          <Key className="w-5 h-5 text-[var(--accent)]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">SCIM Provisioning</h2>
          <p className="text-sm text-[var(--text-muted)]">
            Automated user provisioning via your Identity Provider
          </p>
        </div>
      </div>

      {/* Mutation / rotate errors (load errors are gated above) */}
      {error && (
        <ErrorState
          title="SCIM action failed"
          message={error}
          size="sm"
        />
      )}

      {/* New Token Display */}
      {newToken && (
        <div className="p-4 bg-[var(--terminal-faint)] border border-[var(--terminal)] rounded-lg">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[var(--terminal)] flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-[var(--terminal)]">SCIM Token Created</p>
              <p className="text-xs text-[var(--terminal)] mt-1 mb-3">
                Copy this token now. You will not be able to see it again.
              </p>
              <div className="flex items-center gap-2 p-2 bg-[var(--bg-primary)] border border-[var(--terminal)] rounded">
                <code className="flex-1 text-sm font-mono break-all">{newToken}</code>
                <button
                  onClick={() => copyToClipboard(newToken)}
                  className="p-1.5 hover:bg-[var(--terminal-faint)] rounded"
                  title="Copy to clipboard"
                >
                  {copied ? <Check className="w-4 h-4 text-[var(--terminal)]" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SCIM Status Card */}
      <div className="p-4 bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={cn(
              "p-2 rounded-lg",
              config?.scim_enabled ? "bg-[var(--terminal-faint)]" : "bg-[var(--bg-tertiary)]"
            )}>
              <Shield className={cn(
                "w-5 h-5",
                config?.scim_enabled ? "text-[var(--terminal)]" : "text-[var(--text-muted)]"
              )} />
            </div>
            <div>
              <p className="font-medium">SCIM Provisioning</p>
              <p className="text-sm text-[var(--text-muted)]">
                {config?.scim_enabled ? "Enabled - users can be provisioned via SCIM" : "Disabled"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => handleToggle(!config?.scim_enabled)}
            disabled={saving}
            aria-label={config?.scim_enabled ? "Disable SCIM provisioning" : "Enable SCIM provisioning"}
            aria-pressed={Boolean(config?.scim_enabled)}
            className={cn(
              "relative w-12 h-6 rounded-full transition-colors",
              config?.scim_enabled ? "bg-[var(--accent)]" : "bg-[var(--border-default)]"
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 left-0.5 w-5 h-5 bg-[var(--bg-primary)] rounded-full transition-transform",
                config?.scim_enabled && "translate-x-6"
              )}
            />
          </button>
        </div>
      </div>

      {/* SCIM Enabled - Show Details */}
      {config?.scim_enabled && (
        <>
          {/* Sync Stats */}
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)]">
              <div className="flex items-center gap-2 mb-2">
                <Users className="w-4 h-4 text-[var(--text-muted)]" />
                <span className="text-sm text-[var(--text-muted)]">Provisioned Users</span>
              </div>
              <p className="text-2xl font-semibold">{config.provisioned_user_count}</p>
            </div>
            <div className="p-4 bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)]">
              <div className="flex items-center gap-2 mb-2">
                <RefreshCw className="w-4 h-4 text-[var(--text-muted)]" />
                <span className="text-sm text-[var(--text-muted)]">Last Sync</span>
              </div>
              <p className="text-lg font-semibold">{formatLastSync(config.last_sync_at)}</p>
            </div>
          </div>

          {/* Token Actions */}
          <div className="p-4 bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)]">
            <h3 className="font-medium mb-3">Bearer Token</h3>
            <p className="text-sm text-[var(--text-muted)] mb-4">
              Use this token to authenticate SCIM requests from your Identity Provider.
              The endpoint base is: <code className="bg-[var(--bg-tertiary)] px-1 rounded">/orgs/{currentOrg?.id}/scim/v2</code>
            </p>
            <button
              onClick={handleRotateToken}
              disabled={saving}
              className="px-4 py-2 bg-[var(--warning-bg)] text-[var(--warning)] rounded-lg text-sm font-medium hover:bg-[var(--warning-bg)] transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              Rotate Token
            </button>
          </div>

          {/* SCIM Endpoint Info */}
          <div className="p-4 bg-[var(--accent-faint)] rounded-lg border border-[var(--accent)]">
            <h3 className="text-sm font-medium text-[var(--accent)] mb-2">SCIM 2.0 Endpoints</h3>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <code className="bg-[var(--accent-faint)] px-2 py-0.5 rounded text-xs">GET</code>
                <code className="text-[var(--accent)]">/orgs/{currentOrg?.id}/scim/v2/Users</code>
                <span className="text-[var(--accent)]">- List users</span>
              </div>
              <div className="flex items-center gap-2">
                <code className="bg-[var(--accent-faint)] px-2 py-0.5 rounded text-xs">POST</code>
                <code className="text-[var(--accent)]">/orgs/{currentOrg?.id}/scim/v2/Users</code>
                <span className="text-[var(--accent)]">- Create user</span>
              </div>
              <div className="flex items-center gap-2">
                <code className="bg-[var(--accent-faint)] px-2 py-0.5 rounded text-xs">GET</code>
                <code className="text-[var(--accent)]">/orgs/{currentOrg?.id}/scim/v2/Users/{"{{id}}"}</code>
                <span className="text-[var(--accent)]">- Get user</span>
              </div>
              <div className="flex items-center gap-2">
                <code className="bg-[var(--accent-faint)] px-2 py-0.5 rounded text-xs">PUT</code>
                <code className="text-[var(--accent)]">/orgs/{currentOrg?.id}/scim/v2/Users/{"{{id}}"}</code>
                <span className="text-[var(--accent)]">- Update user</span>
              </div>
              <div className="flex items-center gap-2">
                <code className="bg-[var(--accent-faint)] px-2 py-0.5 rounded text-xs">DELETE</code>
                <code className="text-[var(--accent)]">/orgs/{currentOrg?.id}/scim/v2/Users/{"{{id}}"}</code>
                <span className="text-[var(--accent)]">- De-provision user</span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Info Box */}
      <div className="p-4 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border-default)]">
        <p className="text-sm text-[var(--text-secondary)]">
          <strong>How it works:</strong> SCIM 2.0 allows your Identity Provider (Okta, Azure AD, etc.)
          to automatically provision and de-provision user accounts. When a user is de-provisioned
          via SCIM, their organization membership is suspended (not deleted) to preserve data.
        </p>
      </div>
    </div>
  );
}