"use client";

import { useEffect, useState } from "react";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { errorFromCaught } from "@/lib/safe-error-message";

interface SSOProvider {
  id: string;
  org_id: string;
  provider_type: string;
  name: string;
  enabled: boolean;
  default_for_domain: string | null;
  enforce_sso: boolean;
  scim_enabled: boolean;
  created_at: string;
}

interface SSOTabProps {
  orgId: string;
}

export function SSOTab({ orgId }: SSOTabProps) {
  const { hasPermission } = usePermissions();
  const [providers, setProviders] = useState<SSOProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    provider_type: "oidc",
    name: "",
    entity_id: "",
    sso_url: "",
    client_id: "",
    client_secret: "",
  });

  const canManage = hasPermission("settings:edit");
  const ssoCallbackAvailable = false;

  const fetchProviders = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listSSOProviders(orgId);
      setProviders(data as SSOProvider[]);
    } catch (err) {
      setError(errorFromCaught(err, "Failed to fetch SSO providers"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchProviders();
  }, [orgId]);

  const handleEnable = async (providerId: string, enabled: boolean) => {
    try {
      if (enabled) {
        await api.enableSSOProvider(orgId, providerId);
      } else {
        await api.disableSSOProvider(orgId, providerId);
      }
      await fetchProviders();
    } catch (err) {
      setError(errorFromCaught(err, `Failed to ${enabled ? "enable" : "disable"} provider`));
    }
  };

  const handleEnforce = async (_providerId: string, _enforce: boolean) => {
    setError("SSO enforcement is unavailable until the callback endpoint is configured.");
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createSSOProvider(orgId, {
        provider_type: formData.provider_type,
        name: formData.name,
        entity_id: formData.entity_id,
        sso_url: formData.sso_url,
        client_id: formData.client_id,
        client_secret: formData.client_secret,
      });
      setShowForm(false);
      setFormData({
        provider_type: "oidc",
        name: "",
        entity_id: "",
        sso_url: "",
        client_id: "",
        client_secret: "",
      });
      await fetchProviders();
    } catch (err) {
      setError(errorFromCaught(err, "Failed to create SSO provider"));
    }
  };

  return (
    <div className="space-y-6">
      {!ssoCallbackAvailable && (
        <div
          role="status"
          className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-4 py-3 text-sm text-[var(--text-secondary)]"
        >
          SSO callback is not available in this environment. You can review provider
          settings, but token exchange and enforce-SSO are disabled.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-[var(--error)]/30 bg-[var(--error-dim)] px-4 py-3 text-sm text-[var(--error)]">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">SSO Providers</h3>
          <p className="text-sm text-[var(--text-muted)]">
            Configure OIDC/SAML providers for your organization
          </p>
        </div>
        {canManage && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-4 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium hover:opacity-90"
          >
            {showForm ? "Cancel" : "Add Provider"}
          </button>
        )}
      </div>

      {showForm && canManage && (
        <form onSubmit={handleCreate} className="space-y-4 p-4 border border-[var(--border-default)] rounded-lg">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Provider Type</label>
              <select
                value={formData.provider_type}
                onChange={(e) => setFormData({ ...formData, provider_type: e.target.value })}
                className="w-full px-3 py-2 border border-[var(--border-default)] rounded-lg bg-[var(--bg-primary)]"
              >
                <option value="oidc">OIDC</option>
                <option value="saml">SAML</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full px-3 py-2 border border-[var(--border-default)] rounded-lg bg-[var(--bg-primary)]"
                required
              />
            </div>
          </div>
          <button type="submit" className="px-4 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm">
            Create Provider
          </button>
        </form>
      )}

      {loading ? (
        <div className="space-y-3" aria-busy="true" aria-live="polite">
          <div className="h-16 rounded-lg bg-[var(--bg-tertiary)] animate-pulse" />
          <div className="h-16 rounded-lg bg-[var(--bg-tertiary)] animate-pulse" />
        </div>
      ) : providers.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No SSO providers configured.</p>
      ) : (
        <div className="space-y-3">
          {providers.map((provider) => (
            <div
              key={provider.id}
              className="p-4 border border-[var(--border-default)] rounded-lg flex items-center justify-between gap-4"
            >
              <div>
                <p className="font-medium text-[var(--text-primary)]">{provider.name}</p>
                <p className="text-xs text-[var(--text-muted)]">{provider.provider_type.toUpperCase()}</p>
              </div>
              <div className="flex items-center gap-2">
                {canManage && (
                  <>
                    <button
                      onClick={() => void handleEnable(provider.id, !provider.enabled)}
                      className="text-xs px-2 py-1 rounded border border-[var(--border-default)]"
                    >
                      {provider.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      disabled={!ssoCallbackAvailable}
                      title={ssoCallbackAvailable ? undefined : "Callback not available"}
                      onClick={() => void handleEnforce(provider.id, !provider.enforce_sso)}
                      className="text-xs px-2 py-1 rounded border border-[var(--border-default)] disabled:opacity-40"
                    >
                      {provider.enforce_sso ? "Relax SSO" : "Enforce SSO"}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
