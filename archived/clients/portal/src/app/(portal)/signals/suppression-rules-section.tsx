"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { StatusChip } from "@/components/ds/primitives";
import { useOrgQuery } from "@/hooks/use-api-query";
import { usePermissions } from "@/hooks/use-permissions";
import { useConfirm } from "@/hooks/use-confirm";
import { useLabToast } from "@/lab/lab-toast";
import { queryKeys } from "@/lib/query-keys";
import { ApiError } from "@/lib/api/core";
import {
  alertSuppressionRulesApi,
  type AlertSuppressionRule,
} from "@/lib/api/resources";
import { cn } from "@/lib/utils";

function permissionDeniedMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 403) {
    return "Admin role required to manage suppression rules.";
  }
  return err instanceof Error ? err.message : fallback;
}

function SuppressionRow({
  rule,
  canAuthor,
  busy,
  onToggle,
  onDelete,
}: {
  rule: AlertSuppressionRule;
  canAuthor: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-start gap-3 border-b border-[var(--line)] px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={rule.enabled ? "live" : "neutral"}>
            {rule.enabled ? "on" : "off"}
          </StatusChip>
          {rule.window_hours ? (
            <span className="type-meta">{rule.window_hours}h window</span>
          ) : null}
        </div>
        <p className="type-mono !text-[0.75rem] text-[var(--text)]">{rule.pattern}</p>
        {rule.reason ? (
          <p className="type-meta text-[var(--text-secondary)]">{rule.reason}</p>
        ) : null}
      </div>
      {canAuthor ? (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            disabled={busy}
            onClick={() => onToggle(!rule.enabled)}
          >
            {rule.enabled ? "Disable" : "Enable"}
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon"
            disabled={busy}
            aria-label={`Delete suppression rule ${rule.pattern}`}
            onClick={onDelete}
          >
            <Trash2 className="h-4 w-4 text-[var(--error)]" />
          </button>
        </div>
      ) : null}
    </li>
  );
}

/** FEAT-134: org-configurable triage suppression patterns on /signals?mode=nl-alerts. */
export function SuppressionRulesSection({ orgId }: { orgId: string }) {
  const { role } = usePermissions();
  const canAuthor = role === "owner" || role === "admin";
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();
  const confirm = useConfirm();

  const rulesQuery = useOrgQuery(
    queryKeys.portal.alertSuppressionRules(orgId),
    orgId,
    () => alertSuppressionRulesApi.list(orgId),
  );
  const rules = rulesQuery.data?.rules ?? [];

  const [pattern, setPattern] = useState("");
  const [reason, setReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.portal.alertSuppressionRules(orgId),
    });
  }, [queryClient, orgId]);

  const handleCreate = useCallback(async () => {
    if (!pattern.trim()) {
      setError("Pattern is required.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await alertSuppressionRulesApi.create(orgId, {
        pattern: pattern.trim(),
        reason: reason.trim(),
      });
      setPattern("");
      setReason("");
      setFormOpen(false);
      await invalidate();
      pushToast({ title: "Suppression rule added", tone: "ok" });
    } catch (err) {
      setError(permissionDeniedMessage(err, "Couldn't save suppression rule."));
    } finally {
      setCreating(false);
    }
  }, [orgId, pattern, reason, invalidate, pushToast]);

  const handleToggle = useCallback(
    async (rule: AlertSuppressionRule, enabled: boolean) => {
      setBusyId(rule.id);
      try {
        await alertSuppressionRulesApi.update(orgId, rule.id, { enabled });
        await invalidate();
      } catch (err) {
        pushToast({
          title: enabled ? "Couldn't enable rule" : "Couldn't disable rule",
          body: permissionDeniedMessage(err, "Try again"),
          tone: "fail",
        });
      } finally {
        setBusyId(null);
      }
    },
    [orgId, invalidate, pushToast],
  );

  const handleDelete = useCallback(
    async (rule: AlertSuppressionRule) => {
      const ok = await confirm(`Delete suppression rule "${rule.pattern}"?`);
      if (!ok) return;
      setBusyId(rule.id);
      try {
        await alertSuppressionRulesApi.delete(orgId, rule.id);
        await invalidate();
        pushToast({ title: "Suppression rule deleted", tone: "ok" });
      } catch (err) {
        pushToast({
          title: "Couldn't delete rule",
          body: permissionDeniedMessage(err, "Try again"),
          tone: "fail",
        });
      } finally {
        setBusyId(null);
      }
    },
    [orgId, invalidate, pushToast, confirm],
  );

  return (
    <section
      className="border-b border-[var(--line)] bg-[var(--bg)]"
      aria-label="Alert suppression rules"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
        <div className="space-y-1">
          <h2 className="type-label text-[var(--text)]">Suppression rules</h2>
          <p className="type-meta max-w-2xl text-[var(--text-faint)]">
            Regex or substring patterns that mark matching fired alerts as benign
            during auto-triage — use for known-noisy jobs or recurring spikes.
          </p>
        </div>
        {canAuthor ? (
          <button
            type="button"
            className="ds-btn ds-btn-sm"
            onClick={() => setFormOpen((open) => !open)}
          >
            <Plus className="h-3.5 w-3.5" />
            Add rule
          </button>
        ) : null}
      </div>

      {formOpen && canAuthor ? (
        <div className="space-y-3 border-t border-[var(--line)] px-4 py-4 sm:px-5">
          <label className="block space-y-1.5">
            <span className="type-label">Pattern (regex or plain text)</span>
            <input
              className="ds-input w-full font-mono text-sm"
              value={pattern}
              onChange={(e) => {
                setPattern(e.target.value);
                setError(null);
              }}
              placeholder="tuesday.?batch|marketing_campaign"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="type-label">Reason (shown in triage)</span>
            <input
              className="ds-input w-full"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Known noisy Tuesday batch job"
            />
          </label>
          {error ? (
            <p className="type-meta text-[var(--error)]" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              onClick={() => setFormOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              disabled={creating}
              onClick={() => void handleCreate()}
            >
              {creating ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}

      <div className={cn(rulesQuery.isLoading && "opacity-60")}>
        {rules.length === 0 ? (
          <p className="type-meta border-t border-[var(--line)] px-4 py-4 sm:px-5">
            No suppression rules yet.
          </p>
        ) : (
          <ul role="list">
            {rules.map((rule) => (
              <SuppressionRow
                key={rule.id}
                rule={rule}
                canAuthor={canAuthor}
                busy={busyId === rule.id}
                onToggle={(enabled) => void handleToggle(rule, enabled)}
                onDelete={() => void handleDelete(rule)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
