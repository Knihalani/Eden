"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { PageHeader, StatusChip } from "@/components/ds/primitives";
import { EmptyState } from "@/lab/lab-ui";
import { useQueryPatch } from "@/lab/agent-scope";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import {
  automationsApi,
  type Automation,
  type AutomationCreateBody,
} from "@/lib/api/resources";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { cn } from "@/lib/utils";

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

function AutomationRow({
  automation,
  active,
  onSelect,
}: {
  automation: Automation;
  active: boolean;
  onSelect: () => void;
}) {
  const enabled = automation.enabled !== false;
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
}

function AutomationDetail({
  automation,
  onClose,
}: {
  automation: Automation;
  onClose: () => void;
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
        <p className="type-meta text-[var(--text-faint)]">
          Editing, enable/disable and run history aren&apos;t exposed by the API
          yet — this view is read-only after create.
        </p>
      </div>
    </aside>
  );
}

/** NL-free create dialog — mirrors the detector dialog shell (F61). */
function CreateAutomationDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (body: AutomationCreateBody) => Promise<void>;
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
    setName("");
    setTriggerType("score_threshold");
    setThreshold("0.5");
    setActionType("dataset");
    setAdvanced("");
    setError(null);
    setBusy(false);
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
      await onCreate({
        name: name.trim(),
        trigger_type: triggerType,
        trigger_config: triggerConfig,
        action_type: actionType,
        action_config: actionConfig,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create automation.");
    } finally {
      setBusy(false);
    }
  }

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
            New automation
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
            {busy ? "Creating…" : "Create"}
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
  const [creating, setCreating] = useState(false);

  const selected = selectedId
    ? automations.find((a) => a.id === selectedId) ?? null
    : null;

  const enabledCount = automations.filter((a) => a.enabled !== false).length;

  const handleCreate = useCallback(
    async (body: AutomationCreateBody) => {
      if (!orgId) throw new Error("Select a workspace first.");
      const created = await automationsApi.create(orgId, body);
      await queryClient.invalidateQueries({ queryKey: automationsKey });
      const id = created.data.automation.id;
      if (id) setSelectedId(id);
    },
    [orgId, queryClient, automationsKey],
  );

  const header = (
    <PageHeader
      title="Automations"
      meta={
        <span className="type-meta">
          {enabledCount} on · {automations.length} total
        </span>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <SignalsModeToggle mode="automations" />
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            onClick={() => setCreating(true)}
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
          <div className="min-h-0 flex-1 overflow-y-auto">
            {automations.length === 0 ? (
              <EmptyState
                title="No automations yet"
                body="Automations react to scored turns — route low-scoring runs to a dataset, ping Slack, or hit a webhook."
                action={
                  <button
                    type="button"
                    className="ds-btn ds-btn-primary ds-btn-sm"
                    onClick={() => setCreating(true)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Create automation
                  </button>
                }
              />
            ) : (
              <ul role="list" aria-label="Automations">
                {automations.map((automation) => (
                  <li key={automation.id}>
                    <AutomationRow
                      automation={automation}
                      active={automation.id === selected?.id}
                      onSelect={() => setSelectedId(automation.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {selected ? (
          <AutomationDetail
            automation={selected}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </div>

      <CreateAutomationDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreate={handleCreate}
      />
    </div>
  );
}
