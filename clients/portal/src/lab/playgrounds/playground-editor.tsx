"use client";

/**
 * U03 playground editor — tasks side by side, per-cell streaming
 * results, char/word diff vs Base, prompt + experiment exit ramps.
 */

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PageHeader, Panel, StatusChip } from "@/components/ds/primitives";
import { useOrgQuery } from "@/hooks/use-api-query";
import { SHELL_QUERY } from "@/lib/portal-query";
import { queryKeys } from "@/lib/query-keys";
import { playgroundApi } from "@/lib/api/resources";
import { promptsV2Api } from "@/lib/api/portal";
import {
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { EmptyState } from "@/lab/lab-ui";
import { useLabToast } from "@/lab/lab-toast";
import { cn } from "@/lib/utils";
import {
  defaultTask,
  newTaskId,
  parsePlaygroundConfig,
  serializePlaygroundConfig,
  type PlaygroundConfigView,
  type PlaygroundMessage,
  type PlaygroundRunSummary,
  type PlaygroundTask,
} from "@/lab/playgrounds/model";
import {
  cellKey,
  initialRunState,
  reduceRunEvent,
  type PlaygroundRunState,
} from "@/lab/playgrounds/run-stream";
import {
  eventsFromPersistedRun,
  streamPlaygroundRun,
} from "@/lab/playgrounds/run-client";
import { diffWords } from "@/lab/playgrounds/diff";

const OUTPUT_CAP = 4000;
const CONCURRENCY_CHOICES = [1, 2, 3, 5, 8, 10];

function capOutput(text: string): string {
  return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}…` : text;
}

function isAbortError(e: unknown): boolean {
  return (
    e instanceof DOMException
      ? e.name === "AbortError"
      : e instanceof Error && e.name === "AbortError"
  );
}

function DiffText({ base, candidate }: { base: string; candidate: string }) {
  const segments = useMemo(
    () => diffWords(capOutput(base), capOutput(candidate)),
    [base, candidate],
  );
  return (
    <span className="whitespace-pre-wrap break-words">
      {segments.map((seg, i) =>
        seg.kind === "same" ? (
          <span key={i}>{seg.text}</span>
        ) : seg.kind === "added" ? (
          <span
            key={i}
            className="rounded-[2px] bg-[color-mix(in_srgb,var(--success)_18%,transparent)] text-[var(--success)]"
          >
            {seg.text}
          </span>
        ) : (
          <span
            key={i}
            className="rounded-[2px] bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error)] line-through opacity-80"
          >
            {seg.text}
          </span>
        ),
      )}
    </span>
  );
}

function ScoreChip({ score }: { score: number | null }) {
  if (score == null) return null;
  return (
    <StatusChip tone={score >= 0.5 ? "ok" : "fail"}>
      {score.toFixed(2)}
    </StatusChip>
  );
}

function MessageEditor({
  message,
  onChange,
  onRemove,
  removable,
}: {
  message: PlaygroundMessage;
  onChange: (next: PlaygroundMessage) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <select
          className="ds-input !h-7 w-auto !py-0 !text-[0.6875rem]"
          value={message.role}
          onChange={(e) =>
            onChange({
              ...message,
              role: e.target.value as PlaygroundMessage["role"],
            })
          }
          aria-label="Message role"
        >
          <option value="system">system</option>
          <option value="user">user</option>
          <option value="assistant">assistant</option>
        </select>
        {removable ? (
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm ml-auto !h-7"
            onClick={onRemove}
            aria-label="Remove message"
          >
            Remove
          </button>
        ) : null}
      </div>
      <textarea
        value={message.content}
        onChange={(e) => onChange({ ...message, content: e.target.value })}
        rows={message.role === "system" ? 3 : 4}
        placeholder={
          message.role === "system"
            ? "System instructions…"
            : "Message — use {{input}} / {{expected}} vars"
        }
        className="ds-input min-h-[4.5rem] w-full resize-y !py-2 !font-[family-name:var(--font-mono)] !text-[0.8125rem] !leading-relaxed"
        aria-label={`${message.role} message`}
      />
    </div>
  );
}

function TaskCard({
  task,
  isBase,
  removable,
  onChange,
  onRemove,
}: {
  task: PlaygroundTask;
  isBase: boolean;
  removable: boolean;
  onChange: (next: PlaygroundTask) => void;
  onRemove: () => void;
}) {
  return (
    <Panel className="space-y-3 !p-4">
      <div className="flex items-center gap-2">
        <input
          value={task.label}
          onChange={(e) => onChange({ ...task, label: e.target.value })}
          className="ds-input !h-8 min-w-0 flex-1 !py-0 !text-[0.8125rem]"
          aria-label="Task label"
        />
        {isBase ? <StatusChip tone="neutral">base</StatusChip> : null}
        {removable ? (
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onRemove}
          >
            Remove
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="col-span-2 block">
          <span className="type-label mb-1 block">Model</span>
          <input
            value={task.model}
            onChange={(e) => onChange({ ...task, model: e.target.value })}
            className="ds-input !h-8 w-full !py-0 !text-[0.75rem]"
            aria-label="Model"
            placeholder="provider/model"
          />
        </label>
        <label className="block">
          <span className="type-label mb-1 block">Temp</span>
          <input
            type="number"
            step="0.1"
            min="0"
            max="2"
            value={task.temperature}
            onChange={(e) =>
              onChange({ ...task, temperature: Number(e.target.value) || 0 })
            }
            className="ds-input !h-8 w-full !py-0 !text-[0.75rem]"
            aria-label="Temperature"
          />
        </label>
        <label className="block">
          <span className="type-label mb-1 block">Max tokens</span>
          <input
            type="number"
            step="1"
            min="1"
            value={task.maxTokens}
            onChange={(e) =>
              onChange({ ...task, maxTokens: Number(e.target.value) || 1024 })
            }
            className="ds-input !h-8 w-full !py-0 !text-[0.75rem]"
            aria-label="Max tokens"
          />
        </label>
      </div>
      <div className="space-y-3">
        {task.messages.map((m, i) => (
          <MessageEditor
            key={i}
            message={m}
            removable={task.messages.length > 1}
            onChange={(next) =>
              onChange({
                ...task,
                messages: task.messages.map((mm, j) => (j === i ? next : mm)),
              })
            }
            onRemove={() =>
              onChange({
                ...task,
                messages: task.messages.filter((_, j) => j !== i),
              })
            }
          />
        ))}
        <button
          type="button"
          className="ds-btn ds-btn-ghost ds-btn-sm"
          onClick={() =>
            onChange({
              ...task,
              messages: [...task.messages, { role: "user", content: "" }],
            })
          }
        >
          + Message
        </button>
      </div>
    </Panel>
  );
}

export function PlaygroundEditor({
  orgId,
  playgroundId,
}: {
  orgId: string;
  playgroundId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();

  const detailQuery = useOrgQuery(
    queryKeys.portal.playgroundDetail(orgId, playgroundId),
    orgId,
    () => playgroundApi.get(orgId, playgroundId),
    { ...SHELL_QUERY, enabled: Boolean(orgId) && Boolean(playgroundId) },
  );
  const playground = detailQuery.data?.playground ?? null;

  const [name, setName] = useState("");
  const [view, setView] = useState<PlaygroundConfigView | null>(null);
  const [dirty, setDirty] = useState(false);
  const hydratedForRef = useRef<string | null>(null);

  // Hydrate editor state when a (new) playground record arrives. Never
  // clobber in-progress local edits on background refetches.
  useEffect(() => {
    if (!playground) return;
    if (hydratedForRef.current === playground.id && dirty) return;
    if (hydratedForRef.current !== playground.id || !dirty) {
      hydratedForRef.current = playground.id;
      setName(playground.name);
      setView(parsePlaygroundConfig(playground.config));
    }
  }, [playground, dirty]);

  const [runState, setRunState] = useState<PlaygroundRunState>(initialRunState);
  const runStateRef = useRef(runState);
  runStateRef.current = runState;
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [diffOn, setDiffOn] = useState(false);
  const [concurrency, setConcurrency] = useState(5);

  const [promptDialogOpen, setPromptDialogOpen] = useState(false);
  const [promptName, setPromptName] = useState("");
  const [promptNote, setPromptNote] = useState("");
  const [promptSaving, setPromptSaving] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [saving, setSaving] = useState(false);

  const patchView = useCallback((update: Partial<PlaygroundConfigView>) => {
    setView((v) => (v ? { ...v, ...update } : v));
    setDirty(true);
  }, []);

  const persist = useCallback(
    async (nextView?: PlaygroundConfigView, opts?: { silent?: boolean }) => {
      const current = nextView ?? view;
      if (!current) return;
      setSaving(true);
      try {
        await playgroundApi.patch(orgId, playgroundId, {
          name: name.trim() || "Untitled playground",
          config: serializePlaygroundConfig(current, playground?.config),
        });
        setDirty(false);
        void queryClient.invalidateQueries({
          queryKey: queryKeys.portal.playgrounds(orgId),
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.portal.playgroundDetail(orgId, playgroundId),
        });
      } catch (e) {
        if (!opts?.silent) {
          pushToast({
            title: "Save failed",
            body: e instanceof Error ? e.message : "Could not save playground.",
            tone: "fail",
          });
        }
      } finally {
        setSaving(false);
      }
    },
    [view, orgId, playgroundId, name, playground?.config, queryClient, pushToast],
  );

  const stopRun = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback(async () => {
    if (!view || running) return;
    setRunning(true);
    // Persist first so the server executes exactly what's on screen.
    await persist(view, { silent: true });

    // Seed every task × row cell as pending so the matrix shows shape
    // immediately and streaming cells fill in progressively.
    const seeded = initialRunState();
    seeded.phase = "streaming";
    for (const task of view.tasks) {
      view.rows.forEach((_, rowIndex) => {
        seeded.cells[cellKey(task.id, rowIndex)] = {
          status: "pending",
          output: "",
          score: null,
          latencyMs: null,
          costUsd: null,
          error: null,
        };
      });
    }
    setRunState(seeded);

    const controller = new AbortController();
    abortRef.current = controller;
    const body = { params: { concurrency } };
    let aborted = false;
    try {
      let sawEvent = false;
      await streamPlaygroundRun({
        orgId,
        playgroundId,
        body,
        signal: controller.signal,
        onEvent: (event) => {
          sawEvent = true;
          setRunState((s) => reduceRunEvent(s, event));
        },
      });
      if (!sawEvent || runStateRef.current.phase !== "done") {
        // Stream closed without per-cell events (older backend) —
        // degrade to the non-streaming run.
        throw new Error("stream ended without done event");
      }
    } catch (e) {
      if (isAbortError(e) || controller.signal.aborted) {
        aborted = true;
        setRunState((s) => ({ ...s, phase: "idle" }));
      } else {
        // Graceful fallback: POST /{id}/run, replay as synthetic events.
        try {
          const res = await playgroundApi.runPersisted(orgId, playgroundId, body);
          setRunState(() => {
            let s = seeded;
            for (const event of eventsFromPersistedRun(res.run)) {
              s = reduceRunEvent(s, event);
            }
            return s;
          });
        } catch (fallbackErr) {
          setRunState((s) => ({ ...s, phase: "error" }));
          pushToast({
            title: "Run failed",
            body:
              fallbackErr instanceof Error
                ? fallbackErr.message
                : "Both streaming and fallback runs failed.",
            tone: "fail",
          });
        }
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }

    // Record a history entry once a run completed (not on Stop).
    const finalState = runStateRef.current;
    if (!aborted && finalState.phase === "done") {
      const cells = Object.values(finalState.cells);
      const totalsCost =
        finalState.totals &&
        typeof finalState.totals.cost_usd === "number"
          ? (finalState.totals.cost_usd as number)
          : cells.reduce<number | null>(
              (sum, c) =>
                c.costUsd != null ? (sum ?? 0) + c.costUsd : sum,
              null,
            );
      const summary: PlaygroundRunSummary = {
        runId: finalState.runId,
        at: new Date().toISOString(),
        costUsd: totalsCost,
        cells: cells.length,
        errors: cells.filter((c) => c.status === "error").length,
      };
      setView((v) => {
        if (!v) return v;
        const nextView = { ...v, runs: [...v.runs, summary].slice(-20) };
        void persist(nextView, { silent: true });
        return nextView;
      });
    }
  }, [view, running, persist, concurrency, orgId, playgroundId, pushToast]);

  const openSavePrompt = useCallback(() => {
    setPromptName((n) => n || name.trim().toLowerCase().replace(/\s+/g, "-"));
    setPromptDialogOpen(true);
  }, [name]);

  async function savePrompt() {
    if (!view || promptSaving) return;
    const target = promptName.trim();
    if (!target) return;
    const base = view.tasks[0];
    const template = base.messages
      .filter((m) => m.content.trim())
      .map((m) =>
        base.messages.length > 1 ? `### ${m.role}\n${m.content}` : m.content,
      )
      .join("\n\n");
    setPromptSaving(true);
    try {
      // Create is idempotent-ish for our purposes: if the prompt already
      // exists we just add a version to it.
      try {
        await promptsV2Api.create(orgId, { name: target });
      } catch {
        /* prompt exists — fall through to createVersion */
      }
      await promptsV2Api.createVersion(orgId, target, {
        template,
        model: base.model,
        params: { temperature: base.temperature, max_tokens: base.maxTokens },
        variables: ["input", "expected"],
        change_note: promptNote.trim() || null,
      });
      setPromptDialogOpen(false);
      setPromptNote("");
      pushToast({
        title: "Prompt version saved",
        body: `Saved base task as “${target}”.`,
        href: "/prompts",
        tone: "ok",
      });
    } catch (e) {
      pushToast({
        title: "Save prompt failed",
        body: e instanceof Error ? e.message : "Could not save prompt version.",
        tone: "fail",
      });
    } finally {
      setPromptSaving(false);
    }
  }

  async function promote() {
    if (promoting) return;
    setPromoting(true);
    try {
      await playgroundApi.promoteExperiment(orgId, playgroundId, {
        name: name.trim() || undefined,
        dataset_id: view?.datasetId ?? undefined,
      });
      pushToast({
        title: "Experiment created",
        body: "Immutable snapshot promoted — Evals will score it with the heuristic stub, not a real graded eval.",
        href: "/evals?mode=compare",
        tone: "ok",
      });
    } catch (e) {
      pushToast({
        title: "Promote failed",
        body: e instanceof Error ? e.message : "Could not create experiment.",
        tone: "fail",
      });
    } finally {
      setPromoting(false);
    }
  }

  // ⌘⏎ run · ⌘S save prompt · ⌘D diff toggle. Combos only — plain keys
  // inside inputs/textareas are never intercepted.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (running) return;
        void run();
      } else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        openSavePrompt();
      } else if (e.key.toLowerCase() === "d") {
        e.preventDefault();
        setDiffOn((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [run, running, openSavePrompt]);

  if (detailQuery.isError) {
    return (
      <div className="ds-page">
        <PageHeader title="Playground" />
        <QueryErrorPanel
          error={detailQuery.error}
          onRetry={() => void detailQuery.refetch()}
        />
      </div>
    );
  }
  if (detailQuery.isLoading || !view) {
    return (
      <div className="ds-page">
        <PageHeader title="Playground" />
        <QueryLoadingPanel label="Loading playground…" />
      </div>
    );
  }

  const baseTask = view.tasks[0];
  const baseOutputs = view.rows.map(
    (_, i) => runState.cells[cellKey(baseTask.id, i)]?.output ?? "",
  );
  const hasResults = Object.keys(runState.cells).length > 0;

  return (
    <div className="ds-page">
      <PageHeader
        title="Playground"
        meta={
          <span className="flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
              onBlur={() => {
                if (dirty) void persist();
              }}
              className="ds-input !h-8 w-48 !py-0 !text-[0.8125rem] sm:w-64"
              aria-label="Playground name"
            />
            {dirty ? <StatusChip tone="neutral">unsaved</StatusChip> : null}
          </span>
        }
        actions={
          <>
            <Link href="/playgrounds" className="ds-btn ds-btn-ghost ds-btn-sm">
              All playgrounds
            </Link>
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              disabled={saving}
              onClick={() => void persist()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              onClick={openSavePrompt}
              title="Save base task as a prompt version (⌘S)"
            >
              Save Prompt
            </button>
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              disabled={promoting}
              onClick={() => void promote()}
              title="Creates an experiment scored by the heuristic stub — not a real graded eval."
            >
              {promoting ? "Promoting…" : "+ Experiment"}
            </button>
          </>
        }
      />

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-5">
        {/* Tasks */}
        <section>
          <div className="mb-2 flex items-center gap-2">
            <p className="type-label">Tasks</p>
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm ml-auto"
              onClick={() =>
                patchView({
                  tasks: [
                    ...view.tasks,
                    {
                      ...baseTask,
                      id: newTaskId(),
                      label: `Compare ${view.tasks.length}`,
                      messages: baseTask.messages.map((m) => ({ ...m })),
                    },
                  ],
                })
              }
            >
              + Compare task
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {view.tasks.map((task, i) => (
              <TaskCard
                key={task.id}
                task={task}
                isBase={i === 0}
                removable={view.tasks.length > 1 && i > 0}
                onChange={(next) =>
                  patchView({
                    tasks: view.tasks.map((t) => (t.id === task.id ? next : t)),
                  })
                }
                onRemove={() =>
                  patchView({
                    tasks: view.tasks.filter((t) => t.id !== task.id),
                  })
                }
              />
            ))}
          </div>
        </section>

        {/* Rows */}
        <section>
          <div className="mb-2 flex items-center gap-2">
            <p className="type-label">Rows</p>
            <span className="type-meta">
              {"{{input}} / {{expected}} fill into task messages"}
            </span>
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm ml-auto"
              onClick={() =>
                patchView({ rows: [...view.rows, { input: "" }] })
              }
            >
              + Row
            </button>
          </div>
          <div className="space-y-2">
            {view.rows.map((row, i) => (
              <Panel key={i} muted className="!p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className="type-label mb-1 block">Input · row {i + 1}</span>
                    <textarea
                      value={row.input}
                      onChange={(e) =>
                        patchView({
                          rows: view.rows.map((r, j) =>
                            j === i ? { ...r, input: e.target.value } : r,
                          ),
                        })
                      }
                      rows={2}
                      className="ds-input w-full resize-y !py-2 !text-[0.8125rem]"
                      aria-label={`Row ${i + 1} input`}
                    />
                  </label>
                  <label className="block">
                    <span className="type-label mb-1 block">Expected (optional)</span>
                    <textarea
                      value={row.expected ?? ""}
                      onChange={(e) =>
                        patchView({
                          rows: view.rows.map((r, j) =>
                            j === i
                              ? { ...r, expected: e.target.value || undefined }
                              : r,
                          ),
                        })
                      }
                      rows={2}
                      className="ds-input w-full resize-y !py-2 !text-[0.8125rem]"
                      aria-label={`Row ${i + 1} expected`}
                    />
                  </label>
                </div>
                {view.rows.length > 1 ? (
                  <button
                    type="button"
                    className="ds-btn ds-btn-ghost ds-btn-sm mt-2"
                    onClick={() =>
                      patchView({ rows: view.rows.filter((_, j) => j !== i) })
                    }
                  >
                    Remove row
                  </button>
                ) : null}
              </Panel>
            ))}
          </div>
        </section>

        {/* Run bar */}
        <section className="flex flex-wrap items-center gap-2 border-y border-[var(--line)] py-3">
          {running ? (
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              onClick={stopRun}
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              onClick={() => void run()}
              title="Run all tasks (⌘⏎)"
            >
              Run ⌘⏎
            </button>
          )}
          <button
            type="button"
            className="ds-tab"
            aria-pressed={diffOn}
            onClick={() => setDiffOn((v) => !v)}
            title="Toggle diff vs Base (⌘D)"
          >
            Diff
          </button>
          <label className="flex items-center gap-1.5">
            <span className="type-label">Concurrency</span>
            <select
              className="ds-input !h-8 w-auto !py-0 !text-[0.75rem]"
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value) || 5)}
              aria-label="Max concurrency"
            >
              {CONCURRENCY_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {running ? (
            <StatusChip tone="live">streaming</StatusChip>
          ) : runState.phase === "done" ? (
            <span className="type-meta">
              Run complete
              {runState.totals &&
              typeof runState.totals.cost_usd === "number"
                ? ` · $${(runState.totals.cost_usd as number).toFixed(4)}`
                : ""}
            </span>
          ) : null}
        </section>

        {/* Results matrix */}
        <section>
          <p className="type-label mb-2">Results</p>
          {!hasResults ? (
            <EmptyState
              compact
              title="No results yet"
              body="Run the matrix to compare task outputs side by side."
            />
          ) : (
            <Panel className="overflow-x-auto !p-0">
              <table className="w-full min-w-[32rem] border-collapse text-left">
                <thead>
                  <tr className="border-b border-[var(--line)]">
                    <th className="type-label px-3 py-2 font-normal">Row</th>
                    {view.tasks.map((t, i) => (
                      <th key={t.id} className="type-label px-3 py-2 font-normal">
                        {t.label}
                        {i === 0 ? " · base" : null}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((row, rowIndex) => (
                    <tr
                      key={rowIndex}
                      className="border-b border-[var(--line)] align-top last:border-b-0"
                    >
                      <td className="type-meta max-w-[10rem] px-3 py-2.5">
                        <span className="block truncate" title={row.input}>
                          {row.input || `Row ${rowIndex + 1}`}
                        </span>
                      </td>
                      {view.tasks.map((task, taskIndex) => {
                        const cell =
                          runState.cells[cellKey(task.id, rowIndex)];
                        if (!cell) {
                          return (
                            <td key={task.id} className="type-meta px-3 py-2.5">
                              —
                            </td>
                          );
                        }
                        return (
                          <td
                            key={task.id}
                            className="min-w-[14rem] px-3 py-2.5"
                          >
                            {cell.status === "pending" ? (
                              <span className="type-meta">queued…</span>
                            ) : cell.status === "error" ? (
                              <div className="space-y-1">
                                <StatusChip tone="fail">error</StatusChip>
                                <p className="type-meta break-words !text-[var(--error)]">
                                  {cell.error ?? "Cell failed."}
                                </p>
                              </div>
                            ) : (
                              <div className="space-y-1.5">
                                <div
                                  className={cn(
                                    "type-body max-h-48 overflow-y-auto whitespace-pre-wrap break-words !text-[0.8125rem]",
                                    cell.status === "running" &&
                                      "animate-pulse text-[var(--text-secondary)]",
                                  )}
                                >
                                  {diffOn &&
                                  taskIndex > 0 &&
                                  baseOutputs[rowIndex] ? (
                                    <DiffText
                                      base={baseOutputs[rowIndex]}
                                      candidate={cell.output}
                                    />
                                  ) : (
                                    capOutput(cell.output) ||
                                    (cell.status === "running" ? "…" : "")
                                  )}
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <ScoreChip score={cell.score} />
                                  <span className="type-meta tabular-nums">
                                    {cell.latencyMs != null
                                      ? `${cell.latencyMs.toLocaleString()} ms`
                                      : null}
                                    {cell.latencyMs != null &&
                                    cell.costUsd != null
                                      ? " · "
                                      : null}
                                    {cell.costUsd != null
                                      ? `$${cell.costUsd.toFixed(4)}`
                                      : null}
                                  </span>
                                </div>
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
        </section>

        {/* History */}
        <section>
          <p className="type-label mb-2">History</p>
          {view.runs.length === 0 ? (
            <p className="type-meta">No runs recorded for this playground yet.</p>
          ) : (
            <Panel className="!p-0">
              <ul className="divide-y divide-[var(--line)]">
                {[...view.runs].reverse().map((r, i) => (
                  <li
                    key={`${r.runId ?? "run"}-${i}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5"
                  >
                    <span className="type-ui text-[var(--text)]">
                      {r.at ? new Date(r.at).toLocaleString() : "Run"}
                    </span>
                    <span className="type-meta">
                      {r.cells} cell{r.cells === 1 ? "" : "s"}
                    </span>
                    {r.errors > 0 ? (
                      <StatusChip tone="fail">{r.errors} failed</StatusChip>
                    ) : (
                      <StatusChip tone="ok">clean</StatusChip>
                    )}
                    <span className="type-value ml-auto tabular-nums">
                      {r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </section>
      </div>

      {/* Save Prompt dialog */}
      {promptDialogOpen ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Save prompt version"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPromptDialogOpen(false);
          }}
        >
          <Panel className="w-full max-w-md space-y-3 !p-5">
            <p className="type-ui text-[var(--text)]">Save Prompt</p>
            <p className="type-meta">
              Saves the Base task template as a new version in the Prompts
              library.
            </p>
            <label className="block">
              <span className="type-label mb-1 block">Prompt name</span>
              <input
                value={promptName}
                onChange={(e) => setPromptName(e.target.value)}
                className="ds-input w-full !h-8 !py-0 !text-[0.8125rem]"
                aria-label="Prompt name"
                autoFocus
              />
            </label>
            <label className="block">
              <span className="type-label mb-1 block">Change note</span>
              <textarea
                value={promptNote}
                onChange={(e) => setPromptNote(e.target.value)}
                rows={2}
                className="ds-input w-full resize-y !py-2 !text-[0.8125rem]"
                aria-label="Change note"
                placeholder="What changed?"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                onClick={() => setPromptDialogOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ds-btn ds-btn-primary ds-btn-sm"
                disabled={promptSaving || !promptName.trim()}
                onClick={() => void savePrompt()}
              >
                {promptSaving ? "Saving…" : "Save version"}
              </button>
            </div>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
