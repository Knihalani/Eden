"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useVirtualizer } from "@tanstack/react-virtual";
import { measureVirtualRow, VIRTUAL_SCROLL_ATTR } from "@/lab/virtual-list";
import {
  ChevronDown,
  ChevronRight,
  PanelLeft,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  formatDuration,
  formatTokens,
  formatUsd,
  type TraceFixture,
  type TranscriptStep,
} from "@/lab/fixtures/traces";
import { AGENT_LIST, agentById, agentForTrace } from "@/lab/fixtures/agents";
import {
  agentLaneColor,
  groupParallelSteps,
  parseLazyPayloadMarker,
  type LazyPayloadMarker,
} from "@/lib/observability/build-transcript-rows";
import { formatRelativeTime } from "@/lib/format";
import { agentIssuesApi } from "@/lib/api/resources";
import { useCatalogAgents } from "@/hooks/use-catalog-agents";
import { StatusChip } from "@/components/ds/primitives";
import { cn } from "@/lib/utils";

export { MetricCell } from "@/lab/lab-metric-cell";

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

/**
 * Single site-wide severity vocabulary (Wave 11). All severity chips must
 * go through this so the UI never leaks raw enum fragments ("warn", "ok").
 */
export function severityLabel(
  severity: "critical" | "error" | "warn" | "none" | "ok" | (string & {}),
): string {
  if (severity === "critical") return "Critical";
  if (severity === "error") return "Failed";
  if (severity === "warn") return "Warning";
  if (severity === "none" || severity === "ok") return "OK";
  // Unknown severities pass through rather than inventing a label.
  return severity;
}

export function SeverityBadge({
  severity,
}: {
  severity: TraceFixture["severity"] | "ok";
}) {
  if (severity === "error" || severity === "warn") {
    return <StatusChip tone="fail">{severityLabel(severity)}</StatusChip>;
  }
  return <StatusChip tone="ok">{severityLabel(severity)}</StatusChip>;
}

export function AgentStatusBadge({
  status,
}: {
  status: "live" | "idle" | "error";
}) {
  const tone =
    status === "live" ? "live" : status === "error" ? "fail" : "neutral";
  const label =
    status === "live" ? "active" : status === "error" ? "error" : "idle";
  return <StatusChip tone={tone}>{label}</StatusChip>;
}

export function EmptyState({
  title,
  body,
  action,
  compact,
  icon,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  compact?: boolean;
  /** Optional lucide glyph — gives a zero-data surface a visual anchor. */
  icon?: LucideIcon;
}) {
  const Icon = icon;
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 text-center",
        compact ? "py-8" : "py-16",
      )}
    >
      {Icon ? (
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--bg-inset)]",
            compact ? "mb-3" : "mb-4",
          )}
        >
          <Icon
            className="h-[18px] w-[18px] text-[var(--text-faint)]"
            strokeWidth={1.6}
            aria-hidden
          />
        </div>
      ) : null}
      <p className="type-ui text-[var(--text)]">{title}</p>
      {body ? <p className="type-body mt-2.5 max-w-sm">{body}</p> : null}
      {action ? (
        <div className={cn(compact ? "mt-3" : "mt-5")}>{action}</div>
      ) : null}
    </div>
  );
}

export function RunMeta({ trace }: { trace: TraceFixture }) {
  return (
    <span className="type-mono shrink-0 whitespace-nowrap tabular-nums !text-[0.6875rem] !text-[var(--text-muted)]">
      {formatDuration(trace.durationMs)}
      <span className="mx-1.5 text-[var(--text-faint)]">·</span>
      {formatTokens(trace.tokens)}
      <span className="mx-1.5 text-[var(--text-faint)]">·</span>
      {formatUsd(trace.costUsd, 4)}
    </span>
  );
}

/**
 * Feed row. Memoised — the run lists render thousands of these and the
 * parent re-renders on every selection / filter keystroke. `onSelect`
 * takes the id rather than being a pre-bound closure so the parent can
 * hand down one stable callback for the whole list; a per-row
 * `() => select(t.id)` arrow would change identity every render and
 * defeat the memo entirely.
 */
export const RunListButton = memo(function RunListButton({
  trace,
  active,
  onSelect,
  showAgent = false,
  isBookmarked,
  onToggleBookmark,
}: {
  trace: TraceFixture;
  active: boolean;
  onSelect: (id: string) => void;
  showAgent?: boolean;
  /** W4-6 bookmarks — controlled star state for this row. */
  isBookmarked?: boolean;
  /** W4-6 bookmarks — called with (traceId, nextBookmarked) when the star is clicked. */
  onToggleBookmark?: (traceId: string, next: boolean) => void;
}) {
  const agent = showAgent ? agentForTrace(trace) : undefined;
  const handleClick = useCallback(
    () => onSelect(trace.id),
    [onSelect, trace.id],
  );
  return (
    <button
      type="button"
      onClick={handleClick}
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
          {formatRelativeTime(trace.startedAt)}
          {trace.severity === "error" && trace.signals.body
            ? ` · ${trace.signals.body}`
            : trace.severity !== "none"
              ? ` · ${trace.signals.title}`
              : ""}
        </p>
      </div>
      <div className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
        <span className="type-value !text-[0.6875rem]">
          {formatDuration(trace.durationMs)}
        </span>
        {onToggleBookmark ? (
          <button
            type="button"
            className={cn(
              "flex h-4 w-4 items-center justify-center rounded text-[0.8rem] leading-none transition-colors",
              isBookmarked
                ? "text-[var(--accent)]"
                : "text-[var(--text-muted)] hover:text-[var(--accent)]",
            )}
            aria-label={isBookmarked ? "Remove star" : "Star this trace"}
            title={isBookmarked ? "Remove star" : "Star this trace"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleBookmark(trace.id, !isBookmarked);
            }}
          >
            {isBookmarked ? "★" : "☆"}
          </button>
        ) : null}
      </div>
    </button>
  );
});

const KIND_LABEL: Record<TranscriptStep["kind"], string> = {
  task: "Task",
  llm: "LLM",
  tool: "Tool",
  bash: "Bash",
  span: "Span",
  agent: "Agent",
  handoff: "Handoff",
};

export function stepKindLabel(kind: TranscriptStep["kind"]): string {
  return KIND_LABEL[kind];
}

function agentStepLabel(agentId?: string): string | undefined {
  if (!agentId) return undefined;
  return agentById(agentId)?.name ?? agentId;
}

function agentLaneStyle(agentId?: string): CSSProperties | undefined {
  const color = agentLaneColor(agentId);
  return color ? { borderLeftWidth: "3px", borderLeftStyle: "solid", borderLeftColor: color } : undefined;
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

/** Best-effort readable IO when an older API still shipped raw JSON previews. */
function humanizeIoPreview(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;
  if (text[0] !== "{" && text[0] !== "[") {
    return text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").trim() || text;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const contentText = (content: unknown): string => {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((part) => {
            if (typeof part === "string") return part;
            if (part && typeof part === "object" && "text" in part) {
              return String((part as { text?: unknown }).text ?? "");
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
      }
      return "";
    };
    if (Array.isArray(parsed)) {
      const lines = parsed
        .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
        .map((m) => {
          const role = String(m.role ?? "message");
          const body = contentText(m.content).replace(
            /<think\b[^>]*>[\s\S]*?<\/think>/gi,
            "",
          ).trim();
          return body ? `${role}: ${body}` : "";
        })
        .filter(Boolean);
      if (lines.length) return lines.join("\n\n");
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const choices = obj.choices;
      if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
        const first = choices[0] as Record<string, unknown>;
        const msg =
          first.message && typeof first.message === "object"
            ? (first.message as Record<string, unknown>)
            : null;
        const out = contentText(msg?.content ?? first.text)
          .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
          .trim();
        if (out) return out;
      }
      const messages = obj.messages;
      if (Array.isArray(messages)) {
        const nested = humanizeIoPreview(JSON.stringify(messages));
        if (nested) return nested;
      }
      for (const key of ["content", "output", "completion", "response", "text", "prompt", "input"]) {
        const v = obj[key];
        if (typeof v === "string" && v.trim()) {
          return v.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").trim();
        }
      }
    }
  } catch {
    /* keep raw */
  }
  return text;
}

/** Context the step action bar needs to hit real APIs. All optional — a
 * missing piece disables the matching action with an honest tooltip. */
export type StepActionContext = {
  orgId?: string | null;
  traceId?: string | null;
  /** Enables "Add to regression" (BE builds cases from an issue). */
  issueId?: string | null;
};

/** Resolve an F82 lazily-truncated payload to its full text. */
export type LoadStepPayload = (step: TranscriptStep) => Promise<string>;

type AsyncActionState =
  | { status: "idle" | "pending" | "done" }
  | { status: "error"; message: string };

function StepActionBar({
  step,
  context,
}: {
  step: TranscriptStep;
  context: StepActionContext;
}) {
  const [copied, setCopied] = useState(false);
  const [issue, setIssue] = useState<AsyncActionState>({ status: "idle" });
  const [regression, setRegression] = useState<AsyncActionState>({
    status: "idle",
  });

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(step, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — leave label unchanged */
    }
  }, [step]);

  const { orgId, traceId, issueId } = context;

  const createIssue = useCallback(async () => {
    if (!orgId || !traceId) return;
    setIssue({ status: "pending" });
    try {
      await agentIssuesApi.reportStumble(orgId, {
        trace_id: traceId,
        title: `Transcript report: ${step.title}`,
        span_id: step.spanId ?? step.id,
        detail: {
          source: "portal_transcript",
          step_id: step.id,
          step_kind: step.kind,
          ...(step.errorMessage ? { error: step.errorMessage } : {}),
        },
      });
      setIssue({ status: "done" });
    } catch (err) {
      setIssue({
        status: "error",
        message: err instanceof Error ? err.message : "Report failed",
      });
    }
  }, [orgId, traceId, step]);

  const addToRegression = useCallback(async () => {
    if (!orgId || !issueId) return;
    setRegression({ status: "pending" });
    try {
      await agentIssuesApi.createRegressionCases(orgId, issueId);
      setRegression({ status: "done" });
    } catch (err) {
      setRegression({
        status: "error",
        message: err instanceof Error ? err.message : "Build failed",
      });
    }
  }, [orgId, issueId]);

  const issueDisabled = !orgId || !traceId || issue.status !== "idle";
  const regressionDisabled = !orgId || !issueId || regression.status !== "idle";

  return (
    <div
      data-testid="step-action-bar"
      className="flex flex-wrap items-center gap-1"
    >
      <button
        type="button"
        className="ds-btn ds-btn-ghost ds-btn-sm"
        onClick={() => void createIssue()}
        disabled={issueDisabled}
        title={
          !orgId || !traceId
            ? "Needs org + trace context to report"
            : "Report this step as a stumble (creates/dedupes an issue)"
        }
      >
        {issue.status === "pending"
          ? "Reporting…"
          : issue.status === "done"
            ? "Issue reported"
            : "Create issue"}
      </button>
      <button
        type="button"
        className="ds-btn ds-btn-ghost ds-btn-sm"
        onClick={() => void addToRegression()}
        disabled={regressionDisabled}
        title={
          !orgId || !issueId
            ? "Regression cases build from an issue — open this trace from an issue to enable"
            : "Build regression eval cases from the linked issue"
        }
      >
        {regression.status === "pending"
          ? "Building…"
          : regression.status === "done"
            ? "Added to regression"
            : "Add to regression"}
      </button>
      <button
        type="button"
        className="ds-btn ds-btn-ghost ds-btn-sm"
        onClick={() => void copy()}
        title="Copy this step as JSON"
      >
        {copied ? "Copied" : "Copy step JSON"}
      </button>
      {issue.status === "error" ? (
        <span className="type-mono !text-[var(--error)]">{issue.message}</span>
      ) : null}
      {regression.status === "error" ? (
        <span className="type-mono !text-[var(--error)]">
          {regression.message}
        </span>
      ) : null}
    </div>
  );
}

/**
 * F82 lazy tool payload: the API shipped a `{_lazy, preview, bytes}` marker
 * instead of the full body. Expanding the step fetches the payload once
 * (cached by the owning RunTranscript); without a loader we show the
 * preview and say so instead of pretending it is complete.
 */
function LazyPayloadDetail({
  label,
  marker,
  step,
  tone,
  loadPayload,
}: {
  label: string;
  marker: LazyPayloadMarker;
  step: TranscriptStep;
  tone?: "error" | "default";
  loadPayload?: LoadStepPayload;
}) {
  const [state, setState] = useState<
    | { status: "loading" | "preview" }
    | { status: "loaded"; text: string }
    | { status: "error"; message: string }
  >({ status: loadPayload ? "loading" : "preview" });

  useEffect(() => {
    if (!loadPayload) return;
    let cancelled = false;
    loadPayload(step)
      .then((text) => {
        if (!cancelled) setState({ status: "loaded", text });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message:
              err instanceof Error ? err.message : "Failed to load payload",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadPayload, step]);

  const kb = (marker.bytes / 1024).toFixed(1);

  if (state.status === "loaded") {
    return (
      <DetailBlock label={label} tone={tone}>
        {humanizeIoPreview(state.text) ?? state.text}
      </DetailBlock>
    );
  }

  return (
    <DetailBlock label={label} tone={tone}>
      {marker.preview}
      <p className="type-label mt-2 !text-[var(--text-faint)]">
        {state.status === "loading"
          ? `Loading full payload (${kb} KB)…`
          : state.status === "error"
            ? `Full payload unavailable: ${state.message}`
            : `Preview only — full payload (${kb} KB) not fetched`}
      </p>
    </DetailBlock>
  );
}

function StepDetail({
  step,
  actionContext,
  loadPayload,
}: {
  step: TranscriptStep;
  actionContext?: StepActionContext;
  loadPayload?: LoadStepPayload;
}) {
  const bad = isBadStep(step);
  const attrs = Object.entries(step.attributes ?? {});
  const meta = Object.entries(step.metadata ?? {});
  const inputLazy = parseLazyPayloadMarker(step.inputPreview);
  const outputLazy = parseLazyPayloadMarker(step.outputPreview);
  const inputText = inputLazy ? null : humanizeIoPreview(step.inputPreview);
  const outputText = outputLazy ? null : humanizeIoPreview(step.outputPreview);

  return (
    <div className="space-y-4 border-t border-[var(--line)] bg-[var(--bg-well)] px-4 py-4">
      <StepActionBar step={step} context={actionContext ?? {}} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        {[
          { label: "Kind", value: KIND_LABEL[step.kind] },
          {
            label: "Status",
            value: severityLabel(
              step.status ?? (bad ? "error" : "ok"),
            ),
          },
          { label: "Duration", value: formatDuration(step.durationMs) },
          {
            label: "Started",
            value: step.startedAt ? formatRelativeTime(step.startedAt) : "—",
          },
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
                  row.value === "Failed" &&
                  "!text-[var(--error)]",
                row.label === "Status" &&
                  (row.value === "OK" || row.value === "Warning") &&
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

      {inputLazy ? (
        <LazyPayloadDetail
          label="Input"
          marker={inputLazy}
          step={step}
          loadPayload={loadPayload}
        />
      ) : inputText ? (
        <DetailBlock label="Input">{inputText}</DetailBlock>
      ) : (
        <DetailBlock label="Input">
          <span className="text-[var(--text-faint)]">No input payload captured</span>
        </DetailBlock>
      )}

      {outputLazy ? (
        <LazyPayloadDetail
          label="Output"
          marker={outputLazy}
          step={step}
          tone={bad ? "error" : "default"}
          loadPayload={loadPayload}
        />
      ) : outputText ? (
        <DetailBlock label="Output" tone={bad ? "error" : "default"}>
          {outputText}
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

/**
 * One transcript span. Memoised so scrolling the virtualiser (which
 * re-renders the owning list on every frame) only re-renders rows whose
 * own open/focus state actually changed — an open row drags a whole
 * `StepDetail` (two `<dl>`s + attribute tables) behind it.
 */
const TranscriptRow = memo(function TranscriptRow({
  step,
  index,
  open,
  active,
  compact,
  onToggle,
  actionContext,
  loadPayload,
}: {
  step: TranscriptStep;
  index: number;
  open: boolean;
  /** Keyboard cursor (j/k) rests on this step. */
  active?: boolean;
  compact?: boolean;
  onToggle: (id: string) => void;
  actionContext?: StepActionContext;
  loadPayload?: LoadStepPayload;
}) {
  const bad = isBadStep(step);
  const handleClick = useCallback(() => onToggle(step.id), [onToggle, step.id]);
  const laneStyle = agentLaneStyle(step.agentId);
  const agentLabel = agentStepLabel(step.agentId);

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          "flex w-full min-w-0 cursor-pointer items-center gap-2.5 text-left transition-colors hover:bg-[var(--bg-hover)]",
          compact ? "px-3 py-2" : "px-4 py-2.5",
          open && "bg-[var(--bg-hover)]",
          active && "shadow-[inset_0_0_0_1px_var(--accent)]",
        )}
        style={laneStyle}
        aria-expanded={open}
        data-active={active ? "true" : undefined}
        data-agent-id={step.agentId}
      >
        <span className="type-mono w-5 shrink-0 tabular-nums !text-[var(--text-faint)]">
          {index + 1}
        </span>
        <span className="ds-chip shrink-0 border border-[var(--line)] text-[var(--text-muted)]">
          {KIND_LABEL[step.kind]}
        </span>
        {agentLabel ? (
          <span
            className="ds-chip hidden max-w-[7rem] shrink-0 truncate border border-[var(--line)] text-[var(--text-muted)] sm:inline"
            title={step.agentId}
          >
            {agentLabel}
          </span>
        ) : null}
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
          {step.costUsd != null ? `${formatUsd(step.costUsd, 4)} · ` : ""}
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
      {open ? (
        <StepDetail
          step={step}
          actionContext={actionContext}
          loadPayload={loadPayload}
        />
      ) : null}
    </>
  );
});

/**
 * Fan-out group: same-parent tool steps whose time ranges overlap render as
 * side-by-side lanes (h/l walks them). Open lanes expand full-width below
 * the lane strip so payloads stay readable.
 */
const ParallelGroupRow = memo(function ParallelGroupRow({
  lanes,
  index,
  openIds,
  activeId,
  compact,
  onToggle,
  actionContext,
  loadPayload,
}: {
  lanes: TranscriptStep[];
  index: number;
  openIds: Set<string>;
  activeId: string | null;
  compact?: boolean;
  onToggle: (id: string) => void;
  actionContext?: StepActionContext;
  loadPayload?: LoadStepPayload;
}) {
  const agentIds = new Set(lanes.map((lane) => lane.agentId).filter(Boolean));
  const multiAgent = agentIds.size > 1;

  return (
    <div data-parallel-group>
      <div
        className={cn(
          "flex items-center gap-2 border-b border-dashed border-[var(--line)]",
          compact ? "px-3 py-1" : "px-4 py-1.5",
        )}
      >
        <span className="type-mono w-5 shrink-0 tabular-nums !text-[var(--text-faint)]">
          {index + 1}
        </span>
        <span className="ds-chip shrink-0 border border-[var(--line)] text-[var(--text-muted)]">
          ‖ {lanes.length} parallel
        </span>
        <span className="type-label !text-[var(--text-faint)]">
          {multiAgent
            ? `${agentIds.size} agents · overlapping tool calls`
            : "overlapping tool calls"}
        </span>
      </div>
      <div className="flex min-w-0 divide-x divide-[var(--line)]">
        {lanes.map((step, laneIndex) => {
          const bad = isBadStep(step);
          const open = openIds.has(step.id);
          const active = activeId === step.id;
          const laneStyle = agentLaneStyle(step.agentId);
          const agentLabel = agentStepLabel(step.agentId);
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => onToggle(step.id)}
              className={cn(
                "flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-1 text-left transition-colors hover:bg-[var(--bg-hover)]",
                compact ? "px-3 py-2" : "px-4 py-2.5",
                open && "bg-[var(--bg-hover)]",
                bad && "bg-[var(--error-muted)]",
                active && "shadow-[inset_0_0_0_1px_var(--accent)]",
              )}
              style={laneStyle}
              aria-expanded={open}
              data-step-id={step.id}
              data-lane-index={laneIndex}
              data-agent-id={step.agentId}
              data-active={active ? "true" : undefined}
            >
              <span className="flex w-full min-w-0 items-center gap-1.5">
                <span className="ds-chip shrink-0 border border-[var(--line)] text-[var(--text-muted)]">
                  {KIND_LABEL[step.kind]}
                </span>
                {agentLabel ? (
                  <span
                    className="ds-chip max-w-[6rem] shrink-0 truncate border border-[var(--line)] text-[var(--text-muted)]"
                    title={step.agentId}
                  >
                    {agentLabel}
                  </span>
                ) : null}
                <span
                  className={cn(
                    "type-ui min-w-0 flex-1 truncate !font-normal",
                    bad ? "text-[var(--error)]" : "text-[var(--text)]",
                  )}
                >
                  {step.title}
                </span>
              </span>
              <span className="type-value whitespace-nowrap !text-[0.6875rem]">
                {step.costUsd != null ? `${formatUsd(step.costUsd, 4)} · ` : ""}
                {formatDuration(step.durationMs)}
              </span>
            </button>
          );
        })}
      </div>
      {lanes
        .filter((step) => openIds.has(step.id))
        .map((step) => (
          <div key={step.id} data-lane-detail={step.id}>
            <StepDetail
              step={step}
              actionContext={actionContext}
              loadPayload={loadPayload}
            />
          </div>
        ))}
    </div>
  );
});

/** Collapsed-row estimate; real heights come from `measureElement`. */
const TRANSCRIPT_ROW_ESTIMATE = 44;
const TRANSCRIPT_ROW_ESTIMATE_COMPACT = 37;

/** Shared expandable transcript — every span opens to full detail. */
export function RunTranscript({
  steps,
  defaultOpenIds,
  compact,
  focusStepId,
  hideToolbar = false,
  openIds: openIdsProp,
  onOpenIdsChange,
  orgId,
  traceId,
  issueId,
  syncStepToUrl = true,
  onActiveStepChange,
  loadStepPayload,
}: {
  steps: TranscriptStep[];
  defaultOpenIds?: string[];
  compact?: boolean;
  focusStepId?: string | null;
  /** Hide the internal spans / Expand / Collapse band (parent owns it). */
  hideToolbar?: boolean;
  openIds?: Set<string>;
  onOpenIdsChange?: (next: Set<string>) => void;
  /** Enables the step action bar's API actions (issue report / regression). */
  orgId?: string | null;
  traceId?: string | null;
  issueId?: string | null;
  /**
   * Mirror the keyboard cursor to a `?step=<id>` URL param (read on mount →
   * scroll + open that step). Turn off when the host page owns span deep
   * links (traces `?span=`, debugger `?spanId=`) or mounts several
   * transcripts at once.
   */
  syncStepToUrl?: boolean;
  onActiveStepChange?: (id: string) => void;
  /** F82: fetch the full payload behind a lazy marker. Cached per step. */
  loadStepPayload?: LoadStepPayload;
}) {
  const [uncontrolledOpenIds, setUncontrolledOpenIds] = useState<Set<string>>(
    () => new Set(defaultOpenIds ?? errorStepIds(steps)),
  );
  const controlled = openIdsProp !== undefined;
  const openIds = controlled ? openIdsProp : uncontrolledOpenIds;

  // Latest-value refs so `toggle` can stay referentially stable across
  // renders — an unstable toggle would blow through `TranscriptRow`'s
  // memo on every scroll frame.
  const controlledRef = useRef(controlled);
  controlledRef.current = controlled;
  const onOpenIdsChangeRef = useRef(onOpenIdsChange);
  onOpenIdsChangeRef.current = onOpenIdsChange;
  const openIdsRef = useRef(openIds);
  openIdsRef.current = openIds;

  const setOpenIds = useCallback((next: Set<string>) => {
    if (!controlledRef.current) setUncontrolledOpenIds(next);
    onOpenIdsChangeRef.current?.(next);
  }, []);

  // Row derivation goes through the observability data layer: overlapping
  // same-parent tool steps collapse into one parallel row with lanes.
  const viewRows = useMemo(() => groupParallelSteps(steps), [steps]);
  const viewRowsRef = useRef(viewRows);
  viewRowsRef.current = viewRows;

  /** step id → its view row index + lane index (0 for plain rows). */
  const stepLocation = useMemo(() => {
    const map = new Map<string, { row: number; lane: number }>();
    viewRows.forEach((row, rowIndex) => {
      if (row.type === "step") {
        map.set(row.step.id, { row: rowIndex, lane: 0 });
      } else {
        row.lanes.forEach((step, lane) =>
          map.set(step.id, { row: rowIndex, lane }),
        );
      }
    });
    return map;
  }, [viewRows]);
  const stepLocationRef = useRef(stepLocation);
  stepLocationRef.current = stepLocation;

  // Keyboard cursor. Deep link: `?step=<id>` (when this instance owns it)
  // seeds the cursor before first paint; the mount effect below opens and
  // scrolls to it.
  const [activeId, setActiveId] = useState<string | null>(() => {
    if (focusStepId) return focusStepId;
    if (syncStepToUrl && typeof window !== "undefined") {
      const fromUrl = new URLSearchParams(window.location.search).get("step");
      if (fromUrl) {
        const match = steps.find(
          (s) => s.id === fromUrl || s.spanId === fromUrl,
        );
        if (match) return match.id;
      }
    }
    return null;
  });
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const syncUrlRef = useRef(syncStepToUrl);
  syncUrlRef.current = syncStepToUrl;
  const onActiveStepChangeRef = useRef(onActiveStepChange);
  onActiveStepChangeRef.current = onActiveStepChange;

  const focusSeenRef = useRef(false);
  const applyActive = useCallback((id: string) => {
    setActiveId(id);
    activeIdRef.current = id;
    onActiveStepChangeRef.current?.(id);
    if (syncUrlRef.current && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("step", id);
      window.history.replaceState(window.history.state, "", url);
    }
  }, []);

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(openIdsRef.current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setOpenIds(next);
      // Mouse and keyboard share one cursor — clicking a row moves it.
      applyActive(id);
    },
    [setOpenIds, applyActive],
  );

  // F82 lazy payloads: resolve each step at most once, even across
  // collapse/expand cycles — the promise itself is the cache entry.
  const payloadCacheRef = useRef(new Map<string, Promise<string>>());
  const loadStepPayloadRef = useRef(loadStepPayload);
  loadStepPayloadRef.current = loadStepPayload;
  const hasPayloadLoader = Boolean(loadStepPayload);
  const loadPayload = useMemo<LoadStepPayload | undefined>(() => {
    if (!hasPayloadLoader) return undefined;
    return (step: TranscriptStep) => {
      const cached = payloadCacheRef.current.get(step.id);
      if (cached) return cached;
      const promise = Promise.resolve().then(() =>
        loadStepPayloadRef.current
          ? loadStepPayloadRef.current(step)
          : Promise.reject(new Error("payload loader detached")),
      );
      payloadCacheRef.current.set(step.id, promise);
      promise.catch(() => payloadCacheRef.current.delete(step.id));
      return promise;
    };
    // Only presence/absence matters — the ref tracks the latest loader.
  }, [hasPayloadLoader]);

  const actionContext = useMemo<StepActionContext>(
    () => ({ orgId, traceId, issueId }),
    [orgId, traceId, issueId],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: viewRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () =>
      compact ? TRANSCRIPT_ROW_ESTIMATE_COMPACT : TRANSCRIPT_ROW_ESTIMATE,
    overscan: 6,
    getItemKey: (index) => viewRows[index]?.id ?? index,
    measureElement: measureVirtualRow,
  });
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  useEffect(() => {
    if (!focusStepId) return;
    // A host echoing our own cursor back (onActiveStepChange → focus prop)
    // must not open/scroll — only external focus (tree click, deep link,
    // first mount) does.
    const external =
      !focusSeenRef.current || focusStepId !== activeIdRef.current;
    focusSeenRef.current = true;
    setActiveId(focusStepId);
    if (!external) return;
    const current = openIdsRef.current;
    if (!current.has(focusStepId)) {
      const next = new Set(current);
      next.add(focusStepId);
      setOpenIds(next);
    }
    // Virtualised: the focused row may not be mounted yet, so ask the
    // virtualiser to bring the index into view rather than querying the
    // DOM for an element that isn't there.
    const location = stepLocationRef.current.get(focusStepId);
    const t = window.setTimeout(() => {
      if (location) {
        virtualizerRef.current.scrollToIndex(location.row, {
          align: "center",
        });
      }
    }, 40);
    return () => window.clearTimeout(t);
    // Only react to focus changes.
  }, [focusStepId]);

  // `?step=` deep link (mount only): open the seeded step and bring it
  // into view. `focusStepId` deep links are the host page's job above.
  const urlSeedRef = useRef(false);
  useEffect(() => {
    if (urlSeedRef.current) return;
    urlSeedRef.current = true;
    const seeded = activeIdRef.current;
    if (!seeded || seeded === focusStepId) return;
    const current = openIdsRef.current;
    if (!current.has(seeded)) {
      setOpenIds(new Set([...current, seeded]));
    }
    const location = stepLocationRef.current.get(seeded);
    const t = window.setTimeout(() => {
      if (location) {
        virtualizerRef.current.scrollToIndex(location.row, {
          align: "center",
        });
      }
    }, 40);
    return () => window.clearTimeout(t);
    // Mount-only seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // j/k rows · h/l lanes · Enter/Space toggles. Scoped to this container
  // (focusable) so several transcripts on one page never fight, and the
  // `transcript-v2` marker lets list-level j/k defer to us.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      const rows = viewRowsRef.current;
      if (rows.length === 0) return;
      const locate = () => {
        const id = activeIdRef.current;
        return id ? (stepLocationRef.current.get(id) ?? null) : null;
      };
      const idAt = (rowIndex: number, lane: number): string | null => {
        const row = rows[rowIndex];
        if (!row) return null;
        if (row.type === "step") return row.step.id;
        const clamped = Math.max(0, Math.min(row.lanes.length - 1, lane));
        return row.lanes[clamped]?.id ?? null;
      };
      const moveRow = (delta: number) => {
        const current = locate();
        const nextRow = current
          ? Math.max(0, Math.min(rows.length - 1, current.row + delta))
          : delta > 0
            ? 0
            : rows.length - 1;
        const id = idAt(nextRow, current?.lane ?? 0);
        if (id && id !== activeIdRef.current) {
          applyActive(id);
          virtualizerRef.current.scrollToIndex(nextRow, { align: "auto" });
        }
      };
      const moveLane = (delta: number) => {
        const current = locate();
        if (!current) return;
        const id = idAt(current.row, current.lane + delta);
        if (id && id !== activeIdRef.current) applyActive(id);
      };

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          moveRow(1);
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          moveRow(-1);
          break;
        case "h":
        case "ArrowLeft":
          e.preventDefault();
          moveLane(-1);
          break;
        case "l":
        case "ArrowRight":
          e.preventDefault();
          moveLane(1);
          break;
        case "Enter":
        case " ": {
          // Row buttons handle their own Enter/Space via native click.
          if (e.target !== e.currentTarget) break;
          const id = activeIdRef.current;
          if (id) {
            e.preventDefault();
            toggle(id);
          }
          break;
        }
        default:
          break;
      }
    },
    [applyActive, toggle],
  );

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      data-testid="transcript-v2"
      tabIndex={0}
      role="group"
      aria-label="Run transcript"
      onKeyDown={handleKeyDown}
    >
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
      <div
        ref={scrollRef}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto"
        {...{ [VIRTUAL_SCROLL_ATTR]: "transcript" }}
      >
        <ol
          className="relative min-w-0"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualItems.map((item) => {
            const row = viewRows[item.index];
            if (!row) return null;

            if (row.type === "parallel") {
              const anyBad = row.lanes.some(isBadStep);
              const focused = row.lanes.some((s) => s.id === focusStepId);
              return (
                <li
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  data-row-id={row.id}
                  aria-posinset={item.index + 1}
                  aria-setsize={viewRows.length}
                  className={cn(
                    "absolute top-0 left-0 w-full min-w-0 border-b border-[var(--line)]",
                    anyBad && "bg-[var(--error-muted)]",
                    focused && "shadow-[inset_2px_0_0_var(--accent)]",
                  )}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <ParallelGroupRow
                    lanes={row.lanes}
                    index={item.index}
                    openIds={openIds}
                    activeId={activeId}
                    compact={compact}
                    onToggle={toggle}
                    actionContext={actionContext}
                    loadPayload={loadPayload}
                  />
                </li>
              );
            }

            const step = row.step;
            const bad = isBadStep(step);
            const open = openIds.has(step.id);
            const focused = focusStepId === step.id;

            return (
              <li
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                data-step-id={step.id}
                aria-posinset={item.index + 1}
                aria-setsize={viewRows.length}
                className={cn(
                  "absolute top-0 left-0 w-full min-w-0 border-b border-[var(--line)]",
                  bad && "bg-[var(--error-muted)]",
                  focused && "shadow-[inset_2px_0_0_var(--accent)]",
                )}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <TranscriptRow
                  step={step}
                  index={item.index}
                  open={open}
                  active={activeId === step.id}
                  compact={compact}
                  onToggle={toggle}
                  actionContext={actionContext}
                  loadPayload={loadPayload}
                />
              </li>
            );
          })}
        </ol>
      </div>
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
  const agents = useCatalogAgents();
  const options = agents.length > 0 ? agents : AGENT_LIST;
  return (
    <label className="block min-w-0">
      <span className="type-meta mb-1 block text-[var(--text-secondary)]">
        Viewing agent
      </span>
      <select
        className="ds-input w-full"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Filter by agent"
      >
        <option value="all">
          All agents{counts?.all != null ? ` (${counts.all})` : ""}
        </option>
        {options.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
            {counts?.[agent.id] != null ? ` (${counts[agent.id]})` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Search field with a visible search glyph and a one-click clear (×)
 * button that appears once the field has text. The native WebKit
 * cancel button is hidden so every browser gets the same affordance,
 * and clearing keeps focus in the field so a follow-up query is one
 * keystroke away. Used by the master-list feeds (traces, issues,
 * agents, detectors) so filtering behaves identically everywhere.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  /**
   * Optional external ref — lets a page-level `/` shortcut focus the
   * field (the list shortcuts live above the feed, the input below it).
   */
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const internalRef = useRef<HTMLInputElement>(null);
  const mergedRef = (node: HTMLInputElement | null) => {
    internalRef.current = node;
    if (inputRef) inputRef.current = node;
  };
  return (
    <div className={cn("relative min-w-0", className)}>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-faint)]"
        aria-hidden
      />
      <input
        ref={mergedRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="ds-input w-full pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          onClick={() => {
            onChange("");
            internalRef.current?.focus();
          }}
          className="ds-btn ds-btn-ghost ds-btn-icon absolute right-1 top-1/2 !h-5 !w-5 -translate-y-1/2"
          aria-label={`Clear search`}
          title="Clear search"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      ) : null}
    </div>
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
