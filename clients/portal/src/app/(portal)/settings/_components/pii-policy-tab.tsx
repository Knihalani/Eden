"use client";

import { useEffect, useState } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Loader2, ShieldAlert, ShieldCheck, Eye, EyeOff, Plus, X, AlertTriangle, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { errorFromCaught } from "@/lib/safe-error-message";

/** Categories mirror ``eden.data_platform.pii._DEFAULT_CATEGORIES``. */
const CATEGORIES: Array<{
  id: string;
  label: string;
  description: string;
}> = [
  { id: "email", label: "Email addresses", description: "user@example.com" },
  { id: "phone", label: "Phone numbers", description: "E.164 and US formats" },
  { id: "ssn", label: "Social Security Numbers", description: "US 9-digit SSN" },
  { id: "credit_card", label: "Credit card numbers", description: "PAN via Luhn check" },
  { id: "ipv4", label: "IPv4 addresses", description: "0.0.0.0/24 and above" },
  { id: "ipv6", label: "IPv6 addresses", description: "full + compressed forms" },
  { id: "jwt", label: "JWT tokens", description: "header.payload.signature" },
  { id: "api_key", label: "API keys", description: "service-provider prefixes" },
  { id: "url_with_creds", label: "URLs with embedded credentials", description: "https://user:pass@host" },
  { id: "password_field", label: "Password fields", description: "keys ending in password/secret" },
  { id: "aws_secret", label: "AWS secrets", description: "AKIA… / secret access keys" },
  { id: "private_key", label: "Private keys", description: "PEM / OpenSSH blocks" },
  { id: "iban", label: "IBAN", description: "international bank account numbers" },
  { id: "passport", label: "Passport numbers", description: "common passport patterns" },
];

type PiiMode = "off" | "redact" | "fail_closed";

/** Mirrors ``PIIPolicyOut`` from ``eden.api.routes.pii_policy``. */
interface PiiPolicy {
  policy_id: string;
  tenant_id: string;
  mode: PiiMode | string;
  enabled_categories: string[];
  disabled_categories: string[];
  fail_closed_on_credentials: boolean;
  redact_keys_extra: string[];
  effective_from: string;
  effective_until: string | null;
  created_by: string | null;
  notes: string | null;
}

function deriveMode(
  enabled: string[],
  failClosed: boolean,
): PiiMode {
  if (failClosed) return "fail_closed";
  if (enabled.length === 0) return "off";
  return "redact";
}

function isCategoryEnabled(draft: PiiPolicy, id: string): boolean {
  if (draft.disabled_categories.includes(id)) return false;
  if (draft.enabled_categories.includes(id)) return true;
  // Default policy lists everything in enabled_categories; treat
  // unknown ids as off when neither list mentions them.
  return false;
}

export function PiiPolicyTab() {
  const { currentOrg } = useOrg();
  const { hasPermission } = usePermissions();
  const toast = useToast();
  // BE gates PUT with ``pii:edit`` (owner + admin).
  const canEdit = hasPermission("pii:edit");
  const orgId = currentOrg?.id ?? null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<PiiPolicy | null>(null);
  const [newKey, setNewKey] = useState("");
  const policyQuery = useOrgQuery(
    queryKeys.piiPolicy.detail(orgId),
    orgId,
    () => api.getPiiPolicy(orgId!),
  );
  const policy = policyQuery.data ?? null;
  const loading = policyQuery.isLoading;
  useEffect(() => {
    if (policyQuery.data) setDraft(policyQuery.data);
  }, [policyQuery.data]);
  useEffect(() => {
    if (policyQuery.error) setError(errorFromCaught(policyQuery.error, "Failed to load PII policy"));
  }, [policyQuery.error]);
  const dirty = JSON.stringify(policy) !== JSON.stringify(draft);
  const handleSave = async () => {
    if (!currentOrg || !draft) return;
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      const mode = deriveMode(draft.enabled_categories, draft.fail_closed_on_credentials);
      const updated = await api.updatePiiPolicy(currentOrg.id, {
        mode,
        enabled_categories: draft.enabled_categories,
        disabled_categories: draft.disabled_categories,
        fail_closed_on_credentials: draft.fail_closed_on_credentials,
        redact_keys_extra: draft.redact_keys_extra,
        notes: draft.notes,
      });
      setDraft(updated);
      await policyQuery.refetch();
      toast.success("PII policy saved");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save PII policy";
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };
  const handleReset = () => {
    setDraft(policy);
    setNewKey("");
  };
  const toggleCategory = (id: string, value: boolean) => {
    if (!draft) return;
    const enabled = new Set(draft.enabled_categories);
    const disabled = new Set(draft.disabled_categories);
    if (value) {
      enabled.add(id);
      disabled.delete(id);
    } else {
      enabled.delete(id);
      disabled.add(id);
    }
    const enabledList = [...enabled];
    const failClosed = draft.fail_closed_on_credentials;
    setDraft({
      ...draft,
      enabled_categories: enabledList,
      disabled_categories: [...disabled],
      mode: deriveMode(enabledList, failClosed),
    });
  };
  const addExtraKey = () => {
    if (!draft) return;
    const trimmed = newKey.trim();
    if (!trimmed) return;
    if (draft.redact_keys_extra.includes(trimmed)) {
      setNewKey("");
      return;
    }
    setDraft({
      ...draft,
      redact_keys_extra: [...draft.redact_keys_extra, trimmed],
    });
    setNewKey("");
  };
  const removeExtraKey = (key: string) => {
    if (!draft) return;
    setDraft({
      ...draft,
      redact_keys_extra: draft.redact_keys_extra.filter((k) => k !== key),
    });
  };
  if (!currentOrg) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to manage PII policy.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
        <span className="ml-2 text-[var(--text-secondary)]">Loading PII policy...</span>
      </div>
    );
  }
  if (!draft) {
    return (
      <ErrorState
        title="Could not load PII policy"
        message={error ?? "Failed to load PII policy"}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void policyQuery.refetch()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Try again
          </Button>
        }
      />
    );
  }
  const enabledCount = CATEGORIES.filter((c) => isCategoryEnabled(draft, c.id)).length;
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-[var(--bg-tertiary)] rounded-lg border border-[var(--border-default)]">
          <ShieldCheck className="w-5 h-5 text-[var(--accent)]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">PII Policy</h2>
          <p className="text-sm text-[var(--text-muted)]">
            Configure which categories of personally identifiable information are redacted from
            ingested telemetry events.
          </p>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-[var(--error)]/10 border border-[var(--error)]/30 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 text-[var(--error)] mt-0.5" />
          <p className="text-sm text-[var(--error)]">{error}</p>
        </div>
      )}

      <Card padding="md">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Redaction categories</h3>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {enabledCount} of {CATEGORIES.length} categories enabled · mode{" "}
              <span className="font-mono">{draft.mode}</span>
            </p>
          </div>
          {!canEdit && (
            <span className="text-xs px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded text-[var(--text-muted)]">
              Read-only
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {CATEGORIES.map((cat) => {
            const enabled = isCategoryEnabled(draft, cat.id);
            return (
              <label
                key={cat.id}
                className={cn(
                  "flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors",
                  enabled
                    ? "border-[var(--accent)] bg-[var(--accent)]/5"
                    : "border-[var(--border-default)] bg-[var(--bg-tertiary)] hover:border-[var(--border-default)]/80",
                  !canEdit && "cursor-not-allowed opacity-80",
                )}
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={!canEdit}
                  onChange={(e) => toggleCategory(cat.id, e.target.checked)}
                  className="mt-0.5 rounded border-[var(--border-default)] text-[var(--accent)] focus:ring-[var(--accent)]"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{cat.label}</p>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5 font-mono">{cat.description}</p>
                </div>
              </label>
            );
          })}
        </div>
      </Card>

      <Card padding="md">
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-[var(--text-muted)]" />
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Fail-closed on credentials
              </h3>
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              When enabled, ingestion events that contain detected credentials (JWT, API keys,
              URL credentials, password fields) will be rejected instead of redacted. Use this if
              your security posture requires explicit rejection of credential leaks.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!canEdit) return;
              const next = !draft.fail_closed_on_credentials;
              setDraft({
                ...draft,
                fail_closed_on_credentials: next,
                mode: deriveMode(draft.enabled_categories, next),
              });
            }}
            disabled={!canEdit}
            aria-pressed={draft.fail_closed_on_credentials}
            aria-label="Toggle fail-closed on credentials"
            className={cn(
              "relative w-12 h-6 rounded-full transition-colors flex-shrink-0",
              draft.fail_closed_on_credentials ? "bg-[var(--accent)]" : "bg-[var(--bg-tertiary)]",
              !canEdit && "opacity-50 cursor-not-allowed",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 left-0.5 w-5 h-5 bg-[var(--bg-primary)] rounded-full transition-transform",
                draft.fail_closed_on_credentials && "translate-x-6",
              )}
            />
          </button>
        </div>
      </Card>

      <Card padding="md">
        <div className="flex items-center gap-2 mb-2">
          <Eye className="w-4 h-4 text-[var(--text-muted)]" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Extra redact keys</h3>
        </div>
        <p className="text-xs text-[var(--text-muted)] mb-3">
          Additional JSON field names to redact beyond the built-in detector set. Match is
          case-sensitive on the field name.
        </p>

        {draft.redact_keys_extra.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {draft.redact_keys_extra.map((key) => (
              <span
                key={key}
                className="inline-flex items-center gap-1 px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded text-xs font-mono text-[var(--text-primary)]"
              >
                <EyeOff className="w-3 h-3 text-[var(--text-muted)]" />
                {key}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => removeExtraKey(key)}
                    className="ml-1 text-[var(--text-muted)] hover:text-[var(--error)]"
                    aria-label={`Remove ${key}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        {canEdit && (
          <div className="flex gap-2">
            <input
              type="text"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addExtraKey();
                }
              }}
              placeholder="e.g. session_token"
              className="flex-1 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] text-sm font-mono"
            />
            <button
              type="button"
              onClick={addExtraKey}
              disabled={!newKey.trim()}
              className="px-3 py-2 bg-[var(--accent)] text-[var(--bg-primary)] rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
          </div>
        )}
      </Card>

      {canEdit && (
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={handleReset}
            disabled={!dirty || saving}
            className="px-4 py-2 text-sm border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            Discard changes
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            className="px-4 py-2 bg-[var(--accent)] text-[var(--bg-primary)] rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save changes
          </button>
        </div>
      )}

      {policy?.effective_from && (
        <p className="text-xs text-[var(--text-muted)]">
          Effective from {new Date(policy.effective_from).toLocaleString()}
        </p>
      )}
    </div>
  );
}
