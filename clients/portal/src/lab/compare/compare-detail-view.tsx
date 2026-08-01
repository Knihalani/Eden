"use client";

import Link from "next/link";
import {
  armDelta,
  armRoleLabel,
  betterArmLabel,
  confidenceLine,
  formatDeltaDisplay,
  formatMetricValue,
  labCompareHref,
  metricLabel,
  metricShortLabel,
  sampleGradeLabel,
  samplesForExperiment,
  sortSamplesByGrade,
  verdictSentence,
  type AbExperimentFixture,
  type AbLayout,
  type AbPrimaryMetric,
  type AbSample,
  type AbSampleGrade,
} from "@/lab/fixtures/compare";
import { labDebuggerDetailHref } from "@/lab/fixtures/debugger";
import { Delta } from "@/lab/evals/evals-chrome";
import { AbLayoutNav, AbRecChip } from "@/lab/compare/compare-chrome";
import { EmptyState, FilterChips } from "@/lab/lab-ui";
import { StatusChip } from "@/components/ds/primitives";
import { cn } from "@/lib/utils";

function SampleGradeChip({ grade }: { grade: AbSampleGrade }) {
  const tone =
    grade === "improve" ? "ok" : grade === "regress" ? "fail" : "neutral";
  return <StatusChip tone={tone}>{sampleGradeLabel(grade)}</StatusChip>;
}

export function CompareDetailView({
  experiment,
  layout,
  metric,
  gradeFilter,
  diff,
  sampleId,
  onLayout,
  onMetric,
  onGrade,
  onDiff,
  onSample,
}: {
  experiment: AbExperimentFixture | null;
  layout: AbLayout;
  metric: AbPrimaryMetric;
  gradeFilter: AbSampleGrade | "all";
  diff: boolean;
  sampleId: string | null;
  onLayout: (v: AbLayout) => void;
  onMetric: (v: AbPrimaryMetric) => void;
  onGrade: (v: AbSampleGrade | "all") => void;
  onDiff: (v: boolean) => void;
  onSample: (id: string | null) => void;
}) {
  if (!experiment) {
    return (
      <EmptyState title="Select a split" compact />
    );
  }

  const samples = sortSamplesByGrade(samplesForExperiment(experiment.id));
  const filtered =
    gradeFilter === "all"
      ? samples
      : samples.filter((s) => s.grade === gradeFilter);
  const focus = sampleId
    ? (samples.find((s) => s.id === sampleId) ?? null)
    : null;
  const [control, treatment] = experiment.arms ?? [];
  const primary = armDelta(experiment, metric);
  const stumble = armDelta(experiment, "stumble");
  const score = armDelta(experiment, "score");
  const cost = armDelta(experiment, "cost");
  const latency = armDelta(experiment, "latency");

  const gradeCounts = {
    all: samples.length,
    improve: samples.filter((s) => s.grade === "improve").length,
    regress: samples.filter((s) => s.grade === "regress").length,
    tradeoff: samples.filter((s) => s.grade === "tradeoff").length,
    tie: samples.filter((s) => s.grade === "tie").length,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 space-y-2.5 border-b border-[var(--line)] px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <AbRecChip rec={experiment.recommendation} />
              <p className="type-ui text-[var(--text)]">
                {verdictSentence(experiment)}
              </p>
            </div>
            <p className="type-meta flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
              <DeltaStat
                label="Fail"
                value={formatDeltaDisplay("stumble", stumble.delta)}
                good={stumble.delta < -0.0005}
                bad={stumble.delta > 0.0005}
              />
              <DeltaStat
                label="Score"
                value={formatDeltaDisplay("score", score.delta)}
                good={score.delta > 0.0005}
                bad={score.delta < -0.0005}
              />
              <DeltaStat
                label="Cost"
                value={formatDeltaDisplay("cost", cost.delta)}
                good={cost.delta < -0.0005}
                bad={cost.delta > 0.0005}
              />
              <DeltaStat
                label="p95"
                value={formatDeltaDisplay("latency", latency.delta)}
                good={latency.delta < -50}
                bad={latency.delta > 50}
              />
            </p>
          </div>
          <RecActions experiment={experiment} />
        </div>

        <div className="min-w-0">
          <h2 className="type-title text-[var(--text)]">{experiment.name}</h2>
          <p className="type-meta mt-0.5">{confidenceLine(experiment)}</p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <AbLayoutNav value={layout} onChange={onLayout} />
          <div className="flex flex-wrap items-center gap-2">
            {layout === "timeline" || layout === "overview" ? (
              <FilterChips
                value={metric}
                onChange={onMetric}
                options={[
                  { id: "stumble", label: "Fail rate" },
                  { id: "score", label: "Score" },
                  { id: "cost", label: "Cost" },
                  { id: "latency", label: "Latency" },
                ]}
              />
            ) : null}
            {layout === "samples" ? (
              <>
                <button
                  type="button"
                  className={cn(
                    "ds-btn ds-btn-sm",
                    diff && "ds-btn-primary",
                  )}
                  aria-pressed={diff}
                  onClick={() => onDiff(!diff)}
                >
                  Side by side
                </button>
                <FilterChips
                  value={gradeFilter}
                  onChange={onGrade}
                  options={[
                    { id: "all", label: "All", count: gradeCounts.all },
                    {
                      id: "improve",
                      label: "Better",
                      count: gradeCounts.improve,
                    },
                    {
                      id: "regress",
                      label: "Worse",
                      count: gradeCounts.regress,
                    },
                    {
                      id: "tradeoff",
                      label: "Mixed",
                      count: gradeCounts.tradeoff,
                    },
                    { id: "tie", label: "Same", count: gradeCounts.tie },
                  ]}
                />
              </>
            ) : null}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {layout === "overview" ? (
          <OverviewBody
            experiment={experiment}
            metric={metric}
            primary={primary}
            rationale={experiment.rationale}
          />
        ) : null}
        {layout === "samples" ? (
          <SamplesBody
            samples={filtered}
            diff={diff}
            sampleId={sampleId}
            onSample={onSample}
            controlLabel={control?.label || "Current"}
            treatmentLabel={treatment?.label || "Candidate"}
          />
        ) : null}
        {layout === "timeline" ? (
          <TimelineBody experiment={experiment} metric={metric} />
        ) : null}
      </div>

      {focus ? (
        <SampleDock
          sample={focus}
          experiment={experiment}
          onClose={() => onSample(null)}
        />
      ) : null}
    </div>
  );
}

function DeltaStat({
  label,
  value,
  good,
  bad,
}: {
  label: string;
  value: string;
  good?: boolean;
  bad?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-[var(--text-faint)]">{label}</span>
      <span
        className={cn(
          "type-mono tabular-nums !text-[0.6875rem]",
          good && "!text-[var(--success)]",
          bad && "!text-[var(--error)]",
          !good && !bad && "!text-[var(--text-muted)]",
        )}
      >
        {value}
      </span>
    </span>
  );
}

function RecActions({ experiment }: { experiment: AbExperimentFixture }) {
  const rec = experiment.recommendation;
  return (
    <div className="flex shrink-0 flex-wrap gap-2">
      {rec === "ship" || rec === "ship_with_monitoring" ? (
        <Link
          href={`/improve?agent=${experiment.agentId}`}
          className="ds-btn ds-btn-primary ds-btn-sm"
        >
          Promote
        </Link>
      ) : null}
      {rec === "dont_ship" ? (
        <>
          {experiment.sourceDebuggerSessionId ? (
            <Link
              href={labDebuggerDetailHref(experiment.sourceDebuggerSessionId, {
                mode: "compare",
              })}
              className="ds-btn ds-btn-sm"
            >
              Debugger
            </Link>
          ) : null}
          {experiment.sourceEvalBaselineId &&
          experiment.sourceEvalCompareId ? (
            <Link
              href={`/evals?mode=compare&baselineId=${experiment.sourceEvalBaselineId}&compareId=${experiment.sourceEvalCompareId}`}
              className="ds-btn ds-btn-sm"
            >
              Evals
            </Link>
          ) : null}
        </>
      ) : null}
      {experiment.issueId ? (
        <Link
          href={`/issues?id=${experiment.issueId}`}
          className="ds-btn ds-btn-ghost ds-btn-sm"
        >
          Issue
        </Link>
      ) : null}
    </div>
  );
}

function OverviewBody({
  experiment,
  metric,
  primary,
  rationale,
}: {
  experiment: AbExperimentFixture;
  metric: AbPrimaryMetric;
  primary: ReturnType<typeof armDelta>;
  rationale: string;
}) {
  const [control, treatment] = experiment.arms ?? [];
  const lead =
    primary.better === "tie"
      ? "Tied"
      : `${betterArmLabel(primary.better)} ahead`;

  return (
    <div className="space-y-4 p-4 sm:p-5">
      <div className="grid gap-4 md:grid-cols-2">
        <ArmPane
          arm={control}
          metric={metric}
          highlight={primary.better === "control"}
        />
        <ArmPane
          arm={treatment}
          metric={metric}
          edge
          highlight={primary.better === "treatment"}
        />
      </div>
      <p className="type-meta">
        {metricLabel(metric)}{" "}
        <Delta value={primary.delta} invertGood={primary.invertGood} /> · {lead}
      </p>
      <p className="type-body max-w-3xl text-[var(--text-secondary)]">
        {rationale}
      </p>
    </div>
  );
}

function ArmPane({
  arm,
  metric,
  edge,
  highlight,
}: {
  arm: AbExperimentFixture["arms"][number] | null | undefined;
  metric: AbPrimaryMetric;
  edge?: boolean;
  highlight?: boolean;
}) {
  if (!arm) {
    return (
      <div className="space-y-2 px-1 py-1">
        <p className="type-label">{edge ? "Candidate" : "Current"}</p>
        <p className="type-meta">No arm metrics yet</p>
      </div>
    );
  }
  const value =
    metric === "stumble"
      ? formatMetricValue("stumble", arm.stumbleRate)
      : metric === "score"
        ? formatMetricValue("score", arm.avgScore)
        : metric === "cost"
          ? formatMetricValue("cost", arm.costUsdPerTrace)
          : formatMetricValue("latency", arm.latencyP95Ms);

  return (
    <div
      className={cn(
        "space-y-2 px-1 py-1",
        edge && "md:border-l md:border-[var(--line)] md:pl-4",
        highlight &&
          "rounded-[var(--radius)] bg-[var(--accent-muted)]/40 px-3 py-2 md:pl-4",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="type-label">{armRoleLabel(arm.key)}</p>
        <p className="type-mono !text-[0.75rem] text-[var(--text)]">
          {((arm.weight ?? 0) * 100).toFixed(0)}%
        </p>
      </div>
      <p className="type-title">{arm.label}</p>
      <p className="type-display mt-1 tabular-nums">{value}</p>
      <p className="type-meta">{metricLabel(metric)}</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
        <Stat
          label="Runs"
          value={(arm.nTraces ?? 0).toLocaleString()}
        />
        <Stat
          label="Fail rate"
          value={formatMetricValue("stumble", arm.stumbleRate)}
        />
        <Stat label="Score" value={formatMetricValue("score", arm.avgScore)} />
        <Stat
          label="Cost"
          value={formatMetricValue("cost", arm.costUsdPerTrace)}
        />
        <Stat
          label="p95"
          value={formatMetricValue("latency", arm.latencyP95Ms)}
        />
      </dl>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="type-meta text-[var(--text-faint)]">{label}</dt>
      <dd className="type-mono tabular-nums !text-[0.75rem] text-[var(--text)]">
        {value}
      </dd>
    </div>
  );
}

function SamplesBody({
  samples,
  diff,
  sampleId,
  onSample,
  controlLabel,
  treatmentLabel,
}: {
  samples: AbSample[];
  diff: boolean;
  sampleId: string | null;
  onSample: (id: string | null) => void;
  controlLabel: string;
  treatmentLabel: string;
}) {
  if (samples.length === 0) {
    return <EmptyState title="No examples" compact />;
  }

  return (
    <ul className="divide-y divide-[var(--line)]">
      {samples.map((s) => {
        const active = s.id === sampleId;
        return (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onSample(active ? null : s.id)}
              className={cn(
                "w-full px-4 py-3 text-left transition-colors sm:px-5",
                active
                  ? "bg-[var(--accent-muted)]"
                  : "hover:bg-[var(--bg-inset)]",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <SampleGradeChip grade={s.grade} />
                <span className="type-meta">
                  {s.judge ?? "judge"} ·{" "}
                  <Delta value={s.treatmentScore - s.controlScore} />
                </span>
              </div>
              <p className="type-ui mt-1.5 text-[var(--text)]">{s.input}</p>
              {diff ? (
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <OutputPane
                    label={`Current · ${controlLabel}`}
                    text={s.controlOutput}
                  />
                  <OutputPane
                    label={`Candidate · ${treatmentLabel}`}
                    text={s.treatmentOutput}
                  />
                </div>
              ) : s.rationale ? (
                <p className="type-meta mt-1.5 text-[var(--text-secondary)]">
                  {s.rationale}
                </p>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function OutputPane({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-[var(--radius)] bg-[var(--bg-inset)] px-3 py-2">
      <p className="type-label">{label}</p>
      <p className="type-mono mt-1 !text-[0.6875rem] text-[var(--text-secondary)]">
        {text}
      </p>
    </div>
  );
}

function TimelineBody({
  experiment,
  metric,
}: {
  experiment: AbExperimentFixture;
  metric: AbPrimaryMetric;
}) {
  const points = experiment.series[metric];
  const invertGood =
    metric === "stumble" || metric === "cost" || metric === "latency";
  const max = Math.max(
    ...points.flatMap((p) => [p.control, p.treatment]),
    0.001,
  );

  return (
    <div className="space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <p className="type-meta">{metricLabel(metric)}</p>
        <span className="inline-flex items-center gap-1.5 type-meta">
          <span className="inline-block h-1.5 w-3 rounded-full bg-[var(--text-muted)]" />
          Current
        </span>
        <span className="inline-flex items-center gap-1.5 type-meta">
          <span className="inline-block h-1.5 w-3 rounded-full bg-[var(--accent)]" />
          Candidate
        </span>
      </div>
      <ul className="space-y-2.5">
        {points.map((p) => {
          const cPct = (p.control / max) * 100;
          const tPct = (p.treatment / max) * 100;
          const delta = p.treatment - p.control;
          return (
            <li key={p.t}>
              <div className="flex items-center justify-between gap-2">
                <span className="type-meta w-14 shrink-0">{p.t}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <BarRow
                    label="Cur"
                    pct={cPct}
                    value={formatMetricValue(metric, p.control)}
                    tone="neutral"
                  />
                  <BarRow
                    label="Cand"
                    pct={tPct}
                    value={formatMetricValue(metric, p.treatment)}
                    tone="accent"
                  />
                </div>
                <span
                  className={cn(
                    "type-mono w-[4.5rem] shrink-0 text-right !text-[0.625rem] tabular-nums",
                    (invertGood ? delta < 0 : delta > 0) &&
                      "!text-[var(--success)]",
                    (invertGood ? delta > 0 : delta < 0) &&
                      "!text-[var(--error)]",
                  )}
                  title={`${metricShortLabel(metric)} delta`}
                >
                  {formatDeltaDisplay(metric, delta)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BarRow({
  label,
  pct,
  value,
  tone,
}: {
  label: string;
  pct: number;
  value: string;
  tone: "neutral" | "accent";
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="type-mono w-8 shrink-0 !text-[0.625rem] text-[var(--text-faint)]">
        {label}
      </span>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--line)]">
        <div
          className={cn(
            "h-full rounded-full",
            tone === "accent" ? "bg-[var(--accent)]" : "bg-[var(--text-muted)]",
          )}
          style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
        />
      </div>
      <span className="type-mono w-[4.5rem] shrink-0 text-right !text-[0.625rem] tabular-nums">
        {value}
      </span>
    </div>
  );
}

function SampleDock({
  sample,
  experiment,
  onClose,
}: {
  sample: AbSample;
  experiment: AbExperimentFixture;
  onClose: () => void;
}) {
  return (
    <aside className="shrink-0 border-t border-[var(--line)] bg-[var(--bg)] px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <SampleGradeChip grade={sample.grade} />
          </div>
          <p className="type-ui text-[var(--text)]">{sample.input}</p>
          {sample.rationale ? (
            <p className="type-meta text-[var(--text-secondary)]">
              {sample.rationale}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="ds-btn ds-btn-ghost ds-btn-sm"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          href={`/traces?id=${sample.controlTraceId}`}
          className="ds-btn ds-btn-sm"
        >
          Current
        </Link>
        <Link
          href={`/traces?id=${sample.treatmentTraceId}`}
          className="ds-btn ds-btn-sm"
        >
          Candidate
        </Link>
        {experiment.sourceDebuggerSessionId ? (
          <Link
            href={labDebuggerDetailHref(experiment.sourceDebuggerSessionId, {
              mode: "compare",
              leftTraceId: sample.controlTraceId,
              rightTraceId: sample.treatmentTraceId,
            })}
            className="ds-btn ds-btn-sm"
          >
            Debugger
          </Link>
        ) : null}
        {experiment.issueId ? (
          <Link
            href={`/issues?id=${experiment.issueId}`}
            className="ds-btn ds-btn-ghost ds-btn-sm"
          >
            Issue
          </Link>
        ) : null}
        <Link
          href={labCompareHref({
            id: experiment.id,
            layout: "samples",
            sample: sample.id,
            diff: true,
          })}
          className="ds-btn ds-btn-ghost ds-btn-sm"
        >
          Link
        </Link>
      </div>
    </aside>
  );
}
