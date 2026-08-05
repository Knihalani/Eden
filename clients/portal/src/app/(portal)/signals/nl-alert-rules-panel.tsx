"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { PageHeader, StatusChip } from "@/components/ds/primitives";
import { EmptyState } from "@/lab/lab-ui";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { usePermissions } from "@/hooks/use-permissions";
import { useConfirm } from "@/hooks/use-confirm";
import { useLabToast } from "@/lab/lab-toast";
import { queryKeys } from "@/lib/query-keys";
import { ApiError } from "@/lib/api/core";
import {
  nlAlertRulesApi,
  type CompileNlAlertResponse,
  type NLAlertRule,
  type NLRuleCreateBody,
  type NLRuleUpdateBody,
} from "@/lib/api/resources";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { cn } from "@/lib/utils";
import { SignalsModeToggle } from "./automations-panel";

const SEVERITIES = ["critical", "error", "warning", "info"] as const;

/** FEAT-18: org owner/admin can author; everyone else gets a read-only list. */
function useCanAuthorAlertRules(): boolean {
  const { role } = usePermissions();
  return role === "owner" || role === "admin";
}

function permissionDeniedMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 403) {
    return "Admin role required to manage alert rules.";
  }
  return err instanceof Error ? err.message : fallback;
}

function RuleRow({
  rule,
  active,
  onSelect,
}: {
  rule: NLAlertRule;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-active={active ? "true" : "false"}
      className={cn(
        "flex w-full items-start gap-3 border-b border-[var(--line)] px-4 py-3 text-left transition-colors sm:px-5",
        active
          ? "bg-[var(--accent-muted)] shadow-[inset_2px_0_0_var(--accent)]"
          : "hover:bg-[var(--accent-muted)]",
        !rule.enabled && "opacity-55",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={rule.enabled ? "live" : "neutral"}>
            {rule.enabled ? "on" : "off"}
          </StatusChip>
          {rule.triage_enabled ? (
            <span className="type-meta">auto-triage</span>
          ) : null}
        </div>
        <p className="type-ui truncate text-[var(--text)]">{rule.name}</p>
        <p className="type-meta line-clamp-2">{rule.nl_text}</p>
      </div>
    </button>
  );
}

function RuleDetail({
  rule,
  canAuthor,
  onClose,
  onEdit,
  onDelete,
  onToggleEnabled,
  busy,
}: {
  rule: NLAlertRule;
  canAuthor: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  busy?: boolean;
}) {
  return (
    <aside
      className="flex h-full min-h-0 w-full min-w-0 flex-col border-[var(--line)] bg-[var(--bg)] lg:w-[min(30rem,42vw)] lg:border-l"
      aria-label="Alert rule detail"
    >
      <header className="shrink-0 border-b border-[var(--line)] px-6 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone={rule.enabled ? "live" : "neutral"}>
                {rule.enabled ? "on" : "off"}
              </StatusChip>
              {rule.triage_enabled ? (
                <span className="type-meta">auto-triage</span>
              ) : null}
            </div>
            <h2 className="type-title text-[var(--text)] !text-[1.2rem] !leading-snug">
              {rule.name}
            </h2>
          </div>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon shrink-0"
            onClick={onClose}
            aria-label="Close alert rule detail"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className={cn(
              "ds-btn ds-btn-sm",
              rule.enabled ? "ds-btn-ghost" : "ds-btn-primary",
            )}
            disabled={!canAuthor || busy}
            title={canAuthor ? undefined : "Admin role required"}
            onClick={() => onToggleEnabled(!rule.enabled)}
          >
            {rule.enabled ? "Turn off" : "Turn on"}
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            disabled={!canAuthor || busy}
            title={canAuthor ? undefined : "Admin role required"}
            onClick={onEdit}
          >
            Edit
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm text-[var(--error)]"
            disabled={!canAuthor || busy}
            title={canAuthor ? undefined : "Admin role required"}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-6">
        <section className="space-y-2 rounded-[var(--radius-lg)] bg-[var(--accent-muted)] px-4 py-4">
          <h3 className="type-label">Rule text</h3>
          <p className="type-ui text-[var(--text)]">{rule.nl_text}</p>
        </section>
        <section className="space-y-2">
          <h3 className="type-label">Compiled EQL</h3>
          <pre className="type-mono overflow-x-auto rounded-[var(--radius)] bg-[var(--accent-muted)] px-3 py-2 !text-[0.6875rem]">
            {rule.compiled_eql}
          </pre>
        </section>
        <dl className="grid grid-cols-2 gap-4 border-t border-[var(--line)] pt-4">
          <div>
            <p className="type-label">Last fired</p>
            <p className="type-mono mt-1 !text-[var(--text)]">
              {rule.last_fired_at || "—"}
            </p>
          </div>
          <div>
            <p className="type-label">Created</p>
            <p className="type-mono mt-1 !text-[var(--text)]">
              {rule.created_at || "—"}
            </p>
          </div>
        </dl>
      </div>
    </aside>
  );
}

type DialogPhase = "compose" | "review";

/** Create/edit dialog: free text → Compile → review compiled EQL → Save. */
function RuleDialog({
  open,
  mode,
  rule,
  orgId,
  onClose,
  onCreate,
  onUpdate,
}: {
  open: boolean;
  mode: "create" | "edit";
  rule: NLAlertRule | null;
  orgId: string | null;
  onClose: () => void;
  onCreate: (body: NLRuleCreateBody) => Promise<void>;
  onUpdate: (ruleId: string, body: NLRuleUpdateBody) => Promise<void>;
}) {
  const [phase, setPhase] = useState<DialogPhase>("compose");
  const [nlText, setNlText] = useState("");
  const [compiled, setCompiled] = useState<CompileNlAlertResponse | null>(null);
  const [name, setName] = useState("");
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>("warning");
  const [intervalMinutes, setIntervalMinutes] = useState("60");
  const [triageEnabled, setTriageEnabled] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setCompiling(false);
    setSaving(false);
    if (mode === "edit" && rule) {
      setNlText(rule.nl_text);
      setCompiled({
        eql: rule.compiled_eql,
        warnings: [],
        rule: {},
        suggested_name: rule.name,
      });
      setName(rule.name);
      setTriageEnabled(rule.triage_enabled);
      setEnabled(rule.enabled);
      setSeverity("warning");
      setIntervalMinutes("60");
      setPhase("review");
    } else {
      setNlText("");
      setCompiled(null);
      setName("");
      setSeverity("warning");
      setIntervalMinutes("60");
      setTriageEnabled(true);
      setEnabled(true);
      setPhase("compose");
    }
  }, [open, mode, rule]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function compile() {
    if (!nlText.trim()) {
      setError("Describe the alert first.");
      return;
    }
    if (!orgId) {
      setError("Select a workspace first.");
      return;
    }
    setCompiling(true);
    setError(null);
    try {
      const result = await nlAlertRulesApi.compile(orgId, {
        nl_text: nlText.trim(),
      });
      setCompiled(result);
      if (!name.trim()) setName(result.suggested_name || nlText.trim().slice(0, 60));
      setPhase("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Compile failed. Try again.");
    } finally {
      setCompiling(false);
    }
  }

  async function save() {
    if (!compiled) return;
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    const intervalSeconds = Number(intervalMinutes) * 60;
    if (mode === "create" && (!Number.isFinite(intervalSeconds) || intervalSeconds < 60)) {
      setError("Check interval must be at least 1 minute.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (mode === "edit" && rule) {
        await onUpdate(rule.id, {
          name: name.trim(),
          nl_text: nlText.trim(),
          compiled_eql: compiled.eql,
          triage_enabled: triageEnabled,
          enabled,
        });
      } else {
        await onCreate({
          name: name.trim(),
          nl_text: nlText.trim(),
          compiled_eql: compiled.eql,
          triage_enabled: triageEnabled,
          enabled,
          severity,
          interval_seconds: intervalSeconds,
        });
      }
      onClose();
    } catch (err) {
      setError(permissionDeniedMessage(err, "Couldn't save the alert rule."));
    } finally {
      setSaving(false);
    }
  }

  const title = mode === "edit" ? "Edit alert rule" : "New alert rule";

  return (
    <div
      className="fixed inset-0 z-[70] flex items-stretch justify-center bg-[var(--scrim)] p-3 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="nl-alert-rule-title"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-2xl flex-col overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg)] shadow-[0_0_0_1px_var(--line)] sm:h-auto sm:max-h-[min(42rem,92dvh)]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--line)] px-6 py-5 sm:px-8">
          <h2 id="nl-alert-rule-title" className="type-title text-[var(--text)] !text-[1.35rem]">
            {title}
          </h2>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon shrink-0"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-6 sm:px-8">
          <label className="block space-y-2">
            <span className="type-label">Alert me when…</span>
            <textarea
              className="ds-input min-h-[7rem] w-full resize-y !h-auto px-4 py-3 !text-[0.9375rem] !leading-relaxed"
              value={nlText}
              onChange={(e) => {
                setNlText(e.target.value);
                setError(null);
              }}
              placeholder="error rate exceeds 5% in the last hour"
              autoFocus={mode === "create"}
            />
            <div className="flex justify-end">
              <button
                type="button"
                className="ds-btn ds-btn-sm"
                disabled={compiling}
                onClick={() => void compile()}
              >
                {compiling ? "Compiling…" : compiled ? "Recompile" : "Compile"}
              </button>
            </div>
          </label>

          {phase === "review" && compiled ? (
            <div className="space-y-5 border-t border-[var(--line)] pt-5">
              <section className="space-y-2">
                <h3 className="type-label">Compiled EQL</h3>
                <pre className="type-mono overflow-x-auto rounded-[var(--radius)] bg-[var(--accent-muted)] px-3 py-2 !text-[0.75rem]">
                  {compiled.eql}
                </pre>
              </section>

              {compiled.warnings.length > 0 ? (
                <section className="space-y-1.5">
                  <h3 className="type-label text-[var(--warn)]">Warnings</h3>
                  <ul className="space-y-1">
                    {compiled.warnings.map((w, i) => (
                      <li key={i} className="type-meta text-[var(--text-secondary)]">
                        {w}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <label className="block space-y-1.5">
                <span className="type-label">Name</span>
                <input
                  className="ds-input w-full"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(null);
                  }}
                />
              </label>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block space-y-1.5">
                  <span className="type-label">Severity</span>
                  <select
                    className="ds-input w-full"
                    value={severity}
                    disabled={mode === "edit"}
                    title={mode === "edit" ? "Severity is set at creation" : undefined}
                    onChange={(e) =>
                      setSeverity(e.target.value as (typeof SEVERITIES)[number])
                    }
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                {mode === "create" ? (
                  <label className="block space-y-1.5">
                    <span className="type-label">Check interval (minutes)</span>
                    <input
                      className="ds-input w-full"
                      type="number"
                      min={1}
                      step={1}
                      value={intervalMinutes}
                      onChange={(e) => setIntervalMinutes(e.target.value)}
                    />
                  </label>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-5">
                <label className="flex items-center gap-2 type-ui text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={triageEnabled}
                    onChange={(e) => setTriageEnabled(e.target.checked)}
                  />
                  Auto-triage fired alerts
                </label>
                <label className="flex items-center gap-2 type-ui text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                  />
                  Enabled
                </label>
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="type-meta text-[var(--error)]" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--line)] px-6 py-4 sm:px-8">
          <button type="button" className="ds-btn ds-btn-ghost ds-btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            disabled={!compiled || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Full NL Alert Rules view, rendered by the /signals page at `?mode=nl-alerts`. */
export function NlAlertRulesView() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const canAuthor = useCanAuthorAlertRules();
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();
  const confirm = useConfirm();

  const rulesQuery = useOrgQuery(
    queryKeys.portal.nlAlertRules(orgId),
    orgId,
    () => nlAlertRulesApi.list(orgId!),
  );
  const rules = rulesQuery.data?.rules ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"create" | "edit">("create");
  const [busyId, setBusyId] = useState<string | null>(null);

  const selected = selectedId ? (rules.find((r) => r.id === selectedId) ?? null) : null;
  const enabledCount = rules.filter((r) => r.enabled).length;

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.portal.nlAlertRules(orgId) });
  }, [queryClient, orgId]);

  const handleCreate = useCallback(
    async (body: NLRuleCreateBody) => {
      if (!orgId) throw new Error("Select a workspace first.");
      const created = await nlAlertRulesApi.create(orgId, body);
      await invalidate();
      pushToast({ title: "Alert rule saved", body: created.name, tone: "ok" });
      setSelectedId(created.id);
    },
    [orgId, invalidate, pushToast],
  );

  const handleUpdate = useCallback(
    async (ruleId: string, body: NLRuleUpdateBody) => {
      if (!orgId) throw new Error("Select a workspace first.");
      const updated = await nlAlertRulesApi.update(orgId, ruleId, body);
      await invalidate();
      pushToast({ title: "Alert rule updated", body: updated.name, tone: "ok" });
      setSelectedId(updated.id);
    },
    [orgId, invalidate, pushToast],
  );

  const handleToggleEnabled = useCallback(
    async (rule: NLAlertRule, nextEnabled: boolean) => {
      if (!orgId) return;
      setBusyId(rule.id);
      try {
        await nlAlertRulesApi.update(orgId, rule.id, { enabled: nextEnabled });
        await invalidate();
      } catch (err) {
        pushToast({
          title: nextEnabled ? "Couldn't enable rule" : "Couldn't disable rule",
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
    async (rule: NLAlertRule) => {
      if (!orgId) return;
      const ok = await confirm(`Delete "${rule.name}"? This can't be undone.`);
      if (!ok) return;
      setBusyId(rule.id);
      try {
        await nlAlertRulesApi.delete(orgId, rule.id);
        await invalidate();
        if (selectedId === rule.id) setSelectedId(null);
        pushToast({ title: "Alert rule deleted", body: rule.name, tone: "ok" });
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
    [orgId, invalidate, pushToast, confirm, selectedId],
  );

  const header = (
    <PageHeader
      title="Alert rules"
      meta={
        <span className="type-meta">
          {enabledCount} on · {rules.length} total
          {!canAuthor ? " · read-only" : ""}
        </span>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <SignalsModeToggle mode="nl-alerts" />
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            disabled={!canAuthor}
            title={canAuthor ? undefined : "Admin role required to create alert rules"}
            onClick={() => {
              setDialogMode("create");
              setDialogOpen(true);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            Create rule
          </button>
        </div>
      }
    />
  );

  if (!orgId) {
    return (
      <NoWorkspaceGuard title="Alert rules" message="Select a workspace to view alert rules." />
    );
  }

  if (rulesQuery.isLoading) {
    return (
      <div className="ds-page">
        {header}
        <QueryLoadingPanel label="Loading alert rules…" />
      </div>
    );
  }

  if (rulesQuery.isError) {
    return (
      <div className="ds-page">
        {header}
        <QueryErrorPanel error={rulesQuery.error} onRetry={() => void rulesQuery.refetch()} />
      </div>
    );
  }

  return (
    <div className="ds-page">
      {header}
      {!canAuthor ? (
        <p className="type-meta border-b border-[var(--line)] px-5 py-2 text-[var(--text-faint)]">
          You have read-only access to alert rules. Ask an org admin or owner to create,
          edit, or delete rules.
        </p>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            selected ? "hidden lg:flex" : "flex",
          )}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rules.length === 0 ? (
              <EmptyState
                title="No alert rules yet"
                body="Describe the condition in plain English — Eden compiles it into a query and keeps watching."
                action={
                  canAuthor ? (
                    <button
                      type="button"
                      className="ds-btn ds-btn-primary ds-btn-sm"
                      onClick={() => {
                        setDialogMode("create");
                        setDialogOpen(true);
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Create rule
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <ul role="list" aria-label="Alert rules">
                {rules.map((rule) => (
                  <li key={rule.id}>
                    <RuleRow
                      rule={rule}
                      active={rule.id === selected?.id}
                      onSelect={() => setSelectedId(rule.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {selected ? (
          <RuleDetail
            rule={selected}
            canAuthor={canAuthor}
            busy={busyId === selected.id}
            onClose={() => setSelectedId(null)}
            onEdit={() => {
              setDialogMode("edit");
              setDialogOpen(true);
            }}
            onDelete={() => void handleDelete(selected)}
            onToggleEnabled={(nextEnabled) => void handleToggleEnabled(selected, nextEnabled)}
          />
        ) : null}
      </div>

      <RuleDialog
        open={dialogOpen}
        mode={dialogMode}
        rule={dialogMode === "edit" ? selected : null}
        orgId={orgId}
        onClose={() => setDialogOpen(false)}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
      />
    </div>
  );
}
