"use client";

import { cn } from "@/lib/utils";
import { CheckCircle2, XCircle, AlertCircle, Clock, Cpu, Zap, Shield, TrendingDown } from "lucide-react";

interface CategoryResult {
  passed: boolean;
  details?: Record<string, unknown>;
  error?: string | null;
}

interface TestResults {
  passed?: boolean;
  category_results?: Record<string, CategoryResult>;
  exploit_findings?: Array<{ probe: string; result: string; severity: string }>;
  performance_metrics?: { step_time?: number; memory_peak?: number; episodes_per_second?: number };
}

const CATEGORY_META: Record<string, { label: string; description: string; icon: typeof CheckCircle2 }> = {
  instantiation: {
    label: "C1 Instantiation",
    description: "Environment instantiates without errors across difficulty extremes",
    icon: CheckCircle2,
  },
  reset_integrity: {
    label: "C2 Reset Integrity",
    description: "Reset returns valid observations matching declared dtype/bounds",
    icon: CheckCircle2,
  },
  step_validity: {
    label: "C3 Step Validity",
    description: "Step produces valid outputs across 10K random-action steps",
    icon: CheckCircle2,
  },
  termination_reachability: {
    label: "C4 Termination Reachability",
    description: "Episode can actually terminate via goal-directed scripted policy",
    icon: CheckCircle2,
  },
  reward_non_degeneracy: {
    label: "C5 Reward Non-Degeneracy",
    description: "Distinct actions produce measurably different rewards",
    icon: CheckCircle2,
  },
  reproducibility: {
    label: "C6 Reproducibility",
    description: "Identical seeds produce byte-identical trajectories",
    icon: CheckCircle2,
  },
  exploit_scan: {
    label: "C7 Exploit Scan",
    description: "Exploit Library probes for reward hacking categories",
    icon: Shield,
  },
  mutation_testing: {
    label: "C8 Mutation Testing",
    description: "Tests survive minor code changes — design quality indicator",
    icon: TrendingDown,
  },
  edge_case_stress: {
    label: "C9 Edge Case Stress",
    description: "Zero/max actions, boundary states, long episodes handled",
    icon: Zap,
  },
  performance_validation: {
    label: "C10 Performance Validation",
    description: "Environment meets speed and memory requirements",
    icon: Cpu,
  },
  curriculum_coherence: {
    label: "C11 Curriculum Coherence",
    description: "Difficulty progression is monotonic and meaningful",
    icon: AlertCircle,
  },
  documentation_smoke_test: {
    label: "C12 Documentation Smoke",
    description: "Docstring examples execute correctly",
    icon: CheckCircle2,
  },
};

function CategoryCard({ name, result }: { name: string; result: CategoryResult }) {
  const meta = CATEGORY_META[name];
  const Icon = meta?.icon || CheckCircle2;

  return (
    <div
      className={cn(
        "p-4 rounded-xl border transition-all",
        result.passed
          ? "bg-[var(--terminal-faint)] border-[var(--terminal)]"
          : "bg-[var(--error-dim)] border-[var(--error)]"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className={cn(
            "p-2 rounded-lg flex-shrink-0",
            result.passed ? "bg-[var(--terminal-faint)] text-[var(--terminal)]" : "bg-[var(--error-dim)] text-[var(--error)]"
          )}>
            <Icon className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <p className={cn(
              "text-sm font-semibold",
              result.passed ? "text-[var(--terminal)]" : "text-[var(--error)]"
            )}>
              {meta?.label || name}
            </p>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              {meta?.description || ""}
            </p>
            {result.error && (
              <p className="text-xs text-[var(--error)] mt-1 font-mono">{result.error}</p>
            )}
          </div>
        </div>
        <span className={cn(
          "flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-medium",
          result.passed ? "bg-[var(--terminal-faint)] text-[var(--terminal)]" : "bg-[var(--error-dim)] text-[var(--error)]"
        )}>
          {result.passed ? "PASS" : "FAIL"}
        </span>
      </div>
    </div>
  );
}

function ExploitFindings({ findings }: { findings: Array<{ probe: string; result: string; severity: string }> }) {
  if (!findings || findings.length === 0) {
    return (
      <div className="flex items-center gap-2 p-3 bg-[var(--terminal-faint)] border border-[var(--terminal)] rounded-lg">
        <CheckCircle2 className="w-4 h-4 text-[var(--terminal)]" />
        <span className="text-sm text-[var(--terminal)]">No exploit findings</span>
      </div>
    );
  }

  const severityColors: Record<string, string> = {
    high: "bg-[var(--error-dim)] text-[var(--error)] border-[var(--error)]/30",
    medium: "bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]",
    low: "bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]/30",
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold text-[var(--error)] flex items-center gap-2">
        <Shield className="w-4 h-4" />
        {findings.length} exploit {findings.length === 1 ? "finding" : "findings"} detected
      </p>
      {findings.map((f, i) => (
        <div key={i} className={cn(
          "flex items-start justify-between gap-3 p-3 rounded-lg border",
          severityColors[f.severity] || "bg-[var(--bg-secondary)] border-[var(--border-default)]"
        )}>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">{f.probe}</p>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">{f.result}</p>
          </div>
          <span className="text-xs font-medium capitalize px-1.5 py-0.5 rounded border">
            {f.severity}
          </span>
        </div>
      ))}
    </div>
  );
}

function PerformanceMetrics({ metrics }: { metrics: NonNullable<TestResults["performance_metrics"]> }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {metrics.step_time != null && (
        <div className="p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border-default)]">
          <p className="text-xs text-[var(--text-muted)] mb-1">Step time</p>
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            {typeof metrics.step_time === "number" ? metrics.step_time.toFixed(3) : metrics.step_time}ms
          </p>
        </div>
      )}
      {metrics.memory_peak != null && (
        <div className="p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border-default)]">
          <p className="text-xs text-[var(--text-muted)] mb-1">Memory peak</p>
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            {typeof metrics.memory_peak === "number" ? `${metrics.memory_peak.toFixed(1)}` : metrics.memory_peak}MB
          </p>
        </div>
      )}
      {metrics.episodes_per_second != null && (
        <div className="p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border-default)]">
          <p className="text-xs text-[var(--text-muted)] mb-1">Episodes/sec</p>
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            {typeof metrics.episodes_per_second === "number" ? metrics.episodes_per_second.toFixed(1) : metrics.episodes_per_second}
          </p>
        </div>
      )}
    </div>
  );
}

interface TestResultsPanelProps {
  testResults: TestResults;
}

export function TestResultsPanel({ testResults }: TestResultsPanelProps) {
  const categoryResults = testResults?.category_results || {};
  const categories = Object.entries(categoryResults);

  return (
    <div className="space-y-4">
      {/* Summary banner */}
      <div className={cn(
        "flex items-center gap-3 px-4 py-3 rounded-xl border",
        testResults?.passed ? "bg-[var(--terminal-faint)] border-[var(--terminal)]" : "bg-[var(--error-dim)] border-[var(--error)]"
      )}>
        {testResults?.passed ? (
          <CheckCircle2 className="w-5 h-5 text-[var(--terminal)] flex-shrink-0" />
        ) : (
          <XCircle className="w-5 h-5 text-[var(--error)] flex-shrink-0" />
        )}
        <div>
          <p className={cn(
            "text-sm font-semibold",
            testResults?.passed ? "text-[var(--terminal)]" : "text-[var(--error)]"
          )}>
            {testResults?.passed ? "All tests passed" : "Some tests failed"}
          </p>
          <p className="text-xs text-[var(--text-secondary)]">
            {testResults?.passed
              ? "Environment is ready for training"
              : "Review failures below for details"}
          </p>
        </div>
      </div>

      {/* Performance metrics */}
      {testResults?.performance_metrics && (
        <div>
          <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">Performance</h4>
          <PerformanceMetrics metrics={testResults.performance_metrics} />
        </div>
      )}

      {/* Exploit findings */}
      {(testResults?.exploit_findings?.length ?? 0) > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">Security Findings</h4>
          <ExploitFindings findings={testResults.exploit_findings!} />
        </div>
      )}

      {/* Category breakdown */}
      {categories.length > 0 ? (
        <div>
          <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-3">
            Test Categories ({categories.filter(([, r]) => r.passed).length}/{categories.length} passed)
          </h4>
          <div className="space-y-2">
            {categories.map(([name, result]) => (
              <CategoryCard key={name} name={name} result={result as CategoryResult} />
            ))}
          </div>
        </div>
      ) : testResults?.passed === undefined ? (
        <div className="flex items-center gap-2 p-4 text-sm text-[var(--text-muted)]">
          <Clock className="w-4 h-4 animate-spin" />
          Test results not yet available
        </div>
      ) : null}
    </div>
  );
}