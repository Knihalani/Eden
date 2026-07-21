"use client";

import { useEffect, useState } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Loader2, Eye, EyeOff, Plus, X, AlertTriangle, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ErrorState } from "@/components/ui/error-state";
import { errorFromCaught } from "@/lib/safe-error-message";
import {
  PII_CATEGORIES,
  derivePiiMode,
  isPiiCategoryEnabled,
  type PiiPolicy,
} from "./pii-policy-shared";

export function PiiPolicyTab() {
  const { currentOrg } = useOrg();
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const canEdit = hasPermission("pii:edit");
  const orgId = currentOrg?.id ?? null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<PiiPolicy | null>(null);
  const [newKey, setNewKey] = useState("");
  const policyQuery = useOrgQuery(queryKeys.piiPolicy.detail(orgId), orgId, () =>
    api.getPiiPolicy(orgId!),
  );
  const policy = policyQuery.data ?? null;
  const loading = policyQuery.isLoading;

  useEffect(() => {
    if (policyQuery.data) setDraft(policyQuery.data);
  }, [policyQuery.data]);
  useEffect(() => {
    if (policyQuery.error) {
      setError(errorFromCaught(policyQuery.error, "Failed to load PII policy"));
    }
  }, [policyQuery.error]);

  const dirty = JSON.stringify(policy) !== JSON.stringify(draft);

  const handleSave = async () => {
    if (!currentOrg || !draft || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const mode = derivePiiMode(
        draft.enabled_categories,
        draft.fail_closed_on_credentials,
      );
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
    setDraft({
      ...draft,
      enabled_categories: enabledList,
      disabled_categories: [...disabled],
      mode: derivePiiMode(enabledList, draft.fail_closed_on_credentials),
    });
  };

  const addExtraKey = () => {
    if (!draft) return;
    const trimmed = newKey.trim();
    if (!trimmed || draft.redact_keys_extra.includes(trimmed)) {
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
      <div className="text-center py-12 text-[var(--text-secondary)]" data-ws7-pii>
        Select a workspace to manage PII policy.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" data-ws7-pii>
        <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
        <span className="ml-2 text-[var(--text-secondary)]">Loading PII policy...</span>
      </div>
    );
  }

  if (!draft) {
    return (
      <div data-ws7-pii>
        <ErrorState
          title="Could not load PII policy"
          message={error ?? "Failed to load PII policy"}
          action={
            <Button variant="outline" size="sm" onClick={() => void policyQuery.refetch()}>
              <RefreshCw className="h-3.5 w-3.5" />
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  const enabledCount = PII_CATEGORIES.filter((c) =>
    isPiiCategoryEnabled(draft, c.id),
  ).length;

  return (
    <div className="space-y-space-6" data-ws7-pii>
      <div>
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">PII policy</h2>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Choose which personally identifiable categories are redacted from ingested telemetry.
        </p>
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
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Redaction categories
            </h3>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {enabledCount} of {PII_CATEGORIES.length} enabled · mode{" "}
              <span className="font-mono">{draft.mode}</span>
            </p>
          </div>
          {!canEdit && <span className="text-xs text-[var(--text-muted)]">Read-only</span>}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {PII_CATEGORIES.map((cat) => {
            const enabled = isPiiCategoryEnabled(draft, cat.id);
            return (
              <label
                key={cat.id}
                className={cn(
                  "flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors",
                  enabled
                    ? "border-[var(--border-default)] bg-[var(--bg-secondary)]"
                    : "border-[var(--border-default)] bg-[var(--bg-tertiary)]",
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
                  <p className="text-xs text-[var(--text-muted)] mt-0.5 font-mono">
                    {cat.description}
                  </p>
                </div>
              </label>
            );
          })}
        </div>
      </Card>

      <Card padding="md">
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Fail-closed on credentials
            </h3>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Reject ingestion that contains detected credentials instead of redacting.
            </p>
          </div>
          <Switch
            checked={draft.fail_closed_on_credentials}
            disabled={!canEdit}
            onCheckedChange={(next) => {
              if (!canEdit) return;
              setDraft({
                ...draft,
                fail_closed_on_credentials: next,
                mode: derivePiiMode(draft.enabled_categories, next),
              });
            }}
            aria-label="Toggle fail-closed on credentials"
          />
        </div>
      </Card>

      <Card padding="md">
        <div className="flex items-center gap-2 mb-2">
          <Eye className="w-4 h-4 text-[var(--text-muted)]" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Extra redact keys</h3>
        </div>
        <p className="text-xs text-[var(--text-muted)] mb-3">
          Additional JSON field names to redact. Match is case-sensitive.
        </p>
        {draft.redact_keys_extra.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {draft.redact_keys_extra.map((key) => (
              <span
                key={key}
                className="inline-flex items-center gap-1 px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded text-xs font-mono"
              >
                <EyeOff className="w-3 h-3 text-[var(--text-muted)]" />
                {key}
                {canEdit && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeExtraKey(key)}
                    aria-label={`Remove ${key}`}
                    className="h-auto min-h-0 p-0 ml-1"
                  >
                    <X className="w-3 h-3" />
                  </Button>
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
              className="flex-1 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm font-mono"
            />
            <Button
              type="button"
              variant="default"
              className="min-h-11"
              onClick={addExtraKey}
              disabled={!newKey.trim()}
            >
              <Plus className="w-4 h-4" />
              Add
            </Button>
          </div>
        )}
      </Card>

      {canEdit && (
        <div className="flex items-center justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={handleReset} disabled={!dirty || saving}>
            Discard changes
          </Button>
          <Button
            type="button"
            variant="default"
            className="min-h-11"
            onClick={() => void handleSave()}
            disabled={!dirty}
            loading={saving}
          >
            Save changes
          </Button>
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
