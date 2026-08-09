"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, Plus, X } from "lucide-react";
import {
  agentForAlert,
  issueForAlert,
  traceForAlert,
  type AlertEvent,
  type AlertEventStatus,
  type AlertRule,
  type AlertSeverity,
} from "@/lab/fixtures/alerts";
import { StatusChip } from "@/components/ds/primitives";
import { useAlerts } from "@/lab/alerts-context";
import { AgentLink, EmptyState, FilterChips, SeverityBadge } from "@/lab/lab-ui";
import { cn } from "@/lib/utils";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { useConfirm } from "@/hooks/use-confirm";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import {
  alertsApi,
  api,
  type CompileNlAlertResult,
  type NlAlertRule,
  type NlAlertRuleCreateBody,
} from "@/lib/api/resources";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { U20_EMPTY_COPY, U20_FILTER_EMPTY_COPY } from "@/lib/portal-polish";
import { useLabToast } from "@/lab/lab-toast";

type InboxFilter = "actionable" | "firing" | "muted" | "resolved" | "all";
type ModalView = "inbox" | "rules";

const NL_ALERT_SEVERITIES = ["info", "warning", "high", "critical"] as const;

const CLOSE_MS = 220;

/** Catalog miss fallback — prefer a short id over the word "unknown". */
function shortRef(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return "—";
  return trimmed.length > 12 ? `${trimmed.slice(0, 8)}…` : trimmed;
}

function severityTone(severity: AlertSeverity): "fail" | "neutral" {
  if (severity === "critical" || severity === "error" || severity === "warn") {
    return "fail";
  }
  return "neutral";
}

function statusTone(status: AlertEventStatus): "fail" | "neutral" | "ok" {
  if (status === "firing") return "fail";
  if (status === "muted") return "neutral";
  return "ok";
}

function EventRow({
  event,
  active,
  unread,
  onSelect,
}: {
  event: AlertEvent;
  active: boolean;
  unread: boolean;
  onSelect: () => void;
}) {
  const agent = agentForAlert(event);
  return (
    <button
      type="button"
      onClick={onSelect}
      data-active={active ? "true" : "false"}
      data-unread={unread ? "true" : "false"}
      className={cn(
        "relative w-full border-b border-[var(--line)] px-5 py-4 pr-8 text-left transition-colors last:border-b-0",
        active ? "bg-[var(--accent-muted)]" : "hover:bg-[var(--accent-muted)]",
      )}
    >
      {unread ? (
        <span
          className="absolute right-3 top-3 h-2 w-2 rounded-full bg-[var(--accent)]"
          aria-label="Unread"
          title="Unread"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone={severityTone(event.severity)}>{event.severity}</StatusChip>
        <StatusChip tone={statusTone(event.status)}>{event.status}</StatusChip>
        <span className="type-meta ml-auto">{event.firedAt}</span>
      </div>
      <p className="type-ui mt-2 text-[var(--text)]">{event.title}</p>
      <p className="type-meta mt-1">
        {agent?.name ?? shortRef(event.agentId)}
      </p>
      <p className="type-body line-clamp-2">{event.body}</p>
    </button>
  );
}

function EventDetail({
  event,
  rule,
  busy,
  onResolve,
  onReopen,
  onMute,
  onUnmute,
  onCloseModal,
}: {
  event: AlertEvent;
  rule?: AlertRule;
  busy?: boolean;
  onResolve: () => void;
  onReopen: () => void;
  onMute: () => void;
  onUnmute: () => void;
  onCloseModal: () => void;
}) {
  const agent = agentForAlert(event);
  const issue = issueForAlert(event);
  const trace = traceForAlert(event);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-[var(--line)] px-6 py-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone={severityTone(event.severity)}>{event.severity}</StatusChip>
              <StatusChip tone={statusTone(event.status)}>{event.status}</StatusChip>
            </div>
            <h2 className="type-title text-[var(--text)] !text-[1.25rem]">
              {event.title}
            </h2>
            <p className="type-body text-[var(--text-secondary)]">{event.body}</p>
            <p className="type-meta">
              <AgentLink
                agentId={agent?.id ?? event.agentId}
                name={agent?.name ?? shortRef(event.agentId)}
              />
              <span className="text-[var(--text-faint)]"> · </span>
              {event.firedAt}
              {rule ? (
                <>
                  <span className="text-[var(--text-faint)]"> · </span>
                  {rule.name}
                </>
              ) : null}
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {event.status === "firing" ? (
            <>
              <button
                type="button"
                className="ds-btn ds-btn-primary ds-btn-sm"
                disabled={busy}
                onClick={onResolve}
              >
                Resolve
              </button>
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                disabled={busy}
                onClick={onMute}
              >
                Mute
              </button>
            </>
          ) : null}
          {event.status === "muted" ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              disabled={busy}
              onClick={onUnmute}
            >
              Unmute
            </button>
          ) : null}
          {event.status === "resolved" ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              disabled={busy}
              onClick={onReopen}
            >
              Reopen
            </button>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-6 py-6">
        <section className="space-y-3">
          <ul className="space-y-2">
            {issue ? (
              <li>
                <Link
                  href={`/issues?id=${issue.id}`}
                  onClick={onCloseModal}
                  className="flex items-start justify-between gap-3 rounded-[var(--radius)] px-4 py-3 shadow-[0_0_0_1px_var(--line)] transition-colors hover:bg-[var(--accent-muted)]"
                >
                  <div>
                    <p className="type-label">Issue</p>
                    <p className="type-ui mt-1 text-[var(--text)]">{issue.title}</p>
                    <p className="type-meta mt-1">{issue.summary}</p>
                  </div>
                  <SeverityBadge severity={issue.severity} />
                </Link>
              </li>
            ) : event.relatedIssueId ? (
              <li>
                <Link
                  href={`/issues?id=${event.relatedIssueId}`}
                  onClick={onCloseModal}
                  className="block rounded-[var(--radius)] px-4 py-3 shadow-[0_0_0_1px_var(--line)] transition-colors hover:bg-[var(--accent-muted)]"
                >
                  <p className="type-label">Issue</p>
                  <p className="type-ui mt-1 text-[var(--text)]">
                    {shortRef(event.relatedIssueId)}
                  </p>
                </Link>
              </li>
            ) : null}
            {trace ? (
              <li>
                <Link
                  href={`/traces?id=${trace.id}&tab=signals`}
                  onClick={onCloseModal}
                  className="flex items-start justify-between gap-3 rounded-[var(--radius)] px-4 py-3 shadow-[0_0_0_1px_var(--line)] transition-colors hover:bg-[var(--accent-muted)]"
                >
                  <div>
                    <p className="type-label">Run</p>
                    <p className="type-ui mt-1 text-[var(--text)]">{trace.name}</p>
                    <p className="type-meta mt-1">{trace.id}</p>
                  </div>
                  <SeverityBadge severity={trace.severity} />
                </Link>
              </li>
            ) : event.relatedTraceId ? (
              <li>
                <Link
                  href={`/traces?id=${event.relatedTraceId}&tab=signals`}
                  onClick={onCloseModal}
                  className="block rounded-[var(--radius)] px-4 py-3 shadow-[0_0_0_1px_var(--line)] transition-colors hover:bg-[var(--accent-muted)]"
                >
                  <p className="type-label">Run</p>
                  <p className="type-ui mt-1 text-[var(--text)]">
                    {shortRef(event.relatedTraceId)}
                  </p>
                </Link>
              </li>
            ) : null}
            <li>
              <Link
                href={
                  rule?.signalId
                    ? `/signals?id=${rule.signalId}`
                    : "/signals"
                }
                onClick={onCloseModal}
                className="block rounded-[var(--radius)] px-4 py-3 shadow-[0_0_0_1px_var(--line)] transition-colors hover:bg-[var(--accent-muted)]"
              >
                <p className="type-label">Detector</p>
                <p className="type-ui mt-1 text-[var(--text)]">
                  {rule?.name ?? "Detectors"}
                </p>
              </Link>
            </li>
            {agent ? (
              <li>
                <Link
                  href={`/agents?id=${agent.id}`}
                  onClick={onCloseModal}
                  className="block rounded-[var(--radius)] px-4 py-3 shadow-[0_0_0_1px_var(--line)] transition-colors hover:bg-[var(--accent-muted)]"
                >
                  <p className="type-label">Agent</p>
                  <p className="type-ui mt-1 text-[var(--text)]">{agent.name}</p>
                </Link>
              </li>
            ) : event.agentId ? (
              <li>
                <Link
                  href={`/agents?id=${event.agentId}`}
                  onClick={onCloseModal}
                  className="block rounded-[var(--radius)] px-4 py-3 shadow-[0_0_0_1px_var(--line)] transition-colors hover:bg-[var(--accent-muted)]"
                >
                  <p className="type-label">Agent</p>
                  <p className="type-ui mt-1 text-[var(--text)]">
                    {shortRef(event.agentId)}
                  </p>
                </Link>
              </li>
            ) : null}
          </ul>
        </section>

        {rule ? (
          <section className="space-y-3">
            <h3 className="type-ui text-[var(--text)]">Rule</h3>
            <div>
              <p className="type-label">Condition</p>
              <p className="type-ui mt-1.5 text-[var(--text)]">
                {rule.description || rule.condition || event.condition}
              </p>
              {(rule.compiledEql || event.compiledEql) ? (
                <p className="type-mono mt-2 !text-[0.6875rem] text-[var(--text-faint)]">
                  {rule.compiledEql || event.compiledEql}
                </p>
              ) : null}
            </div>
          </section>
        ) : event.condition ? (
          <section className="space-y-3">
            <h3 className="type-ui text-[var(--text)]">Condition</h3>
            <div>
              <p className="type-ui text-[var(--text)]">{event.condition}</p>
              {event.compiledEql ? (
                <p className="type-mono mt-2 !text-[0.6875rem] text-[var(--text-faint)]">
                  {event.compiledEql}
                </p>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function AlertRuleRow({
  rule,
  busy,
  onToggle,
  onDelete,
}: {
  rule: NlAlertRule;
  busy: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-start gap-3 border-b border-[var(--line)] px-5 py-4 last:border-b-0">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={rule.enabled ? "live" : "neutral"}>
            {rule.enabled ? "on" : "off"}
          </StatusChip>
          {rule.severity ? (
            <span className="type-meta capitalize">{rule.severity}</span>
          ) : null}
        </div>
        <p className="type-ui text-[var(--text)]">{rule.name}</p>
        <p className="type-meta line-clamp-2">{rule.nl_text}</p>
        <p className="type-mono line-clamp-1 !text-[0.6875rem] text-[var(--text-faint)]">
          {rule.compiled_eql}
        </p>
        <p className="type-meta text-[var(--text-faint)]">
          {rule.last_fired_at ? `Last fired ${rule.last_fired_at}` : "Never fired"}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <button
          type="button"
          className="ds-btn ds-btn-ghost ds-btn-sm"
          disabled={busy}
          onClick={onToggle}
        >
          {rule.enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          className="ds-btn ds-btn-ghost ds-btn-sm !text-[var(--error)]"
          disabled={busy}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

/** NL-alert authoring dialog — free text in, compiled EQL + delivery config out (FEAT-18). */
function CreateAlertRuleDialog({
  open,
  onClose,
  orgId,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  orgId: string | null;
  onCreate: (body: NlAlertRuleCreateBody) => Promise<void>;
}) {
  const [nlText, setNlText] = useState("");
  const [compiled, setCompiled] = useState<CompileNlAlertResult | null>(null);
  const [name, setName] = useState("");
  const [severity, setSeverity] =
    useState<(typeof NL_ALERT_SEVERITIES)[number]>("warning");
  const [emailOn, setEmailOn] = useState(true);
  const [slackOn, setSlackOn] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState("60");
  const [compiling, setCompiling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setNlText("");
    setCompiled(null);
    setName("");
    setSeverity("warning");
    setEmailOn(true);
    setSlackOn(false);
    setIntervalMinutes("60");
    setCompiling(false);
    setSaving(false);
    setError(null);
  }, [open]);

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

  async function handleCompile(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId) {
      setError("Select a workspace first.");
      return;
    }
    if (nlText.trim().length < 3) {
      setError("Describe the alert in a bit more detail.");
      return;
    }
    setCompiling(true);
    setError(null);
    try {
      const result = await api.compileNlAlert(orgId, { nl_text: nlText.trim() });
      setCompiled(result);
      setName(result.suggested_name || nlText.trim().slice(0, 64));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't compile this rule.");
    } finally {
      setCompiling(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!compiled) return;
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    const minutes = Number(intervalMinutes);
    const intervalSeconds =
      Number.isFinite(minutes) && minutes > 0
        ? Math.max(60, Math.round(minutes * 60))
        : 3600;
    setSaving(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        nl_text: nlText.trim(),
        compiled_eql: compiled.eql,
        severity,
        channels: { email: emailOn, slack: slackOn },
        interval_seconds: intervalSeconds,
        triage_enabled: true,
        enabled: true,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save this rule.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-stretch justify-center bg-[var(--scrim)] p-3 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-alert-rule-title"
      onClick={onClose}
    >
      <form
        onSubmit={compiled ? handleSave : handleCompile}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-2xl flex-col overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg)] shadow-[0_0_0_1px_var(--line)] sm:h-auto sm:max-h-[min(42rem,92dvh)]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--line)] px-6 py-5 sm:px-8">
          <h2
            id="create-alert-rule-title"
            className="type-title text-[var(--text)] !text-[1.35rem]"
          >
            New alert rule
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
          <label className="block space-y-1.5">
            <span className="type-label">Describe the alert</span>
            <textarea
              className="ds-input !h-auto min-h-[6rem] w-full resize-y py-2.5"
              value={nlText}
              onChange={(e) => {
                setNlText(e.target.value);
                setCompiled(null);
                setError(null);
              }}
              placeholder="e.g. Alert me when the error rate exceeds 5% in the last hour"
              autoFocus
              disabled={saving}
            />
          </label>

          {!compiled ? null : (
            <>
              <section className="space-y-2">
                <h3 className="type-label">Compiled query</h3>
                <pre className="type-mono overflow-x-auto rounded-[var(--radius)] bg-[var(--accent-muted)] px-3 py-2 !text-[0.6875rem]">
                  {compiled.eql}
                </pre>
                {compiled.warnings.length > 0 ? (
                  <ul className="space-y-1">
                    {compiled.warnings.map((w, i) => (
                      <li key={i} className="type-meta text-[var(--error)]">
                        {w}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>

              <label className="block space-y-1.5">
                <span className="type-label">Name</span>
                <input
                  className="ds-input w-full"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block space-y-1.5">
                  <span className="type-label">Severity</span>
                  <select
                    className="ds-input w-full"
                    value={severity}
                    onChange={(e) =>
                      setSeverity(
                        e.target.value as (typeof NL_ALERT_SEVERITIES)[number],
                      )
                    }
                  >
                    {NL_ALERT_SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1.5">
                  <span className="type-label">Check interval (minutes)</span>
                  <input
                    className="ds-input w-full"
                    type="number"
                    min={1}
                    value={intervalMinutes}
                    onChange={(e) => setIntervalMinutes(e.target.value)}
                  />
                </label>
              </div>

              <fieldset className="space-y-2">
                <legend className="type-label">Notify via</legend>
                <label className="type-ui flex items-center gap-2 text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={emailOn}
                    onChange={(e) => setEmailOn(e.target.checked)}
                  />
                  Email
                </label>
                <label className="type-ui flex items-center gap-2 text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={slackOn}
                    onChange={(e) => setSlackOn(e.target.checked)}
                  />
                  Slack
                </label>
                <p className="type-meta text-[var(--text-faint)]">
                  Only email delivery is wired up today — Slack selection is
                  saved with the rule but isn&apos;t routed yet.
                </p>
              </fieldset>
            </>
          )}

          {error ? (
            <p className="type-meta text-[var(--error)]" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--line)] px-6 py-4 sm:px-8">
          {compiled ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              disabled={saving}
              onClick={() => setCompiled(null)}
            >
              Back
            </button>
          ) : (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              onClick={onClose}
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            className="ds-btn ds-btn-primary ds-btn-sm"
            disabled={compiled ? saving : compiling}
          >
            {compiled
              ? saving
                ? "Saving…"
                : "Save rule"
              : compiling
                ? "Compiling…"
                : "Preview"}
          </button>
        </footer>
      </form>
    </div>
  );
}

/** Self-serve NL-alert authoring + management (FEAT-18). */
export function AlertRulesView({ orgId }: { orgId: string | null }) {
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const rulesKey = useMemo(() => queryKeys.alerts.nlRules(orgId), [orgId]);
  const rulesQuery = useOrgQuery(rulesKey, orgId, () => api.listNlAlertRules(orgId!));
  const rules = rulesQuery.data?.rules ?? [];

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: rulesKey });
  }, [queryClient, rulesKey]);

  const handleCreate = useCallback(
    async (body: NlAlertRuleCreateBody) => {
      if (!orgId) throw new Error("Select a workspace first.");
      await api.createNlAlertRule(orgId, body);
      await invalidate();
    },
    [orgId, invalidate],
  );

  const handleToggle = useCallback(
    async (rule: NlAlertRule) => {
      if (!orgId) return;
      setBusyId(rule.id);
      try {
        await api.updateNlAlertRule(orgId, rule.id, { enabled: !rule.enabled });
        await invalidate();
      } catch (err) {
        pushToast({
          title: "Couldn't update rule",
          body: err instanceof Error ? err.message : "Try again",
          tone: "fail",
        });
      } finally {
        setBusyId(null);
      }
    },
    [orgId, invalidate, pushToast],
  );

  const handleDelete = useCallback(
    async (rule: NlAlertRule) => {
      if (!orgId) return;
      if (!(await confirm(`Delete alert rule "${rule.name}"? This can't be undone.`))) {
        return;
      }
      setBusyId(rule.id);
      try {
        await api.deleteNlAlertRule(orgId, rule.id);
        await invalidate();
      } catch (err) {
        pushToast({
          title: "Couldn't delete rule",
          body: err instanceof Error ? err.message : "Try again",
          tone: "fail",
        });
      } finally {
        setBusyId(null);
      }
    },
    [orgId, invalidate, pushToast, confirm],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-4 sm:px-7">
        <p className="type-meta">
          {rules.length} rule{rules.length === 1 ? "" : "s"} · describe an alert
          in plain English and eden compiles it to a monitored query · email
          delivery to org admins when rules fire (not P0 security paging)
        </p>
        <button
          type="button"
          className="ds-btn ds-btn-primary ds-btn-sm"
          onClick={() => setCreating(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          New rule
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rulesQuery.isLoading ? (
          <QueryLoadingPanel label="Loading alert rules…" />
        ) : rulesQuery.isError ? (
          <QueryErrorPanel
            error={rulesQuery.error}
            onRetry={() => void rulesQuery.refetch()}
          />
        ) : rules.length === 0 ? (
          <EmptyState
            title="No alert rules yet"
            body='Write a rule like "alert me when error rate exceeds 5% in the last hour" and eden turns it into a monitored query. Fired rules email org admins (best-effort) — not P0 security paging.'
            action={
              <button
                type="button"
                className="ds-btn ds-btn-primary ds-btn-sm"
                onClick={() => setCreating(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                New rule
              </button>
            }
          />
        ) : (
          <ul role="list" aria-label="Alert rules">
            {rules.map((rule) => (
              <AlertRuleRow
                key={rule.id}
                rule={rule}
                busy={busyId === rule.id}
                onToggle={() => void handleToggle(rule)}
                onDelete={() => void handleDelete(rule)}
              />
            ))}
          </ul>
        )}
      </div>

      <CreateAlertRuleDialog
        open={creating}
        onClose={() => setCreating(false)}
        orgId={orgId}
        onCreate={handleCreate}
      />
    </div>
  );
}

export function AlertsModal() {
  const {
    open,
    closeAlerts,
    unreadCount,
    isUnread,
    markRead,
    markAllRead,
  } = useAlerts();

  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();

  const rulesQuery = useOrgQuery(
    queryKeys.portal.alertRules(orgId),
    orgId,
    () => portalApi.alertRules(orgId!),
    { enabled: open },
  );
  const eventsQuery = useOrgQuery(
    queryKeys.portal.alertEvents(orgId),
    orgId,
    () => portalApi.alertEvents(orgId!),
    { enabled: open },
  );
  const liveRules = rulesQuery.data ?? [];
  const events = eventsQuery.data ?? [];

  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [view, setView] = useState<ModalView>("inbox");
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("actionable");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);

  const invalidateEvents = useCallback(async () => {
    if (!orgId) return;
    await queryClient.invalidateQueries({
      queryKey: queryKeys.portal.alertEvents(orgId),
    });
  }, [orgId, queryClient]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
      return () => cancelAnimationFrame(id);
    }
    setVisible(false);
    const t = window.setTimeout(() => setMounted(false), CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  const rules = liveRules;

  const counts = useMemo(() => {
    const firing = events.filter((e) => e.status === "firing").length;
    const muted = events.filter((e) => e.status === "muted").length;
    const resolved = events.filter((e) => e.status === "resolved").length;
    return {
      actionable: firing + muted,
      firing,
      muted,
      resolved,
      all: events.length,
    };
  }, [events]);

  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (inboxFilter === "actionable") {
        return e.status === "firing" || e.status === "muted";
      }
      if (inboxFilter === "firing") return e.status === "firing";
      if (inboxFilter === "muted") return e.status === "muted";
      if (inboxFilter === "resolved") return e.status === "resolved";
      return true;
    });
  }, [events, inboxFilter]);

  const selected = selectedId
    ? (filtered.find((e) => e.id === selectedId) ??
      events.find((e) => e.id === selectedId) ??
      null)
    : null;

  const selectedRule = selected
    ? rules.find((r) => r.id === selected.ruleId)
    : undefined;

  function selectEvent(id: string) {
    setSelectedId(id);
    markRead(id);
  }

  const runAction = useCallback(
    async (
      eventId: string,
      label: string,
      action: () => Promise<unknown>,
    ) => {
      if (!orgId) return;
      setActionBusyId(eventId);
      markRead(eventId);
      try {
        await action();
        await invalidateEvents();
      } catch (err) {
        pushToast({
          title: `Couldn't ${label}`,
          body: err instanceof Error ? err.message : "Try again",
          tone: "fail",
        });
      } finally {
        setActionBusyId(null);
      }
    },
    [orgId, invalidateEvents, markRead, pushToast],
  );

  if (!mounted) return null;

  if (!orgId) {
    return (
      <div
        className="lab-alerts-modal fixed inset-0 z-[70] flex flex-col bg-[var(--bg)] text-[var(--text)]"
        data-state={visible ? "open" : "closed"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="alerts-modal-title"
        aria-hidden={!visible}
      >
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--line)] px-5 py-4 sm:px-7">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-[var(--accent-muted)] text-[var(--accent)]">
              <Bell className="h-4 w-4" strokeWidth={1.7} aria-hidden />
            </span>
            <div className="min-w-0">
              <h1
                id="alerts-modal-title"
                className="type-title text-[var(--text)]"
              >
                Inbox
              </h1>
              <p className="type-meta mt-0.5">
                Select a workspace to view alerts
              </p>
            </div>
          </div>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={closeAlerts}
            aria-label="Close Inbox"
          >
            <X className="h-4 w-4" />
            <span className="hidden sm:inline">Close</span>
          </button>
        </header>
        <EmptyState
          title="No workspace selected"
          body="Select a workspace to view this inbox."
        />
      </div>
    );
  }

  return (
    <div
      className="lab-alerts-modal fixed inset-0 z-[70] flex flex-col bg-[var(--bg)] text-[var(--text)]"
      data-state={visible ? "open" : "closed"}
      role="dialog"
      aria-modal="true"
      aria-labelledby="alerts-modal-title"
      aria-hidden={!visible}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--line)] px-5 py-4 sm:px-7">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-[var(--accent-muted)] text-[var(--accent)]">
            <Bell className="h-4 w-4" strokeWidth={1.7} aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 id="alerts-modal-title" className="type-title text-[var(--text)]">
              {view === "inbox" ? "Inbox" : "Alert rules"}
            </h1>
            <p className="type-meta mt-0.5">
              {view === "inbox"
                ? unreadCount > 0
                  ? `${unreadCount} unread · ${counts.firing} firing`
                  : `${counts.firing} firing`
                : "Self-serve NL-alert authoring"}
            </p>
          </div>
        </div>

        <div role="tablist" aria-label="Alerts view" className="flex items-center gap-1">
          <button
            type="button"
            role="tab"
            aria-selected={view === "inbox"}
            onClick={() => setView("inbox")}
            className="ds-tab"
          >
            Inbox
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "rules"}
            onClick={() => setView("rules")}
            className="ds-tab"
          >
            Rules
          </button>
        </div>

        {view === "inbox" && unreadCount > 0 ? (
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={markAllRead}
          >
            Mark all read
          </button>
        ) : null}

        <button
          type="button"
          className="ds-btn ds-btn-ghost ds-btn-sm"
          onClick={closeAlerts}
          aria-label="Close Inbox"
        >
          <X className="h-4 w-4" />
          <span className="hidden sm:inline">Close</span>
          <kbd className="type-mono ml-1 hidden rounded border border-[var(--line)] px-1 !text-[0.625rem] !text-[var(--text-faint)] sm:inline">
            esc
          </kbd>
        </button>
      </header>

      {view === "rules" ? (
        <AlertRulesView orgId={orgId} />
      ) : (
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-full max-w-md shrink-0 flex-col border-r border-[var(--line)] bg-[var(--bg-inset)] sm:max-w-sm lg:max-w-md">
          <div className="shrink-0 space-y-3 border-b border-[var(--line)] px-4 py-4">
            <FilterChips
              value={inboxFilter}
              onChange={setInboxFilter}
              scroll
              options={[
                { id: "actionable", label: "Open", count: counts.actionable },
                { id: "firing", label: "Firing", count: counts.firing },
                { id: "muted", label: "Muted", count: counts.muted },
                { id: "resolved", label: "Resolved", count: counts.resolved },
                { id: "all", label: "All", count: counts.all },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rulesQuery.isError ? (
              <div className="mx-4 mt-3 flex items-center justify-between gap-3 border border-[var(--line)] px-3 py-2">
                <p className="type-meta text-[var(--error)]">
                  Detector rules failed to load — event details may be
                  incomplete.
                </p>
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                  onClick={() => void rulesQuery.refetch()}
                >
                  Retry
                </button>
              </div>
            ) : null}
            {eventsQuery.isLoading ? (
              <QueryLoadingPanel label="Loading Inbox…" />
            ) : eventsQuery.isError ? (
              <QueryErrorPanel
                error={eventsQuery.error}
                onRetry={() => void eventsQuery.refetch()}
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                title={
                  events.length === 0
                    ? "Inbox empty"
                    : inboxFilter === "actionable"
                      ? "Inbox clear"
                      : "No matching events"
                }
                body={
                  events.length === 0
                    ? U20_EMPTY_COPY.alerts
                    : inboxFilter === "actionable"
                      ? U20_EMPTY_COPY.alertsClear
                      : U20_FILTER_EMPTY_COPY.alerts
                }
                action={
                  events.length > 0 && inboxFilter !== "all" ? (
                    <button
                      type="button"
                      className="ds-btn ds-btn-ghost ds-btn-sm mt-4"
                      onClick={() => setInboxFilter("all")}
                    >
                      Show all
                    </button>
                  ) : undefined
                }
              />
            ) : (
              filtered.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  unread={isUnread(event.id)}
                  active={event.id === selected?.id}
                  onSelect={() => selectEvent(event.id)}
                />
              ))
            )}
          </div>
        </aside>

        {filtered.length === 0 ? null : (
          <div className="min-h-0 min-w-0 flex-1 bg-[var(--bg)]">
            {selected && orgId ? (
              <EventDetail
                event={selected}
                rule={selectedRule}
                busy={actionBusyId === selected.id}
                onCloseModal={closeAlerts}
                onResolve={() => {
                  void runAction(selected.id, "resolve", () =>
                    alertsApi.override(orgId, selected.id, "benign"),
                  );
                }}
                onReopen={() => {
                  void runAction(selected.id, "reopen", () =>
                    alertsApi.override(orgId, selected.id, "real_incident"),
                  );
                }}
                onMute={() => {
                  void runAction(selected.id, "mute", () =>
                    alertsApi.acknowledge(orgId, selected.id, true),
                  );
                }}
                onUnmute={() => {
                  void runAction(selected.id, "unmute", () =>
                    alertsApi.acknowledge(orgId, selected.id, false),
                  );
                }}
              />
            ) : (
              <EmptyState
                title="Select an event"
                body="Pick a row to see detector context and take action."
              />
            )}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
