"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Bell, BellOff, Plus, X } from "lucide-react";
import {
  agentForSignal,
  issuesForSignal,
  tracesForSignal,
  type SignalFixture,
  type SignalKind,
  type SignalSeverity,
} from "@/lab/fixtures/signals";
import { catalogAgents } from "@/lib/portal-catalog";
import { PageHeader, StatusChip } from "@/components/ds/primitives";
import { useAgentScope, useQueryPatch } from "@/lab/agent-scope";
import {
  AgentLink,
  AgentScopeFilter,
  EmptyState,
  FilterChips,
} from "@/lab/lab-ui";
import {
  AlertDestinationEditor,
  defaultDestinationFor,
  formatDestination,
  type AlertChannel,
} from "@/lab/alert-destination";
import { useSignalJobs } from "@/lab/signal-jobs-context";
import { useLabToast } from "@/lab/lab-toast";
import { compileNaturalLanguageFallback } from "@/lab/signal-compile";
import { cn } from "@/lib/utils";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";

type KindFilter = "all" | SignalKind;
type StateFilter = "all" | "on" | "off";

function severityTone(severity: SignalSeverity): "fail" | "neutral" {
  if (severity === "critical" || severity === "error" || severity === "warn") {
    return "fail";
  }
  return "neutral";
}

function SignalCard({
  signal,
  active,
  onSelect,
}: {
  signal: SignalFixture;
  active: boolean;
  onSelect: () => void;
}) {
  const agent = agentForSignal(signal);
  return (
    <button
      type="button"
      onClick={onSelect}
      data-active={active ? "true" : "false"}
      className={cn(
        "flex min-h-[10rem] flex-col items-start rounded-[var(--radius-lg)] p-5 text-left transition-colors",
        "shadow-[0_0_0_1px_var(--line)]",
        active
          ? "bg-[var(--accent-muted)] shadow-[0_0_0_1px_var(--accent)]"
          : "bg-[var(--bg)] hover:bg-[var(--accent-muted)]",
        !signal.enabled && "opacity-55",
      )}
    >
      <div className="flex w-full items-start justify-between gap-2">
        <StatusChip tone={severityTone(signal.severity)}>{signal.severity}</StatusChip>
        <StatusChip tone={signal.enabled ? "live" : "neutral"}>
          {signal.enabled ? "on" : "off"}
        </StatusChip>
      </div>
      <p className="type-ui mt-3 text-[var(--text)]">{signal.name}</p>
      <p className="type-meta mt-1.5 line-clamp-3">{signal.description}</p>
      <p className="type-meta mt-auto pt-4">
        {agent?.name ?? "All agents"}
        {" · "}
        {signal.hits24h} hits / 24h
        {signal.notify && signal.channel && signal.destination
          ? ` · ${formatDestination(signal.channel, signal.destination)}`
          : ""}
      </p>
    </button>
  );
}

function SignalDetail({
  signal,
  onClose,
  onToggleEnabled,
  onPatchNotify,
}: {
  signal: SignalFixture;
  onClose: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onPatchNotify: (patch: {
    notify: boolean;
    channel?: AlertChannel;
    destination?: string;
  }) => void;
}) {
  const agent = agentForSignal(signal);
  const issues = issuesForSignal(signal);
  const traces = tracesForSignal(signal);
  const channel = signal.channel ?? "slack";
  const destination = signal.destination ?? defaultDestinationFor(channel);
  const watching =
    compileNaturalLanguageFallback(signal.description).watching ||
    signal.description;

  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col border-l border-[var(--line)] bg-[var(--bg)] lg:w-[min(28rem,42vw)]"
      aria-label="Signal detail"
    >
      <header className="shrink-0 border-b border-[var(--line)] px-6 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone={severityTone(signal.severity)}>{signal.severity}</StatusChip>
              <StatusChip tone={signal.enabled ? "live" : "neutral"}>
                {signal.enabled ? "on" : "off"}
              </StatusChip>
            </div>
            <h2 className="type-title text-[var(--text)] !text-[1.2rem] !leading-snug">
              {signal.name}
            </h2>
            <p className="type-meta">
              {agent ? (
                <AgentLink agentId={agent.id} name={agent.name} />
              ) : (
                "All agents"
              )}
              <span className="text-[var(--text-faint)]"> · </span>
              <span className="capitalize">{signal.kind}</span>
            </p>
          </div>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon shrink-0"
            onClick={onClose}
            aria-label="Close signal detail"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4">
          <button
            type="button"
            className={cn(
              "ds-btn ds-btn-sm",
              signal.enabled ? "ds-btn-ghost" : "ds-btn-primary",
            )}
            onClick={() => onToggleEnabled(!signal.enabled)}
          >
            {signal.enabled ? "Off" : "On"}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 py-6">
        <section className="space-y-2 rounded-[var(--radius-lg)] bg-[var(--accent-muted)] px-4 py-4">
          <h3 className="type-label">Watching</h3>
          <p className="type-ui text-[var(--text)]">{watching}</p>
        </section>
        <section className="space-y-3 rounded-[var(--radius-lg)] p-4 shadow-[0_0_0_1px_var(--line)]">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="type-ui text-[var(--text)]">Notify</h3>
            <button
              type="button"
              className={cn(
                "ds-btn ds-btn-sm",
                signal.notify ? "ds-btn-ghost" : "ds-btn-primary",
              )}
              onClick={() => {
                if (signal.notify) onPatchNotify({ notify: false });
                else onPatchNotify({ notify: true, channel, destination });
              }}
            >
              {signal.notify ? (
                <>
                  <BellOff className="h-3.5 w-3.5" />
                  Off
                </>
              ) : (
                <>
                  <Bell className="h-3.5 w-3.5" />
                  On
                </>
              )}
            </button>
          </div>
          {signal.notify ? (
            <AlertDestinationEditor
              idPrefix={`signal-${signal.id}`}
              channel={channel}
              destination={destination}
              onChange={({ channel: nextChannel, destination: nextDest }) =>
                onPatchNotify({
                  notify: true,
                  channel: nextChannel,
                  destination: nextDest,
                })
              }
            />
          ) : null}
        </section>
        {(issues[0] || traces[0]) ? (
          <section className="space-y-3">
            <h3 className="type-label">Related</h3>
            <div className="flex flex-wrap gap-2">
              {issues[0] ? (
                <Link
                  href={`/issues?id=${issues[0].id}&agent=${issues[0].agentId}`}
                  className="ds-btn ds-btn-primary ds-btn-sm"
                >
                  Issue
                </Link>
              ) : null}
              {traces[0] ? (
                <Link
                  href={`/traces?id=${traces[0].id}&tab=signals${signal.agentId ? `&agent=${signal.agentId}` : ""}`}
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                >
                  Run
                </Link>
              ) : null}
            </div>
          </section>
        ) : null}
        <dl className="grid grid-cols-2 gap-4 border-t border-[var(--line)] pt-4">
          <div>
            <p className="type-label">Hits (24h)</p>
            <p className="type-mono mt-1 !text-[var(--text)]">{signal.hits24h}</p>
          </div>
          <div>
            <p className="type-label">Last hit</p>
            <p className="type-mono mt-1 !text-[var(--text)]">{signal.lastHit ?? "—"}</p>
          </div>
        </dl>
      </div>
    </aside>
  );
}

/** Modal: NL prompt — starts background compile and closes. */
function CreateSignalDialog({
  open,
  onClose,
  defaultAgentId,
  initialPrompt = "",
}: {
  open: boolean;
  onClose: () => void;
  defaultAgentId: string | null;
  initialPrompt?: string;
}) {
  const { startCompile } = useSignalJobs();
  const [prompt, setPrompt] = useState(initialPrompt);
  const [severity, setSeverity] = useState<SignalSeverity | "auto">("auto");
  const [scope, setScope] = useState<string>(defaultAgentId ?? "all");
  const [notify, setNotify] = useState(false);
  const [channel, setChannel] = useState<AlertChannel>("slack");
  const [destination, setDestination] = useState(defaultDestinationFor("slack"));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPrompt(initialPrompt);
    setSeverity("auto");
    setScope(defaultAgentId ?? "all");
    setNotify(false);
    setChannel("slack");
    setDestination(defaultDestinationFor("slack"));
    setError(null);
  }, [open, defaultAgentId, initialPrompt]);

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

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) {
      setError("Enter a prompt.");
      return;
    }
    startCompile({
      prompt: prompt.trim(),
      agentId: scope === "all" ? null : scope,
      notify,
      channel,
      destination: destination.trim() || defaultDestinationFor(channel),
      severity,
    });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-stretch justify-center bg-black/75 p-3 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-signal-title"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg)] shadow-[0_0_0_1px_var(--line)] sm:h-auto sm:max-h-[min(40rem,92dvh)]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--line)] px-6 py-5 sm:px-8">
          <div className="min-w-0">
            <h2
              id="create-signal-title"
              className="type-title text-[var(--text)] !text-[1.35rem]"
            >
              New signal
            </h2>
          </div>
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
            <span className="type-label">Prompt</span>
            <textarea
              className="ds-input min-h-[12rem] w-full resize-y !h-auto px-4 py-3.5 !text-[0.9375rem] !leading-relaxed"
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                setError(null);
              }}
              placeholder="Catch when…"
              autoFocus
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="type-label">Severity</span>
              <select
                className="ds-input w-full"
                value={severity}
                onChange={(e) =>
                  setSeverity(e.target.value as SignalSeverity | "auto")
                }
              >
                <option value="auto">Auto</option>
                <option value="critical">Critical</option>
                <option value="error">Error</option>
                <option value="warn">Warn</option>
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="type-label">Agents</span>
              <select
                className="ds-input w-full"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="all">All agents</option>
                {catalogAgents().map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="space-y-3 rounded-[var(--radius-lg)] p-4 shadow-[0_0_0_1px_var(--line)]">
            <label className="flex cursor-pointer items-center gap-2.5">
              <input
                type="checkbox"
                checked={notify}
                onChange={(e) => setNotify(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              <span className="type-ui text-[var(--text)]">Notify</span>
            </label>
            {notify ? (
              <AlertDestinationEditor
                idPrefix="create-signal"
                compact
                channel={channel}
                destination={destination}
                onChange={({ channel: nextChannel, destination: nextDest }) => {
                  setChannel(nextChannel);
                  setDestination(nextDest);
                }}
              />
            ) : null}
          </div>

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
          <button type="submit" className="ds-btn ds-btn-primary ds-btn-sm">
            Create
          </button>
        </footer>
      </form>
    </div>
  );
}

/** Verify / edit draft before saving into the catalog. */
function ReviewDraftPanel({
  onApprove,
}: {
  onApprove: (signal: SignalFixture) => void;
}) {
  const {
    pendingReview,
    updatePendingDraft,
    clearPendingReview,
    clearSignalsNavAttention,
  } = useSignalJobs();
  const { pushToast } = useLabToast();

  if (!pendingReview?.draft) return null;
  const job = pendingReview;
  const draft = job.draft!;

  function approve() {
    const id = `sig_${Date.now().toString(36)}`;
    onApprove({
      id,
      name: draft.name,
      description: draft.description,
      kind: draft.kind,
      severity: draft.severity,
      condition: draft.condition,
      agentId: job.agentId,
      enabled: true,
      notify: job.notify,
      channel: job.notify ? job.channel : undefined,
      destination: job.notify ? job.destination : undefined,
      hits24h: 0,
      relatedIssueIds: [],
      exampleTraceIds: [],
    });
    clearPendingReview(job.id);
    clearSignalsNavAttention();
    pushToast({
      title: "Signal saved",
      body: draft.name,
      tone: "ok",
    });
  }

  return (
    <section
      className="shrink-0 border-b border-[var(--accent)] bg-[var(--accent-muted)] px-5 py-5 sm:px-7"
      aria-label="Review AI signal"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="type-title text-[var(--text)] !text-[1.2rem]">
              Review signal
            </h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              onClick={() => clearPendingReview(job.id)}
            >
              Discard
            </button>
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              onClick={approve}
            >
              Approve
            </button>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5 sm:col-span-2">
            <span className="type-label">Name</span>
            <input
              className="ds-input w-full"
              value={draft.name}
              onChange={(e) => updatePendingDraft({ name: e.target.value })}
            />
          </label>
          <label className="block space-y-1.5 sm:col-span-2">
            <span className="type-label">Watching</span>
            <textarea
              className="ds-input min-h-[4.5rem] w-full resize-y !h-auto py-2.5"
              value={draft.watching}
              onChange={(e) => updatePendingDraft({ watching: e.target.value })}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="type-label">Kind</span>
            <select
              className="ds-input w-full"
              value={draft.kind}
              onChange={(e) =>
                updatePendingDraft({ kind: e.target.value as SignalKind })
              }
            >
              <option value="error">Error</option>
              <option value="latency">Latency</option>
              <option value="cost">Cost</option>
              <option value="policy">Policy</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="type-label">Severity</span>
            <select
              className="ds-input w-full"
              value={draft.severity}
              onChange={(e) =>
                updatePendingDraft({
                  severity: e.target.value as SignalSeverity,
                })
              }
            >
              <option value="critical">Critical</option>
              <option value="error">Error</option>
              <option value="warn">Warn</option>
            </select>
          </label>
        </div>
      </div>
    </section>
  );
}

function LabSignalsInner() {
  const searchParams = useSearchParams();
  const paramId = searchParams.get("id");
  const { agentId, setAgentId } = useAgentScope();
  const patchQuery = useQueryPatch();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const signalsQuery = useOrgQuery(
    queryKeys.portal.signals(orgId),
    orgId,
    () => portalApi.signals(orgId!),
  );
  const liveSignals = signalsQuery.data ?? [];
  const {
    pendingReview,
    clearSignalsNavAttention,
    focusReview,
    jobs,
  } = useSignalJobs();

  // Approved-in-session drafts (no create/patch endpoint matching this
  // fixture shape yet) plus local overrides for enable/notify toggles.
  const [localSignals, setLocalSignals] = useState<SignalFixture[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Partial<SignalFixture>>>({});
  const catalog = useMemo(() => {
    const merged = [...localSignals, ...liveSignals];
    return merged.map((s) => (overrides[s.id] ? { ...s, ...overrides[s.id] } : s));
  }, [localSignals, liveSignals, overrides]);
  const [kind, setKind] = useState<KindFilter>("all");
  const [state, setState] = useState<StateFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(paramId);
  const [creating, setCreating] = useState(false);
  const [createPrompt, setCreatePrompt] = useState("");
  const createParam = searchParams.get("create");
  const promptParam = searchParams.get("prompt");

  useEffect(() => {
    setSelectedId(paramId);
  }, [paramId]);

  useEffect(() => {
    clearSignalsNavAttention();
  }, [clearSignalsNavAttention]);

  useEffect(() => {
    if (createParam !== "1" && !promptParam) return;
    setCreatePrompt(promptParam ?? "");
    setCreating(true);
    patchQuery({ create: null, prompt: null });
  }, [createParam, promptParam, patchQuery]);

  const reviewParam = searchParams.get("review");
  useEffect(() => {
    if (reviewParam) focusReview(reviewParam);
  }, [reviewParam, focusReview]);
  const compilingCount = jobs.filter((j) => j.status === "compiling").length;
  const enabledCount = catalog.filter((s) => s.enabled).length;
  const hits24h = catalog.reduce((sum, s) => sum + s.hits24h, 0);

  const agentCounts = useMemo(() => {
    const counts: Record<string, number> = { all: catalog.length };
    for (const s of catalog) {
      if (!s.agentId) continue;
      counts[s.agentId] = (counts[s.agentId] ?? 0) + 1;
    }
    return counts;
  }, [catalog]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((s) => {
      if (agentId !== "all" && s.agentId !== null && s.agentId !== agentId) {
        return false;
      }
      if (kind !== "all" && s.kind !== kind) return false;
      if (state === "on" && !s.enabled) return false;
      if (state === "off" && s.enabled) return false;
      if (!q) return true;
      const agent = agentForSignal(s);
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (agent?.name.toLowerCase().includes(q) ?? false)
      );
    });
  }, [catalog, agentId, kind, state, query]);

  const selected = selectedId
    ? (filtered.find((s) => s.id === selectedId) ??
      catalog.find((s) => s.id === selectedId) ??
      null)
    : null;

  function selectSignal(id: string) {
    setSelectedId(id);
    patchQuery({ id });
  }

  function clearSelection() {
    setSelectedId(null);
    patchQuery({ id: null });
  }

  function patchSignal(id: string, patch: Partial<SignalFixture>) {
    setOverrides((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function handleApprove(signal: SignalFixture) {
    setLocalSignals((prev) => [signal, ...prev]);
    selectSignal(signal.id);
  }

  if (signalsQuery.isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="Detectors" />
        <QueryLoadingPanel label="Loading signals…" />
      </div>
    );
  }

  if (signalsQuery.isError) {
    return (
      <div className="ds-page">
        <PageHeader title="Detectors" />
        <QueryErrorPanel
          error={signalsQuery.error}
          onRetry={() => void signalsQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="ds-page">
      <PageHeader
        title="Detectors"
        meta={
          <span className="type-meta">
            {enabledCount} on · {catalog.length} total · {hits24h} hits / 24h
            {compilingCount > 0 ? ` · ${compilingCount} creating…` : ""}
          </span>
        }
        actions={
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            onClick={() => {
              setCreatePrompt("");
              setCreating(true);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            Create signal
          </button>
        }
      />

      {pendingReview ? <ReviewDraftPanel onApprove={handleApprove} /> : null}

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="lab-list-chrome shrink-0 border-b border-[var(--line)] sm:!flex-row sm:flex-wrap sm:items-end">
            <div className="min-w-[11rem] flex-1 space-y-2 sm:max-w-[14rem]">
              <p className="type-label">Agent</p>
              <AgentScopeFilter
                value={agentId}
                onChange={setAgentId}
                counts={agentCounts}
              />
            </div>
            <div className="min-w-0 flex-[1.4] space-y-2">
              <p className="type-label">Search</p>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                className="ds-input w-full"
                aria-label="Search signals"
              />
            </div>
            <div className="space-y-2">
              <p className="type-label">Kind</p>
              <FilterChips
                value={kind}
                onChange={setKind}
                scroll
                options={[
                  { id: "all", label: "All" },
                  { id: "error", label: "Error" },
                  { id: "latency", label: "Latency" },
                  { id: "cost", label: "Cost" },
                  { id: "policy", label: "Policy" },
                  { id: "custom", label: "Custom" },
                ]}
              />
            </div>
            <div className="space-y-2">
              <p className="type-label">State</p>
              <FilterChips
                value={state}
                onChange={setState}
                options={[
                  { id: "all", label: "Any" },
                  { id: "on", label: "On" },
                  { id: "off", label: "Off" },
                ]}
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-7">
            {filtered.length === 0 ? (
              <EmptyState title="No matching signals" />
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {filtered.map((signal) => (
                  <li key={signal.id}>
                    <SignalCard
                      signal={signal}
                      active={signal.id === selected?.id}
                      onSelect={() => selectSignal(signal.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {selected ? (
          <SignalDetail
            signal={selected}
            onClose={clearSelection}
            onToggleEnabled={(enabled) => patchSignal(selected.id, { enabled })}
            onPatchNotify={(patch) => patchSignal(selected.id, patch)}
          />
        ) : null}
      </div>

      <CreateSignalDialog
        open={creating}
        onClose={() => {
          setCreating(false);
          setCreatePrompt("");
        }}
        defaultAgentId={agentId === "all" ? null : agentId}
        initialPrompt={createPrompt}
      />    </div>
  );
}

export default function LabSignalsPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader title="Detectors" meta={<span className="type-meta">Loading…</span>} />
        </div>
      }
    >
      <LabSignalsInner />
    </Suspense>
  );
}
