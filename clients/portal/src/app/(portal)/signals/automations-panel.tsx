"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Plus, X } from "lucide-react";
import { PageHeader, StatusChip } from "@/components/ds/primitives";
import { EmptyState } from "@/lab/lab-ui";
import { useQueryPatch } from "@/lab/agent-scope";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { useConfirm } from "@/hooks/use-confirm";
import { useLabToast } from "@/lab/lab-toast";
import {
  automationsApi,
  type Automation,
  type AutomationCreateBody,
  type AutomationRun,
  type AutomationUpdateBody,
} from "@/lib/api/resources";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { cn } from "@/lib/utils";
import { measureVirtualRow, VIRTUAL_SCROLL_ATTR } from "@/lab/virtual-list";

export type SignalsMode = "detectors" | "automations" | "nl-alerts";

/** Detectors ⇄ Automations ⇄ Alert rules tabs (F61/FEAT-18) — no new nav leaf; `?mode=`. */
export function SignalsModeToggle({ mode }: { mode: SignalsMode }) {
  const patchQuery = useQueryPatch();
  return (
    <div role="tablist" aria-label="Signals mode" className="flex items-center gap-1">
      {(
        [
          ["detectors", "Detectors"],
          ["automations", "Automations"],
          ["nl-alerts", "Alert rules"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={mode === id}
          onClick={() => patchQuery({ mode: id === "detectors" ? null : id, id: null })}
          className="ds-tab"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const TRIGGER_TYPES = ["score_threshold", "stumble", "error_rate"] as const;
const ACTION_TYPES = ["dataset", "webhook", "slack"] as const;

const ACTION_NOTES: Record<(typeof ACTION_TYPES)[number], string> = {
  dataset:
    "Promotes the matching trace into a dataset — the most reliable action today.",
  webhook:
    'POSTs to a URL in action config (e.g. { "url": "https://…" }). Best-effort; not for P0 security paging.',
  slack:
    "Sends via a configured Incoming Webhook URL or a connected Slack channel. Best-effort; not for P0 security paging.",
};

/** Row estimate for automation list density; corrected by `measureElement`. */
const AUTOMATION_ROW_ESTIMATE = 56;

/** OPT-51: memo + stable onSelect(id) so virtualised rows skip re-renders. */
const AutomationRow = memo(function AutomationRow({
  automation,
  active,
  onSelect,
}: {
  automation: Automation;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const enabled = automation.enabled !== false;
  const handleClick = useCallback(
    () => onSelect(automation.id),
    [onSelect, automation.id],
  );
  return (
    <button
      type="button"
      onClick={handleClick}
      data-active={active ? "true" : "false"}
      className={cn(
        "flex w-full items-start gap-3 border-b border-[var(--line)] px-4 py-3 text-left transition-colors sm:px-5",
        active
          ? "bg-[var(--accent-muted)] shadow-[inset_2px_0_0_var(--accent)]"
          : "hover:bg-[var(--accent-muted)]",
        !enabled && "opacity-55",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={enabled ? "live" : "neutral"}>
            {enabled ? "on" : "off"}
          </StatusChip>
          <span className="type-meta capitalize">{automation.trigger_type}</span>
        </div>
        <p className="type-ui truncate text-[var(--text)]">{automation.name}</p>
        <p className="type-meta truncate">
          {automation.trigger_type}
          {" → "}
          {automation.action_type}
        </p>
      </div>
    </button>
  );
});

const RUN_STATUS_TONE: Record<string, "live" | "neutral" | "ok" | "fail"> = {
  completed: "ok",
  sent: "ok",
  failed: "fail",
  error: "fail",
};

function RunHistorySection({
  orgId,
  automationId,
}: {
  orgId: string;
  automationId: string;
}) {
  const runsQuery = useOrgQuery(
    ["portal", "automations", orgId, automationId, "runs"] as const,
    orgId,
    () => automationsApi.listRuns(orgId, automationId, 20, 0),
  );
  const runs: AutomationRun[] = runsQuery.data?.data.runs ?? [];

  return (
    <section className="space-y-2">
      <h3 className="type-label">Run history</h3>
      {runsQuery.isLoading ? (
        <p className="type-meta text-[var(--text-faint)]">Loading runs…</p>
      ) : runsQuery.isError ? (
        <p className="type-meta text-[var(--error)]">Couldn&apos;t load run history.</p>
      ) : runs.length === 0 ? (
        <p className="type-meta text-[var(--text-faint)]">
          No runs yet — this automation fires when its trigger condition matches a
          scored trace.
        </p>
      ) : (
        <ul role="list" className="space-y-2">
          {runs.map((run) => (
            <li
              key={run.id}
              className="space-y-1 rounded-[var(--radius)] bg-[var(--accent-muted)] px-3 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <StatusChip tone={RUN_STATUS_TONE[run.status] ?? "neutral"}>
                  {run.status}
                </StatusChip>
                <span className="type-meta !text-[0.6875rem] text-[var(--text-faint)]">
                  {run.created_at ? new Date(run.created_at).toLocaleString() : "—"}
                </span>
              </div>
              {run.payload && Object.keys(run.payload).length > 0 ? (
                <pre className="type-mono overflow-x-auto !text-[0.625rem] text-[var(--text-secondary)]">
                  {JSON.stringify(run.payload, null, 2)}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AutomationDetail({
  automation,
  orgId,
  busy,
  onClose,
  onEdit,
  onDelete,
  onToggleEnabled,
}: {
  automation: Automation;
  orgId: string;
  busy?: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}) {
  const enabled = automation.enabled !== false;
  return (
    <aside
      className="flex h-full min-h-0 w-full min-w-0 flex-col border-[var(--line)] bg-[var(--bg)] lg:w-[min(28rem,42vw)] lg:border-l"
      aria-label="Automation detail"
    >
      <header className="shrink-0 border-b border-[var(--line)] px-6 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone={enabled ? "live" : "neutral"}>
                {enabled ? "on" : "off"}
              </StatusChip>
              <span className="type-meta capitalize">{automation.trigger_type}</span>
            </div>
            <h2 className="type-title text-[var(--text)] !text-[1.2rem] !leading-snug">
              {automation.name}
            </h2>
          </div>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon shrink-0"
            onClick={onClose}
            aria-label="Close automation detail"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className={cn("ds-btn ds-btn-sm", enabled ? "ds-btn-ghost" : "ds-btn-primary")}
            disabled={busy}
            onClick={() => onToggleEnabled(!enabled)}
          >
            {enabled ? "Turn off" : "Turn on"}
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            disabled={busy}
            onClick={onEdit}
          >
            Edit
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm text-[var(--error)]"
            disabled={busy}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-6">
        <section className="space-y-2">
          <h3 className="type-label">Trigger</h3>
          <p className="type-ui text-[var(--text)]">{automation.trigger_type}</p>
          <pre className="type-mono overflow-x-auto rounded-[var(--radius)] bg-[var(--accent-muted)] px-3 py-2 !text-[0.6875rem]">
            {JSON.stringify(automation.trigger_config ?? {}, null, 2)}
          </pre>
        </section>
        <section className="space-y-2">
          <h3 className="type-label">Action</h3>
          <p className="type-ui text-[var(--text)]">{automation.action_type}</p>
          <pre className="type-mono overflow-x-auto rounded-[var(--radius)] bg-[var(--accent-muted)] px-3 py-2 !text-[0.6875rem]">
            {JSON.stringify(automation.action_config ?? {}, null, 2)}
          </pre>
        </section>
        <RunHistorySection orgId={orgId} automationId={automation.id} />
      </div>
    </aside>
  );
}

/** Create/edit dialog — mirrors the detector dialog shell (F61 / FEAT-133). */
function AutomationDialog({
  open,
  mode,
  automation,
  onClose,
  onCreate,
  onUpdate,
}: {
  open: boolean;
  mode: "create" | "edit";
  automation: Automation | null;
  onClose: () => void;
  onCreate: (body: AutomationCreateBody) => Promise<void>;
  onUpdate: (id: string, body: AutomationUpdateBody) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] =
    useState<(typeof TRIGGER_TYPES)[number]>("score_threshold");
  const [threshold, setThreshold] = useState("0.5");
  const [actionType, setActionType] =
    useState<(typeof ACTION_TYPES)[number]>("dataset");
  const [advanced, setAdvanced] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    if (mode === "edit" && automation) {
      setName(automation.name);
      const trigger = TRIGGER_TYPES.includes(
        automation.trigger_type as (typeof TRIGGER_TYPES)[number],
      )
        ? (automation.trigger_type as (typeof TRIGGER_TYPES)[number])
        : "score_threshold";
      setTriggerType(trigger);
      const th = automation.trigger_config?.threshold;
      setThreshold(typeof th === "number" ? String(th) : "0.5");
      setActionType(
        ACTION_TYPES.includes(automation.action_type as (typeof ACTION_TYPES)[number])
          ? (automation.action_type as (typeof ACTION_TYPES)[number])
          : "dataset",
      );
      setAdvanced(
        automation.action_config && Object.keys(automation.action_config).length > 0
          ? JSON.stringify(automation.action_config, null, 2)
          : "",
      );
    } else {
      setName("");
      setTriggerType("score_threshold");
      setThreshold("0.5");
      setActionType("dataset");
      setAdvanced("");
    }
  }, [open, mode, automation]);

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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    let triggerConfig: Record<string, unknown> = {};
    let actionConfig: Record<string, unknown> = {};
    if (triggerType === "score_threshold") {
      const t = Number(threshold);
      if (Number.isNaN(t)) {
        setError("Threshold must be a number.");
        return;
      }
      triggerConfig = { threshold: t };
    }
    if (advanced.trim()) {
      try {
        const parsed = JSON.parse(advanced) as Record<string, unknown>;
        actionConfig = parsed;
      } catch {
        setError("Advanced action config must be valid JSON.");
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "edit" && automation) {
        await onUpdate(automation.id, {
          name: name.trim(),
          trigger_type: triggerType,
          trigger_config: triggerConfig,
          action_type: actionType,
          action_config: actionConfig,
        });
      } else {
        await onCreate({
          name: name.trim(),
          trigger_type: triggerType,
          trigger_config: triggerConfig,
          action_type: actionType,
          action_config: actionConfig,
        });
      }
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : mode === "edit"
            ? "Couldn't update automation."
            : "Couldn't create automation.",
      );
    } finally {
      setBusy(false);
    }
  }

  const title = mode === "edit" ? "Edit automation" : "New automation";

  return (
    <div
      className="fixed inset-0 z-[70] flex items-stretch justify-center bg-[var(--scrim)] p-3 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-automation-title"
      onClick={onClose}
    >
      <form
        ref={dialogRef}
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-2xl flex-col overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg)] shadow-[0_0_0_1px_var(--line)] sm:h-auto sm:max-h-[min(40rem,92dvh)]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--line)] px-6 py-5 sm:px-8">
          <h2
            id="create-automation-title"
            className="type-title text-[var(--text)] !text-[1.35rem]"
          >
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
          <label className="block space-y-1.5">
            <span className="type-label">Name</span>
            <input
              className="ds-input w-full"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="e.g. Route low-score turns to review"
              autoFocus
            />
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="type-label">Trigger</span>
              <select
                className="ds-input w-full"
                value={triggerType}
                onChange={(e) =>
                  setTriggerType(e.target.value as (typeof TRIGGER_TYPES)[number])
                }
              >
                {TRIGGER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {triggerType === "score_threshold" ? (
              <label className="block space-y-1.5">
                <span className="type-label">Threshold</span>
                <input
                  className="ds-input w-full"
                  type="number"
                  step="0.05"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  aria-label="Score threshold"
                />
              </label>
            ) : null}
          </div>

          <label className="block space-y-1.5">
            <span className="type-label">Action</span>
            <select
              className="ds-input w-full"
              value={actionType}
              onChange={(e) =>
                setActionType(e.target.value as (typeof ACTION_TYPES)[number])
              }
            >
              {ACTION_TYPES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <p className="type-meta text-[var(--text-faint)]">{ACTION_NOTES[actionType]}</p>
          </label>

          <label className="block space-y-1.5">
            <span className="type-label">Action config (JSON, optional)</span>
            <textarea
              className="ds-input min-h-[6rem] w-full resize-y !h-auto py-2.5 font-mono !text-[0.8125rem]"
              value={advanced}
              onChange={(e) => setAdvanced(e.target.value)}
              placeholder='{ "dataset_id": "…" }'
            />
          </label>

          {error ? (
            <p className="type-meta text-[var(--error)]" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--line)] px-6 py-4 sm:px-8">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button type="submit" className="ds-btn ds-btn-primary ds-btn-sm" disabled={busy}>
            {busy
              ? mode === "edit"
                ? "Saving…"
                : "Creating…"
              : mode === "edit"
                ? "Save"
                : "Create"}
          </button>
        </footer>
      </form>
    </div>
  );
}

/** Full Automations view rendered by the signals page when `?mode=automations`. */
export function AutomationsView() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();
  const confirm = useConfirm();
  const automationsKey = useMemo(
    () => ["portal", "automations", orgId] as const,
    [orgId],
  );
  const automationsQuery = useOrgQuery(
    automationsKey,
    orgId,
    () => automationsApi.list(orgId!),
  );
  const automations = automationsQuery.data?.data.automations ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"create" | "edit">("create");
  const [busyId, setBusyId] = useState<string | null>(null);

  const selected = selectedId
    ? automations.find((a) => a.id === selectedId) ?? null
    : null;

  const enabledCount = automations.filter((a) => a.enabled !== false).length;

  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const listVirtualizer = useVirtualizer({
    count: automations.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => AUTOMATION_ROW_ESTIMATE,
    overscan: 8,
    getItemKey: (index) => automations[index]?.id ?? index,
    measureElement: measureVirtualRow,
  });

  const selectAutomation = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: automationsKey });
  }, [queryClient, automationsKey]);

  const handleCreate = useCallback(
    async (body: AutomationCreateBody) => {
      if (!orgId) throw new Error("Select a workspace first.");
      const created = await automationsApi.create(orgId, body);
      await invalidate();
      const id = created.data.automation.id;
      if (id) setSelectedId(id);
      pushToast({ title: "Automation created", body: created.data.automation.name, tone: "ok" });
    },
    [orgId, invalidate, pushToast],
  );

  const handleUpdate = useCallback(
    async (automationId: string, body: AutomationUpdateBody) => {
      if (!orgId) throw new Error("Select a workspace first.");
      const updated = await automationsApi.update(orgId, automationId, body);
      await invalidate();
      pushToast({ title: "Automation updated", body: updated.data.automation.name, tone: "ok" });
    },
    [orgId, invalidate, pushToast],
  );

  const handleToggleEnabled = useCallback(
    async (automation: Automation, nextEnabled: boolean) => {
      if (!orgId) return;
      setBusyId(automation.id);
      try {
        await automationsApi.toggle(orgId, automation.id, nextEnabled);
        await invalidate();
      } catch (err) {
        pushToast({
          title: nextEnabled ? "Couldn't enable automation" : "Couldn't disable automation",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        });
      } finally {
        setBusyId(null);
      }
    },
    [orgId, invalidate, pushToast],
  );

  const handleDelete = useCallback(
    async (automation: Automation) => {
      if (!orgId) return;
      const ok = await confirm(`Delete "${automation.name}"? This can't be undone.`);
      if (!ok) return;
      setBusyId(automation.id);
      try {
        await automationsApi.remove(orgId, automation.id);
        await invalidate();
        if (selectedId === automation.id) setSelectedId(null);
        pushToast({ title: "Automation deleted", body: automation.name, tone: "ok" });
      } catch (err) {
        pushToast({
          title: "Couldn't delete automation",
          body: err instanceof Error ? err.message : "Try again.",
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
      title="Automations"
      meta={
        <span className="type-meta">
          {enabledCount} on · {automations.length} total · dataset routing is reliable;
          Slack/webhook delivery is best-effort and not for P0 security paging
        </span>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <SignalsModeToggle mode="automations" />
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            onClick={() => {
              setDialogMode("create");
              setDialogOpen(true);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            Create automation
          </button>
        </div>
      }
    />
  );

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Automations"
        message="Select a workspace to view automations."
      />
    );
  }

  if (automationsQuery.isLoading) {
    return (
      <div className="ds-page">
        {header}
        <QueryLoadingPanel label="Loading automations…" />
      </div>
    );
  }

  if (automationsQuery.isError) {
    return (
      <div className="ds-page">
        {header}
        <QueryErrorPanel
          error={automationsQuery.error}
          onRetry={() => void automationsQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="ds-page">
      {header}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            selected ? "hidden lg:flex" : "flex",
          )}
        >
          <div
            ref={listScrollRef}
            className="min-h-0 flex-1 overflow-y-auto"
            {...{ [VIRTUAL_SCROLL_ATTR]: "automations-list" }}
          >
            {automations.length === 0 ? (
              <EmptyState
                title="No automations yet"
                body="Automations react when a scored trace matches a trigger. Dataset routing is reliable; Slack and webhook actions need extra configuration and are best-effort — not for P0 security paging. For monitored alert rules with email delivery, use Alert rules."
                action={
                  <button
                    type="button"
                    className="ds-btn ds-btn-primary ds-btn-sm"
                    onClick={() => {
                      setDialogMode("create");
                      setDialogOpen(true);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Create automation
                  </button>
                }
              />
            ) : (
              <ul
                role="list"
                aria-label="Automations"
                className="relative pb-2"
                style={{ height: `${listVirtualizer.getTotalSize()}px` }}
              >
                {listVirtualizer.getVirtualItems().map((item) => {
                  const automation = automations[item.index];
                  if (!automation) return null;
                  return (
                    <li
                      key={item.key}
                      ref={listVirtualizer.measureElement}
                      data-index={item.index}
                      className="absolute top-0 left-0 w-full min-w-0"
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      <AutomationRow
                        automation={automation}
                        active={automation.id === selected?.id}
                        onSelect={selectAutomation}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {selected ? (
          <AutomationDetail
            automation={selected}
            orgId={orgId}
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

      <AutomationDialog
        open={dialogOpen}
        mode={dialogMode}
        automation={dialogMode === "edit" ? selected : null}
        onClose={() => setDialogOpen(false)}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
      />
    </div>
  );
}
