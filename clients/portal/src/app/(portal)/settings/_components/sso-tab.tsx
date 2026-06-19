"use client";

import { useState } from "react";
import { usePermissions } from "@/hooks/use-permissions";

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

  const fetchProviders = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sso/providers?org_id=${orgId}`);
      if (!res.ok) throw new Error("Failed to fetch SSO providers");
      const data = await res.json();
      setProviders(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const handleEnable = async (providerId: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/sso/providers/${providerId}/${enabled ? "enable" : "disable"}?org_id=${orgId}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`Failed to ${enabled ? "enable" : "disable"} provider`);
      await fetchProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const handleEnforce = async (providerId: string, enforce: boolean) => {
    try {
      const res = await fetch(`/api/sso/providers/${providerId}/enforce?org_id=${orgId}&enforce=${enforce}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to update SSO enforcement");
      await fetchProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`/api/sso/providers?org_id=${orgId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      if (!res.ok) throw new Error("Failed to create SSO provider");
      setShowForm(false);
      setFormData({ provider_type: "oidc", name: "", entity_id: "", sso_url: "", client_id: "", client_secret: "" });
      await fetchProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const handleDelete = async (providerId: string) => {
    if (!confirm("Are you sure you want to delete this SSO provider?")) return;
    try {
      const res = await fetch(`/api/sso/providers/${providerId}?org_id=${orgId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete provider");
      await fetchProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const providerTypeLabels: Record<string, string> = {
    okta: "Okta",
    google: "Google Workspace",
    oidc: "OIDC",
    saml2: "SAML 2.0",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">SSO / SAML</h2>
          <p className="text-sm text-[var(--text-muted)] dark:text-[var(--text-muted)]">
            Configure Single Sign-On for your organization using SAML or OIDC.
          </p>
        </div>
        {canManage && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-4 py-2 bg-primary text-[var(--bg-primary)] rounded-lg hover:bg-primary/90 text-sm"
          >
            {showForm ? "Cancel" : "Add Provider"}
          </button>
        )}
      </div>

      {error && (
        <div className="p-4 bg-[var(--error-dim)] bg-red-/20 border border-[var(--error)] dark:border-[var(--error)] rounded-lg text-[var(--error)] dark:text-[var(--error)] text-sm">
          {error}
        </div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="p-4 bg-[var(--bg-secondary)] dark:bg-[var(--bg-tertiary)] rounded-lg space-y-4">
          <h3 className="font-medium">New SSO Provider</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Provider Type</label>
              <select
                value={formData.provider_type}
                onChange={(e) => setFormData({ ...formData, provider_type: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg dark:bg-[var(--text-primary)] dark:border-[var(--border-strong)]"
              >
                <option value="oidc">OIDC</option>
                <option value="okta">Okta</option>
                <option value="google">Google Workspace</option>
                <option value="saml2">SAML 2.0</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="My SSO"
                required
                className="w-full px-3 py-2 border rounded-lg dark:bg-[var(--text-primary)] dark:border-[var(--border-strong)]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Entity ID / Client ID</label>
              <input
                type="text"
                value={formData.client_id || formData.entity_id}
                onChange={(e) => setFormData({
                  ...formData,
                  client_id: formData.provider_type === "oidc" ? e.target.value : formData.client_id,
                  entity_id: formData.provider_type !== "oidc" ? e.target.value : formData.entity_id,
                })}
                className="w-full px-3 py-2 border rounded-lg dark:bg-[var(--text-primary)] dark:border-[var(--border-strong)]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">SSO URL / Auth Endpoint</label>
              <input
                type="text"
                value={formData.sso_url}
                onChange={(e) => setFormData({ ...formData, sso_url: e.target.value })}
                placeholder="https://..."
                className="w-full px-3 py-2 border rounded-lg dark:bg-[var(--text-primary)] dark:border-[var(--border-strong)]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Client Secret</label>
              <input
                type="password"
                value={formData.client_secret}
                onChange={(e) => setFormData({ ...formData, client_secret: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg dark:bg-[var(--text-primary)] dark:border-[var(--border-strong)]"
              />
            </div>
          </div>
          <button
            type="submit"
            className="px-4 py-2 bg-primary text-[var(--bg-primary)] rounded-lg hover:bg-primary/90 text-sm"
          >
            Create Provider
          </button>
        </form>
      )}

      {loading ? (
        <div className="text-center py-8 text-[var(--text-muted)]">Loading...</div>
      ) : providers.length === 0 ? (
        <div className="text-center py-8 text-[var(--text-muted)] dark:text-[var(--text-muted)]">
          <p>No SSO providers configured.</p>
          <p className="text-sm mt-1">Add a provider to enable SSO for your organization.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {providers.map((provider) => (
            <div key={provider.id} className="p-4 border dark:border-[var(--text-secondary)] rounded-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-[var(--accent-faint)] rounded-lg flex items-center justify-center">
                    <span className="text-[var(--accent)] font-bold text-sm">
                      {provider.provider_type.slice(0, 2).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <h3 className="font-medium">{provider.name}</h3>
                    <p className="text-sm text-[var(--text-muted)] dark:text-[var(--text-muted)]">
                      {providerTypeLabels[provider.provider_type] || provider.provider_type}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-1 rounded-full ${provider.enabled ? "bg-[var(--terminal-faint)] bg-green-/30 text-[var(--terminal)] dark:text-[var(--terminal)]" : "bg-[var(--bg-tertiary)] dark:bg-[var(--text-primary)] text-[var(--text-muted)]"}`}>
                    {provider.enabled ? "Enabled" : "Disabled"}
                  </span>
                  {provider.enforce_sso && (
                    <span className="text-xs px-2 py-1 rounded-full bg-[var(--warning)] 100 bg-[var(--warning)]/30 text-[var(--warning)] 600 text-orange-">
                      Enforced
                    </span>
                  )}
                </div>
              </div>

              {provider.default_for_domain && (
                <p className="text-sm text-[var(--text-muted)] dark:text-[var(--text-muted)] mt-2">
                  Auto-enroll for domain: <strong>{provider.default_for_domain}</strong>
                </p>
              )}

              {canManage && (
                <div className="flex items-center gap-2 mt-4 pt-4 border-t dark:border-[var(--text-secondary)]">
                  <button
                    onClick={() => handleEnable(provider.id, !provider.enabled)}
                    className="px-3 py-1 text-sm border rounded-lg hover:bg-[var(--bg-secondary)] dark:hover:bg-[var(--text-primary)]"
                  >
                    {provider.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    onClick={() => handleEnforce(provider.id, !provider.enforce_sso)}
                    className="px-3 py-1 text-sm border rounded-lg hover:bg-[var(--bg-secondary)] dark:hover:bg-[var(--text-primary)]"
                  >
                    {provider.enforce_sso ? "Unenforce SSO" : "Enforce SSO"}
                  </button>
                  <button
                    onClick={() => handleDelete(provider.id)}
                    className="px-3 py-1 text-sm border border-[var(--error)] dark:border-[var(--error)] text-[var(--error)] dark:text-[var(--error)] rounded-lg hover:bg-[var(--error-dim)] dark:hover:bg-[var(--error-dim)]/20"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="p-4 bg-[var(--accent-faint)] border border-[var(--accent)] rounded-lg">
        <h3 className="font-medium text-[var(--accent)] mb-2">How SSO Works</h3>
        <ul className="text-sm text-[var(--accent)] space-y-1">
          <li>• Users with emails at <strong>{'{domain}'}</strong> will be automatically redirected to SSO</li>
          <li>• When SSO is enforced, password login is disabled for all org members</li>
          <li>• SCIM tokens are used for automated user provisioning (see SCIM tab)</li>
        </ul>
      </div>
    </div>
  );
}