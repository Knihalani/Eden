"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, PanelLeft, PanelLeftClose } from "lucide-react";
import {
  formatDuration,
  formatTokens,
  formatUsd,
  type TraceFixture,
  type TranscriptStep,
} from "@/lab/fixtures/traces";
import { AGENT_LIST, agentForTrace } from "@/lab/fixtures/agents";
import { catalogAgents } from "@/lib/portal-catalog";
import { StatusChip } from "@/components/ds/primitives";
import { useSidebar } from "@/components/shell/sidebar-context";
import { cn } from "@/lib/utils";

export { MetricCell } from "@/lab/lab-metric-cell";

export function NavToggle({ className }: { className?: string }) {
  const { collapsed, toggle } = useSidebar();
  return (
    <button
      type="button"
      onClick={toggle}
      className={cn("ds-btn ds-btn-ghost ds-btn-sm", className)}
      title={collapsed ? "Expand navigation ( [ )" : "Collapse navigation ( [ )"}
      aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
      aria-pressed={collapsed}
    >
      {collapsed ? (
        <PanelLeft className="h-3.5 w-3.5" />
      ) : (
        <PanelLeftClose className="h-3.5 w-3.5" />
      )}
      <span className="hidden sm:inline">Nav</span>
    </button>
  );
}

/** Reveal a collapsed master list — lives in the page header so it never shoves title text. */
export function ListRevealButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ds-btn ds-btn-ghost ds-btn-sm"
      aria-label={`Show ${label}`}
      title={`Show ${label}`}
    >
      <PanelLeft className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

export function SeverityBadge({
  severity,
}: {
  severity: TraceFixture["severity"] | "ok";
}) {
  if (severity === "error" || severity === "warn") {
    return (
      <StatusChip tone="fail">{severity === "warn" ? "warn" : "fail"}</StatusChip>
    );
  }
  return <StatusChip tone="ok">ok</StatusChip>;
}

export function AgentStatusBadge({
  status,
}: {
  status: "live" | "idle" | "error";
}) {
  const tone =
    status === "live" ? "live" : status === "error" ? "fail" : "neutral";
  return <StatusChip tone={tone}>{status}</StatusChip>;
}

export function EmptyState({
  title,
  body,
  action,
  compact,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 text-center",
        compact ? "py-8" : "py-16",
      )}
    >
      <p className="type-ui text-[var(--text)]">{title}</p>
      {body ? <p className="type-body mt-2.5 max-w-sm">{body}</p> : null}
      {action ? (
        <div className={cn(compact ? "mt-3" : "mt-5")}>{action}</div>
      ) : null}
    </div>
  );
}

export function SectionHead({
  title,
  hint,
  meta,
  actions,
}: {
  title: string;
  hint?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-3 border-b border-[var(--line)] px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <h2 className="type-ui text-[var(--text)]">{title}</h2>
        {hint ? <p className="type-meta mt-0.5">{hint}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {meta}
        {actions}
      </div>
    </header>
  );
}

export function RunMeta({ trace }: { trace: TraceFixture }) {
  return (
    <span className="type-mono shrink-0 whitespace-nowrap tabular-nums !text-[0.6875rem] !text-[var(--text-muted)]">
      {formatDuration(trace.durationMs)}
      <span className="mx-1.5 text-[var(--text-faint)]">·</span>
      {formatTokens(trace.tokens)}
      <span className="mx-1.5 text-[var(--text-faint)]">·</span>
      {formatUsd(trace.costUsd, 3)}
    </span>
  );
}

export function RunListButton({
  trace,
  active,
  onSelect,
  showAgent = false,
}: {
  trace: TraceFixture;
  active: boolean;
  onSelect: () => void;
  showAgent?: boolean;
}) {
  const agent = showAgent ? agentForTrace(trace) : undefined;
  return (
    <button
      type="button"
      onClick={onSelect}
      data-run-id={trace.id}
      data-active={active ? "true" : "false"}
      data-severity={trace.severity}
      className="lab-run-row"
    >
      <SeverityBadge severity={trace.severity} />
      <div className="min-w-0 flex-1">
        <p className="type-ui truncate text-[var(--text)]">{trace.name}</p>
        <p className="type-meta mt-1 truncate">
          {showAgent && agent ? `${agent.name} · ` : ""}
          {trace.startedAt}
          {trace.severity !== "none" ? ` · ${trace.signals.title}` : ""}
        </p>
      </div>
      <div className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
        <span className="type-value !text-[0.6875rem]">
          {formatDuration(trace.durationMs)}
        </span>
      </div>
    </button>
  );
}

const KIND_LABEL: Record<TranscriptStep["kind"], string> = {
  task: "Task",
  llm: "LLM",
  tool: "Tool",
  bash: "Bash",
  span: "Span",
};

export function stepKindLabel(kind: TranscriptStep["kind"]): string {
  return KIND_LABEL[kind];
}

export function isBadStep(step: TranscriptStep) {
  return (
    step.status === "error" ||
    Boolean(step.errorMessage) ||
    Boolean(step.outputPreview?.match(/not found|EEXIST|fail|error/i))
  );
}

export function errorStepIds(steps: TranscriptStep[]): string[] {
  return steps.filter(isBadStep).map((s) => s.id);
}

function DetailBlock({
  label,
  children,
  tone,
}: {
  label: string;
  children: ReactNode;
  tone?: "error" | "default";
}) {
  return (
    <div className="min-w-0">
      <p className="type-label mb-1">{label}</p>
      <div
        className={cn(
          "type-mono break-words whitespace-pre-wrap !leading-relaxed",
          tone === "error" ? "!text-[var(--error)]" : "!text-[var(--text-secondary)]",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function StepDetail({ step }: { step: TranscriptStep }) {
  const bad = isBadStep(step);
  const attrs = Object.entries(step.attributes ?? {});
  const meta = Object.entries(step.metadata ?? {});

  return (
    <div className="space-y-4 border-t border-[var(--line)] bg-[var(--bg-well)] px-4 py-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        {[
          { label: "Kind", value: KIND_LABEL[step.kind] },
          { label: "Status", value: step.status ?? (bad ? "error" : "ok") },
          { label: "Duration", value: formatDuration(step.durationMs) },
          { label: "Started", value: step.startedAt ?? "—" },
          { label: "Span", value: step.spanId ?? step.id },
          { label: "Parent", value: step.parentId ?? "—" },
          { label: "Model", value: step.model ?? "—" },
          { label: "Provider", value: step.provider ?? "—" },
          {
            label: "Tokens in",
            value: step.tokensIn != null ? formatTokens(step.tokensIn) : "—",
          },
          {
            label: "Tokens out",
            value: step.tokensOut != null ? formatTokens(step.tokensOut) : "—",
          },
          {
            label: "Cost",
            value: step.costUsd != null ? formatUsd(step.costUsd, 4) : "—",
          },
          { label: "Step id", value: step.id },
        ].map((row) => (
          <div key={row.label} className="min-w-0">
            <dt className="type-label">{row.label}</dt>
            <dd
              className={cn(
                "type-mono mt-0.5 truncate tabular-nums !text-[var(--text)]",
                row.label === "Status" &&
                  row.value === "error" &&
                  "!text-[var(--error)]",
                row.label === "Status" &&
                  row.value === "ok" &&
                  "!text-[var(--success)]",
              )}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      {step.errorMessage ? (
        <DetailBlock label="Error" tone="error">
          {step.errorMessage}
        </DetailBlock>
      ) : null}

      {step.inputPreview ? (
        <DetailBlock label="Input">{step.inputPreview}</DetailBlock>
      ) : (
        <DetailBlock label="Input">
          <span className="text-[var(--text-faint)]">No input payload captured</span>
        </DetailBlock>
      )}

      {step.outputPreview ? (
        <DetailBlock label="Output" tone={bad ? "error" : "default"}>
          {step.outputPreview}
        </DetailBlock>
      ) : (
        <DetailBlock label="Output">
          <span className="text-[var(--text-faint)]">No output payload captured</span>
        </DetailBlock>
      )}

      {attrs.length > 0 ? (
        <div className="min-w-0">
          <p className="type-label mb-2">Attributes</p>
          <dl className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {attrs.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4 py-2">
                <dt className="type-mono shrink-0 !text-[var(--text-muted)]">{k}</dt>
                <dd className="type-mono min-w-0 truncate text-right !text-[var(--text-secondary)]">
                  {String(v)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {meta.length > 0 ? (
        <div className="min-w-0">
          <p className="type-label mb-2">Metadata</p>
          <dl className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {meta.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4 py-2">
                <dt className="type-mono shrink-0 !text-[var(--text-muted)]">{k}</dt>
                <dd className="type-mono min-w-0 truncate text-right !text-[var(--text-secondary)]">
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

/** Shared expandable transcript — every span opens to full detail. */
export function RunTranscript({
  steps,
  defaultOpenIds,
  compact,
  focusStepId,
  hideToolbar = false,
  openIds: openIdsProp,
  onOpenIdsChange,
}: {
  steps: TranscriptStep[];
  defaultOpenIds?: string[];
  compact?: boolean;
  focusStepId?: string | null;
  /** Hide the internal spans / Expand / Collapse band (parent owns it). */
  hideToolbar?: boolean;
  openIds?: Set<string>;
  onOpenIdsChange?: (next: Set<string>) => void;
}) {
  const [uncontrolledOpenIds, setUncontrolledOpenIds] = useState<Set<string>>(
    () => new Set(defaultOpenIds ?? errorStepIds(steps)),
  );
  const controlled = openIdsProp !== undefined;
  const openIds = controlled ? openIdsProp : uncontrolledOpenIds;

  function setOpenIds(next: Set<string>) {
    if (!controlled) setUncontrolledOpenIds(next);
    onOpenIdsChange?.(next);
  }

  useEffect(() => {
    if (!focusStepId) return;
    if (!openIds.has(focusStepId)) {
      const next = new Set(openIds);
      next.add(focusStepId);
      setOpenIds(next);
    }
    const t = window.setTimeout(() => {
      document
        .querySelector(`[data-step-id="${focusStepId}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 40);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to focus changes
  }, [focusStepId]);

  function toggle(id: string) {
    const next = new Set(openIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenIds(next);
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      {!hideToolbar ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-2">
          <p className="type-label">{steps.length} spans</p>
          <div className="flex gap-1">
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              onClick={() => setOpenIds(new Set(steps.map((s) => s.id)))}
            >
              Expand
            </button>
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              onClick={() => setOpenIds(new Set())}
            >
              Collapse
            </button>
          </div>
        </div>
      ) : null}
      <ol className="min-h-0 min-w-0 overflow-y-auto">
        {steps.map((step, i) => {
          const bad = isBadStep(step);
          const open = openIds.has(step.id);
          const focused = focusStepId === step.id;

          return (
            <li
              key={step.id}
              data-step-id={step.id}
              className={cn(
                "min-w-0 border-b border-[var(--line)]",
                bad && "bg-[var(--error-muted)]",
                focused && "shadow-[inset_2px_0_0_var(--accent)]",
              )}
            >
              <button
                type="button"
                onClick={() => toggle(step.id)}
                className={cn(
                  "flex w-full min-w-0 cursor-pointer items-center gap-2.5 text-left transition-colors hover:bg-[var(--bg-hover)]",
                  compact ? "px-3 py-2" : "px-4 py-2.5",
                  open && "bg-[var(--bg-hover)]",
                )}
                aria-expanded={open}
              >
                <span className="type-mono w-5 shrink-0 tabular-nums !text-[var(--text-faint)]">
                  {i + 1}
                </span>
                <span className="ds-chip shrink-0 border border-[var(--line)] text-[var(--text-muted)]">
                  {KIND_LABEL[step.kind]}
                </span>
                <span
                  className={cn(
                    "type-ui min-w-0 flex-1 truncate !font-normal",
                    bad ? "text-[var(--error)]" : "text-[var(--text)]",
                  )}
                >
                  {step.title}
                </span>
                {!compact && step.tokensIn != null ? (
                  <span className="type-mono hidden shrink-0 tabular-nums !text-[0.6875rem] !text-[var(--text-faint)] md:inline">
                    {formatTokens(step.tokensIn)}
                    {step.tokensOut != null ? ` / ${formatTokens(step.tokensOut)}` : ""}
                  </span>
                ) : null}
                <span className="type-value shrink-0 whitespace-nowrap !text-[0.6875rem]">
                  {step.costUsd != null ? `${formatUsd(step.costUsd, 3)} · ` : ""}
                  {formatDuration(step.durationMs)}
                </span>
                <span className="flex w-3 shrink-0 items-center justify-center text-[var(--text-faint)]">
                  {open ? (
                    <ChevronDown className="h-3 w-3" aria-hidden />
                  ) : (
                    <ChevronRight className="h-3 w-3" aria-hidden />
                  )}
                </span>
              </button>
              {open ? <StepDetail step={step} /> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function FilterChips<T extends string>({
  value,
  onChange,
  options,
  scroll = false,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string; count?: number }[];
  /** Keep chips on one row with horizontal scroll instead of wrapping. */
  scroll?: boolean;
}) {
  return (
    <div
      className={scroll ? "lab-filter-scroll" : "flex flex-wrap gap-1.5"}
      role="tablist"
    >
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          role="tab"
          aria-selected={value === opt.id}
          onClick={() => onChange(opt.id)}
          className="ds-tab"
        >
          {opt.label}
          {opt.count != null ? (
            <span className="ml-1.5 type-value !text-[0.625rem] opacity-80">
              {opt.count}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** Scope a feed to one agent (or all). Compact select — avoids chip walls. */
export function AgentScopeFilter({
  value,
  onChange,
  counts,
}: {
  value: string;
  onChange: (id: string) => void;
  counts?: Record<string, number>;
}) {
  return (
    <label className="block min-w-0">
      <span className="sr-only">Agent</span>
      <select
        className="ds-input w-full"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Filter by agent"
      >
        <option value="all">
          All agents{counts?.all != null ? ` (${counts.all})` : ""}
        </option>
        {(catalogAgents().length > 0 ? catalogAgents() : AGENT_LIST).map(
          (agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
              {counts?.[agent.id] != null ? ` (${counts[agent.id]})` : ""}
            </option>
          ),
        )}
      </select>
    </label>
  );
}

/** Sticky agent section label when browsing All agents. */
export function AgentGroupHeader({
  agent,
  count,
  href,
}: {
  agent: { id: string; name: string };
  count: number;
  href?: string;
}) {
  return (
    <div className="sticky top-0 z-[1] flex items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--bg-inset)] px-4 py-2.5">
      <div className="min-w-0">
        <p className="type-ui truncate !text-[0.8125rem]">
          {agent.name}
        </p>
        <p className="type-meta mt-0.5">
          {count} run{count === 1 ? "" : "s"}
        </p>
      </div>
      {href ? (
        <Link
          href={href}
          className="type-meta shrink-0 text-[var(--accent)] hover:underline"
        >
          Agent
        </Link>
      ) : null}
    </div>
  );
}

export function AgentLink({
  agentId,
  name,
  className,
}: {
  agentId?: string;
  name: string;
  className?: string;
}) {
  if (!agentId) {
    return <span className={className}>{name}</span>;
  }
  return (
    <Link
      href={`/agents?id=${agentId}`}
      className={cn("type-meta text-[var(--text-secondary)] hover:text-[var(--accent)]", className)}
    >
      {name}
    </Link>
  );
}
