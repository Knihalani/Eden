"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeader, Panel, StatusChip } from "@/components/ds/primitives";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { EmptyState } from "@/lab/lab-ui";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { usePermissions } from "@/hooks/use-permissions";
import { useLabToast } from "@/lab/lab-toast";
import { SettingsModeNav } from "@/lab/settings/settings-chrome";
import { api } from "@/lib/api/resources";
import { queryKeys } from "@/lib/query-keys";
import { formatSmartTime } from "@/lib/format";

const PROVIDER_TYPES = ["okta", "google", "oidc", "saml2"] as const;

export default function SettingsSsoPage() {
  const router = useRouter();
  const { currentOrg, organizations, orgSyncing } = useOrg();
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission("settings:edit");
  const { pushToast } = useLabToast();
  const orgId = currentOrg?.id ?? null;

  const providersQuery = useOrgQuery(
    queryKeys.portal.ssoProviders(orgId),
    orgId,
    () => api.listSSOProviders(orgId!),
  );
  const providers = providersQuery.data ?? [];

  const [creating, setCreating] = useState(false);
  const [providerType, setProviderType] = useState<string>("oidc");
  const [name, setName] = useState("");
  const [entityId, setEntityId] = useState("");
  const [ssoUrl, setSsoUrl] = useState("");
  const [certificate, setCertificate] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState("");

  function resetForm() {
    setName("");
    setEntityId("");
    setSsoUrl("");
    setCertificate("");
    setClientId("");
    setClientSecret("");
    setScopes("");
  }

  const createMutation = useOrgMutation(
    () =>
      api.createSSOProvider(orgId!, {
        provider_type: providerType,
        name: name.trim(),
        entity_id: entityId.trim() || undefined,
        sso_url: ssoUrl.trim() || undefined,
        certificate: certificate.trim() || undefined,
        client_id: clientId.trim() || undefined,
        client_secret: clientSecret.trim() || undefined,
        scopes: scopes.trim() ? scopes.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      }),
    {
      invalidateKeys: [queryKeys.portal.ssoProviders(orgId)],
      onSuccess: () => {
        pushToast({ title: "SSO provider created", tone: "ok" });
        setCreating(false);
        resetForm();
      },
      onError: (err) => pushToast({ title: "Create failed", body: err.message, tone: "fail" }),
    },
  );

  const enableMutation = useOrgMutation(
    (providerId: string) => api.enableSSOProvider(orgId!, providerId),
    {
      invalidateKeys: [queryKeys.portal.ssoProviders(orgId)],
      onError: (err) => pushToast({ title: "Enable failed", body: err.message, tone: "fail" }),
    },
  );
  const disableMutation = useOrgMutation(
    (providerId: string) => api.disableSSOProvider(orgId!, providerId),
    {
      invalidateKeys: [queryKeys.portal.ssoProviders(orgId)],
      onError: (err) => pushToast({ title: "Disable failed", body: err.message, tone: "fail" }),
    },
  );
  const enforceMutation = useOrgMutation(
    ({ providerId, enforce }: { providerId: string; enforce: boolean }) =>
      api.enforceSSO(orgId!, providerId, enforce),
    {
      invalidateKeys: [queryKeys.portal.ssoProviders(orgId)],
      onSuccess: (_data, vars) =>
        pushToast({
          title: vars.enforce ? "SSO enforced" : "SSO enforcement removed",
          tone: "ok",
        }),
      onError: (err) => pushToast({ title: "Update failed", body: err.message, tone: "fail" }),
    },
  );

  const nav = (
    <SettingsModeNav
      value="sso"
      onChange={(next) => router.push(`/settings?mode=${next}`)}
    />
  );

  if (!orgSyncing && !currentOrg) {
    return (
      <NoWorkspaceGuard
        title="SSO"
        message={
          organizations.length === 0
            ? "No workspace yet — create one from the banner above to get started."
            : "Select a workspace to view SSO settings."
        }
        actions={nav}
      />
    );
  }

  if (providersQuery.isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="SSO" actions={nav} />
        <QueryLoadingPanel label="Loading SSO providers…" />
      </div>
    );
  }

  if (providersQuery.isError) {
    return (
      <div className="ds-page">
        <PageHeader title="SSO" actions={nav} />
        <QueryErrorPanel error={providersQuery.error} onRetry={() => providersQuery.refetch()} />
      </div>
    );
  }

  return (
    <div className="ds-page">
      <PageHeader
        title="SSO"
        meta="Native SSO for self-hosted orgs"
        actions={nav}
      />

      <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
        <div
          role="note"
          className="rounded-[var(--radius)] border border-[var(--warning)]/40 bg-[var(--warning-muted)] px-4 py-3 type-meta text-[var(--text)]"
        >
          <p className="type-ui text-[var(--text)]">Clerk-hosted deployments</p>
          <p className="mt-1">
            Production and most hosted Eden workspaces authenticate through{" "}
            <strong>Clerk</strong>. Configure SSO and SCIM in the{" "}
            <a
              className="text-[var(--accent)] underline"
              href="https://dashboard.clerk.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              Clerk dashboard
            </a>{" "}
            — not here. Providers you add on this screen use Eden&apos;s native{" "}
            SSO path and only affect self-hosted deployments that
            do not use Clerk; they do not drive Clerk login traffic.
          </p>
          <p className="mt-2">
            See{" "}
            <a className="text-[var(--accent)] underline" href="https://docs.edenobservability.com/how-to/sso">
              Configure SSO + SCIM
            </a>{" "}
            for the authoritative setup guide.
          </p>
        </div>

        {providers.length === 0 && !creating ? (
          <EmptyState
            title="Configure SSO in Clerk"
            body="Hosted workspaces authenticate through Clerk. Native providers on this screen only affect self-hosted deployments."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <a
                  className="ds-btn ds-btn-primary ds-btn-sm"
                  href="https://dashboard.clerk.com"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Manage in Clerk
                </a>
                {canEdit ? (
                  <button
                    type="button"
                    className="ds-btn ds-btn-ghost ds-btn-sm"
                    onClick={() => setCreating(true)}
                  >
                    Add native provider
                  </button>
                ) : null}
              </div>
            }
          />
        ) : null}

        {providers.length > 0 && canEdit && !creating ? (
          <div>
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              onClick={() => setCreating(true)}
            >
              Add native provider
            </button>
          </div>
        ) : null}

        {creating && (
          <Panel>
            <div className="flex flex-col gap-3 p-4 sm:p-5">
              <h2 className="type-ui text-[var(--text)]">New SSO provider</h2>
              <div className="flex flex-col gap-2 sm:flex-row">
                <select
                  className="ds-input"
                  value={providerType}
                  onChange={(e) => setProviderType(e.target.value)}
                >
                  {PROVIDER_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <input
                  className="ds-input flex-1"
                  placeholder="Display name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              {providerType === "saml2" ? (
                <>
                  <input
                    className="ds-input"
                    placeholder="Entity ID"
                    value={entityId}
                    onChange={(e) => setEntityId(e.target.value)}
                  />
                  <input
                    className="ds-input"
                    placeholder="SSO URL"
                    value={ssoUrl}
                    onChange={(e) => setSsoUrl(e.target.value)}
                  />
                  <textarea
                    className="ds-input"
                    rows={4}
                    placeholder="X.509 certificate (PEM)"
                    value={certificate}
                    onChange={(e) => setCertificate(e.target.value)}
                  />
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      className="ds-input flex-1"
                      placeholder="Client ID"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                    />
                    <input
                      className="ds-input flex-1"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Client secret"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                    />
                  </div>
                  {providerType === "oidc" && (
                    <input
                      className="ds-input"
                      placeholder="Issuer / discovery URL (entity_id)"
                      value={entityId}
                      onChange={(e) => setEntityId(e.target.value)}
                    />
                  )}
                  <input
                    className="ds-input"
                    placeholder="Scopes (comma-separated, optional)"
                    value={scopes}
                    onChange={(e) => setScopes(e.target.value)}
                  />
                </>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="ds-btn ds-btn-primary ds-btn-sm"
                  disabled={!name.trim() || createMutation.isPending}
                  onClick={() => createMutation.mutate()}
                >
                  {createMutation.isPending ? "Creating…" : "Create provider"}
                </button>
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                  onClick={() => setCreating(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </Panel>
        )}

        {providers.length === 0 && !creating ? (
          <EmptyState
            title="No native SSO providers configured"
            body="Self-hosted only: add an Okta, Google, OIDC, or SAML provider for Eden's native login path. Clerk-hosted orgs should configure SSO in Clerk instead."
          />
        ) : (
          <Panel className="!p-0">
            <ul>
              {providers.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3 last:border-b-0 sm:px-6"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip tone={p.enabled ? "ok" : "neutral"}>
                        {p.enabled ? "Enabled" : "Disabled"}
                      </StatusChip>
                      {p.enforce_sso && <StatusChip tone="live">Enforced</StatusChip>}
                      {p.scim_enabled && <StatusChip tone="neutral">SCIM on</StatusChip>}
                      <span className="type-ui text-[var(--text)]">{p.name}</span>
                    </div>
                    <p className="type-meta text-[var(--text-faint)]">
                      {p.provider_type}
                      {p.default_for_domain && <> · default for {p.default_for_domain}</>}
                      {" · created "}
                      {formatSmartTime(p.created_at)}
                    </p>
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        className="ds-btn ds-btn-ghost ds-btn-sm"
                        disabled={enableMutation.isPending || disableMutation.isPending}
                        onClick={() =>
                          p.enabled
                            ? disableMutation.mutate(p.id)
                            : enableMutation.mutate(p.id)
                        }
                      >
                        {p.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        className="ds-btn ds-btn-ghost ds-btn-sm"
                        disabled={enforceMutation.isPending}
                        onClick={() =>
                          enforceMutation.mutate({ providerId: p.id, enforce: !p.enforce_sso })
                        }
                      >
                        {p.enforce_sso ? "Stop enforcing" : "Enforce SSO"}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        )}
        <p className="type-meta text-[var(--text-faint)]">
          Native (self-hosted) login is served at{" "}
          <code>/sso/login/&#123;provider_id&#125;</code>; SCIM token provisioning lives on the{" "}
          <Link className="text-[var(--accent)]" href="/settings/scim">
            SCIM
          </Link>{" "}
          screen.
        </p>
      </div>
    </div>
  );
}
