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

export default function SettingsScimPage() {
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

  // Tokens are one-time-visible — the backend never echoes an existing
  // token back on GET, only on the generate call's response. Keyed by
  // provider id so multiple providers can show their freshly-generated
  // token at once without clobbering each other.
  const [freshTokens, setFreshTokens] = useState<Record<string, string>>({});

  const generateMutation = useOrgMutation(
    (providerId: string) => api.generateSCIMToken(orgId!, providerId),
    {
      invalidateKeys: [queryKeys.portal.ssoProviders(orgId)],
      onSuccess: (data, providerId) => {
        setFreshTokens((prev) => ({ ...prev, [providerId]: data.token }));
        pushToast({
          title: "SCIM token generated",
          body: "Copy it now — it won't be shown again.",
          tone: "ok",
        });
      },
      onError: (err) => pushToast({ title: "Generate failed", body: err.message, tone: "fail" }),
    },
  );

  const revokeMutation = useOrgMutation(
    (providerId: string) => api.revokeSCIMToken(orgId!, providerId),
    {
      invalidateKeys: [queryKeys.portal.ssoProviders(orgId)],
      onSuccess: (_data, providerId) => {
        setFreshTokens((prev) => {
          const next = { ...prev };
          delete next[providerId];
          return next;
        });
        pushToast({ title: "SCIM token revoked", tone: "ok" });
      },
      onError: (err) => pushToast({ title: "Revoke failed", body: err.message, tone: "fail" }),
    },
  );

  const nav = (
    <SettingsModeNav
      value="scim"
      onChange={(next) => router.push(`/settings?mode=${next}`)}
    />
  );

  if (!orgSyncing && !currentOrg) {
    return (
      <NoWorkspaceGuard
        title="SCIM"
        message={
          organizations.length === 0
            ? "No workspace yet — create one from the banner above to get started."
            : "Select a workspace to manage SCIM tokens."
        }
        actions={nav}
      />
    );
  }

  if (providersQuery.isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="SCIM" actions={nav} />
        <QueryLoadingPanel label="Loading providers…" />
      </div>
    );
  }

  if (providersQuery.isError) {
    return (
      <div className="ds-page">
        <PageHeader title="SCIM" actions={nav} />
        <QueryErrorPanel error={providersQuery.error} onRetry={() => providersQuery.refetch()} />
      </div>
    );
  }

  return (
    <div className="ds-page">
      <PageHeader
        title="SCIM"
        meta="Generate a bearer token per SSO provider so an IdP can provision / deprovision members automatically."
        actions={nav}
      />

      <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
        {providers.length === 0 ? (
          <EmptyState
            title="No SSO providers configured"
            body="SCIM tokens are issued per provider — add an SSO provider first."
            action={
              <Link href="/settings/sso" className="ds-btn ds-btn-primary ds-btn-sm">
                Go to SSO
              </Link>
            }
          />
        ) : (
          <Panel className="!p-0">
            <ul>
              {providers.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-col gap-2 border-b border-[var(--line)] px-4 py-3 last:border-b-0 sm:px-6"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusChip tone={p.scim_enabled ? "ok" : "neutral"}>
                          {p.scim_enabled ? "SCIM enabled" : "SCIM off"}
                        </StatusChip>
                        <span className="type-ui text-[var(--text)]">{p.name}</span>
                        <span className="type-meta text-[var(--text-faint)]">
                          {p.provider_type}
                        </span>
                      </div>
                    </div>
                    {canEdit && (
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          className="ds-btn ds-btn-primary ds-btn-sm"
                          disabled={generateMutation.isPending}
                          onClick={() => generateMutation.mutate(p.id)}
                        >
                          {p.scim_enabled ? "Regenerate token" : "Generate token"}
                        </button>
                        {p.scim_enabled && (
                          <button
                            type="button"
                            className="ds-btn ds-btn-ghost ds-btn-sm"
                            disabled={revokeMutation.isPending}
                            onClick={() => {
                              if (window.confirm(`Revoke the SCIM token for "${p.name}"?`)) {
                                revokeMutation.mutate(p.id);
                              }
                            }}
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {freshTokens[p.id] && (
                    <div className="flex items-center gap-2 rounded-md border border-[var(--accent)] bg-[var(--accent-muted)] px-3 py-2">
                      <code className="type-meta min-w-0 flex-1 truncate text-[var(--text)]">
                        {freshTokens[p.id]}
                      </code>
                      <button
                        type="button"
                        className="ds-btn ds-btn-ghost ds-btn-sm shrink-0"
                        onClick={() => {
                          void navigator.clipboard.writeText(freshTokens[p.id]);
                          pushToast({ title: "Copied to clipboard", tone: "ok" });
                        }}
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        className="ds-btn ds-btn-ghost ds-btn-sm shrink-0"
                        onClick={() =>
                          setFreshTokens((prev) => {
                            const next = { ...prev };
                            delete next[p.id];
                            return next;
                          })
                        }
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </div>
  );
}
