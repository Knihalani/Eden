"use client";

import { useState, useEffect } from "react";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { Loader2, Shield, RefreshCw, Copy, Check, Key, AlertTriangle, Users } from "lucide-react";
import { cn } from "@/lib/utils";

interface ScimConfig {
  scim_enabled: boolean;
  last_sync_at: string | null;
  provisioned_user_count: number;
  has_token: boolean;
}

export function ScimTab({ org }: { org: any }) {
  const { hasPermission } = usePermissions();
  const [config, setConfig] = useState<ScimConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const canManageScim = hasPermission("settings:edit");
  const currentOrg = org;

  useEffect(() => {
    if (!currentOrg) {
      setLoading(false);
      return;
    }

    async function fetchConfig() {
      setLoading(true);
      setError(null);
      try {
        const data = await api.getScimConfig(currentOrg.id);
        setConfig(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load SCIM configuration");
      } finally {
        setLoading(false);
      }
    }

    fetchConfig();
  }, [currentOrg]);

  const handleToggle = async (enabled: boolean) => {
    if (!currentOrg) return;
    setSaving(true);
    setError(null);
    setNewToken(null);
    try {
      const result = await api.configureScim(currentOrg.id, enabled);
      setConfig({
        ...config!,
        scim_enabled: result.scim_enabled,
        has_token: !!result.bearer_token,
      });
      if (result.bearer_token) {
        setNewToken(result.bearer_token);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to configure SCIM");
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
      setConfig({
        ...config!,
        scim_enabled: true,
        has_token: true,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rotate token");
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
      <div className="p-6 bg-red-50 rounded-lg border border-red-200">
        <p className="text-sm text-red-700">
          You do not have permission to manage SCIM settings. Contact your organization admin.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
        <span className="ml-2 text-gray-500">Loading SCIM configuration...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-blue-100 rounded-lg">
          <Key className="w-5 h-5 text-blue-600" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">SCIM Provisioning</h2>
          <p className="text-sm text-gray-500">
            Automated user provisioning via your Identity Provider
          </p>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="p-4 bg-red-50 rounded-lg border border-red-200">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* New Token Display */}
      {newToken && (
        <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-green-800">SCIM Token Created</p>
              <p className="text-xs text-green-600 mt-1 mb-3">
                Copy this token now. You will not be able to see it again.
              </p>
              <div className="flex items-center gap-2 p-2 bg-white border border-green-200 rounded">
                <code className="flex-1 text-sm font-mono break-all">{newToken}</code>
                <button
                  onClick={() => copyToClipboard(newToken)}
                  className="p-1.5 hover:bg-green-100 rounded"
                  title="Copy to clipboard"
                >
                  {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SCIM Status Card */}
      <div className="p-4 bg-white rounded-lg border border-gray-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={cn(
              "p-2 rounded-lg",
              config?.scim_enabled ? "bg-green-100" : "bg-gray-100"
            )}>
              <Shield className={cn(
                "w-5 h-5",
                config?.scim_enabled ? "text-green-600" : "text-gray-500"
              )} />
            </div>
            <div>
              <p className="font-medium">SCIM Provisioning</p>
              <p className="text-sm text-gray-500">
                {config?.scim_enabled ? "Enabled - users can be provisioned via SCIM" : "Disabled"}
              </p>
            </div>
          </div>
          <button
            onClick={() => handleToggle(!config?.scim_enabled)}
            disabled={saving}
            className={cn(
              "relative w-12 h-6 rounded-full transition-colors",
              config?.scim_enabled ? "bg-blue-600" : "bg-gray-300"
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform",
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
            <div className="p-4 bg-white rounded-lg border border-gray-200">
              <div className="flex items-center gap-2 mb-2">
                <Users className="w-4 h-4 text-gray-500" />
                <span className="text-sm text-gray-500">Provisioned Users</span>
              </div>
              <p className="text-2xl font-semibold">{config.provisioned_user_count}</p>
            </div>
            <div className="p-4 bg-white rounded-lg border border-gray-200">
              <div className="flex items-center gap-2 mb-2">
                <RefreshCw className="w-4 h-4 text-gray-500" />
                <span className="text-sm text-gray-500">Last Sync</span>
              </div>
              <p className="text-lg font-semibold">{formatLastSync(config.last_sync_at)}</p>
            </div>
          </div>

          {/* Token Actions */}
          <div className="p-4 bg-white rounded-lg border border-gray-200">
            <h3 className="font-medium mb-3">Bearer Token</h3>
            <p className="text-sm text-gray-500 mb-4">
              Use this token to authenticate SCIM requests from your Identity Provider.
              The endpoint base is: <code className="bg-gray-100 px-1 rounded">/orgs/{currentOrg?.id}/scim/v2</code>
            </p>
            <button
              onClick={handleRotateToken}
              disabled={saving}
              className="px-4 py-2 bg-yellow-100 text-yellow-700 rounded-lg text-sm font-medium hover:bg-yellow-200 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              Rotate Token
            </button>
          </div>

          {/* SCIM Endpoint Info */}
          <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
            <h3 className="text-sm font-medium text-blue-800 mb-2">SCIM 2.0 Endpoints</h3>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <code className="bg-blue-100 px-2 py-0.5 rounded text-xs">GET</code>
                <code className="text-blue-700">/orgs/{currentOrg?.id}/scim/v2/Users</code>
                <span className="text-blue-600">- List users</span>
              </div>
              <div className="flex items-center gap-2">
                <code className="bg-blue-100 px-2 py-0.5 rounded text-xs">POST</code>
                <code className="text-blue-700">/orgs/{currentOrg?.id}/scim/v2/Users</code>
                <span className="text-blue-600">- Create user</span>
              </div>
              <div className="flex items-center gap-2">
                <code className="bg-blue-100 px-2 py-0.5 rounded text-xs">GET</code>
                <code className="text-blue-700">/orgs/{currentOrg?.id}/scim/v2/Users/{{id}}</code>
                <span className="text-blue-600">- Get user</span>
              </div>
              <div className="flex items-center gap-2">
                <code className="bg-blue-100 px-2 py-0.5 rounded text-xs">PUT</code>
                <code className="text-blue-700">/orgs/{currentOrg?.id}/scim/v2/Users/{{id}}</code>
                <span className="text-blue-600">- Update user</span>
              </div>
              <div className="flex items-center gap-2">
                <code className="bg-blue-100 px-2 py-0.5 rounded text-xs">DELETE</code>
                <code className="text-blue-700">/orgs/{currentOrg?.id}/scim/v2/Users/{{id}}</code>
                <span className="text-blue-600">- De-provision user</span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Info Box */}
      <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
        <p className="text-sm text-gray-700">
          <strong>How it works:</strong> SCIM 2.0 allows your Identity Provider (Okta, Azure AD, etc.)
          to automatically provision and de-provision user accounts. When a user is de-provisioned
          via SCIM, their organization membership is suspended (not deleted) to preserve data.
        </p>
      </div>
    </div>
  );
}