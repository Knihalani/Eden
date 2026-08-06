"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader, Panel } from "@/components/ds/primitives";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { usePermissions } from "@/hooks/use-permissions";
import { useLabToast } from "@/lab/lab-toast";
import { SettingsModeNav } from "@/lab/settings/settings-chrome";
import { api } from "@/lib/api/resources";
import { queryKeys } from "@/lib/query-keys";

// Source of truth for the category list: ``eden.data_platform.pii._DEFAULT_CATEGORIES``.
// Adding a category server-side means it will already be accepted by
// ``updatePiiPolicy`` even before this list is refreshed — this is
// only used to render checkboxes for the *known* categories.
const PII_CATEGORIES = [
  "url_with_creds",
  "jwt",
  "api_key",
  "email",
  "phone",
  "ssn",
  "credit_card",
  "ipv4",
  "ipv6",
  "password_field",
  "aws_secret",
  "private_key",
  "iban",
  "passport",
] as const;

// Mirrors ``eden.data_platform.pii._CREDENTIAL_CATEGORIES`` — these get
// the fail-closed treatment when ``fail_closed_on_credentials`` is on.
const CREDENTIAL_CATEGORIES = new Set([
  "url_with_creds",
  "jwt",
  "api_key",
  "password_field",
  "aws_secret",
  "private_key",
]);

const MODES = [
  { id: "off", label: "Off", hint: "Never mask — raw values pass through." },
  { id: "redact", label: "Redact", hint: "Mask per the active category set (default)." },
  { id: "fail_closed", label: "Fail closed", hint: "Redact, and raise on credential detection." },
] as const;

type PiiPolicy = Awaited<ReturnType<typeof api.getPiiPolicy>>;

export default function SettingsPiiPage() {
  const router = useRouter();
  const { currentOrg, organizations, orgSyncing } = useOrg();
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission("pii:edit");
  const { pushToast } = useLabToast();
  const orgId = currentOrg?.id ?? null;

  const policyQuery = useOrgQuery(
    queryKeys.portal.piiPolicy(orgId),
    orgId,
    () => api.getPiiPolicy(orgId!),
  );

  const [mode, setMode] = useState<string>("redact");
  const [enabledCategories, setEnabledCategories] = useState<Set<string>>(
    new Set(PII_CATEGORIES),
  );
  const [failClosed, setFailClosed] = useState(false);
  const [extraKeys, setExtraKeys] = useState("");
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!policyQuery.data) return;
    const p = policyQuery.data as PiiPolicy;
    setMode(p.mode);
    setEnabledCategories(new Set(p.enabled_categories));
    setFailClosed(p.fail_closed_on_credentials);
    setExtraKeys(p.redact_keys_extra.join(", "));
    setNotes(p.notes ?? "");
    setDirty(false);
  }, [policyQuery.data]);

  const saveMutation = useOrgMutation(
    () =>
      api.updatePiiPolicy(orgId!, {
        mode,
        enabled_categories: Array.from(enabledCategories),
        disabled_categories: PII_CATEGORIES.filter((c) => !enabledCategories.has(c)),
        fail_closed_on_credentials: failClosed,
        redact_keys_extra: extraKeys
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
        notes: notes.trim() || null,
      }),
    {
      invalidateKeys: [queryKeys.portal.piiPolicy(orgId)],
      onSuccess: () => {
        setDirty(false);
        pushToast({ title: "PII policy saved", tone: "ok" });
      },
      onError: (err) => {
        pushToast({ title: "Save failed", body: err.message, tone: "fail" });
      },
    },
  );

  function toggleCategory(cat: string) {
    setDirty(true);
    setEnabledCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  const nav = (
    <SettingsModeNav
      value="pii"
      onChange={(next) => router.push(`/settings?mode=${next}`)}
    />
  );

  if (!orgSyncing && !currentOrg) {
    return (
      <NoWorkspaceGuard
        title="PII policy"
        message={
          organizations.length === 0
            ? "No workspace yet — create one from the banner above to get started."
            : "Select a workspace to view PII policy."
        }
        actions={nav}
      />
    );
  }

  if (policyQuery.isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="PII policy" actions={nav} />
        <QueryLoadingPanel label="Loading PII policy…" />
      </div>
    );
  }

  if (policyQuery.isError) {
    return (
      <div className="ds-page">
        <PageHeader title="PII policy" actions={nav} />
        <QueryErrorPanel error={policyQuery.error} onRetry={() => policyQuery.refetch()} />
      </div>
    );
  }

  return (
    <div className="ds-page">
      <PageHeader
        title="PII policy"
        meta="Controls redaction of sensitive values in ingested traces, logs, and evals."
        actions={nav}
      />
      <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
        <Panel>
          <div className="flex flex-col gap-4 p-4 sm:p-5">
            <div>
              <h2 className="type-ui mb-2 text-[var(--text)]">Mode</h2>
              <div className="flex flex-col gap-2 sm:flex-row">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    disabled={!canEdit}
                    onClick={() => {
                      setMode(m.id);
                      setDirty(true);
                    }}
                    className={
                      "ds-btn ds-btn-sm flex-1 flex-col items-start gap-0.5 !h-auto !items-start py-2 text-left" +
                      (mode === m.id ? " ds-btn-primary" : " ds-btn-ghost")
                    }
                  >
                    <span className="type-ui">{m.label}</span>
                    <span className="type-meta font-normal">{m.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <h2 className="type-ui mb-2 text-[var(--text)]">
                Enabled categories ({enabledCategories.size}/{PII_CATEGORIES.length})
              </h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {PII_CATEGORIES.map((cat) => (
                  <label
                    key={cat}
                    className="flex items-center gap-2 rounded-md border border-[var(--line)] px-2.5 py-1.5"
                  >
                    <input
                      type="checkbox"
                      checked={enabledCategories.has(cat)}
                      disabled={!canEdit || mode === "off"}
                      onChange={() => toggleCategory(cat)}
                    />
                    <span className="type-meta text-[var(--text)]">
                      {cat}
                      {CREDENTIAL_CATEGORIES.has(cat) && (
                        <span className="ml-1 text-[var(--text-faint)]">(cred)</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={failClosed}
                disabled={!canEdit}
                onChange={(e) => {
                  setFailClosed(e.target.checked);
                  setDirty(true);
                }}
              />
              <span className="type-ui text-[var(--text)]">
                Fail closed on credential detection
              </span>
              <span className="type-meta text-[var(--text-faint)]">
                — raise instead of redacting when a credential-grade pattern is found
              </span>
            </label>

            <div>
              <label className="type-ui mb-1 block text-[var(--text)]">
                Extra keys to redact
              </label>
              <input
                type="text"
                className="ds-input w-full"
                placeholder="comma-separated JSON keys, e.g. internal_note, ssn_backup"
                value={extraKeys}
                disabled={!canEdit}
                onChange={(e) => {
                  setExtraKeys(e.target.value);
                  setDirty(true);
                }}
              />
            </div>

            <div>
              <label className="type-ui mb-1 block text-[var(--text)]">Notes</label>
              <textarea
                className="ds-input w-full"
                rows={2}
                value={notes}
                disabled={!canEdit}
                onChange={(e) => {
                  setNotes(e.target.value);
                  setDirty(true);
                }}
              />
            </div>

            {canEdit ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="ds-btn ds-btn-primary"
                  disabled={!dirty || saveMutation.isPending}
                  onClick={() => saveMutation.mutate()}
                >
                  {saveMutation.isPending ? "Saving…" : "Save policy"}
                </button>
                {dirty && <span className="type-meta text-[var(--text-faint)]">Unsaved changes</span>}
              </div>
            ) : (
              <p className="type-meta text-[var(--text-faint)]">
                You need the pii:edit permission (owner/admin) to change this policy.
              </p>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
