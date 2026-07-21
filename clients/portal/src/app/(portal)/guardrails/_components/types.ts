import { Shield, Bug, FileLock2, Sparkles, Eye } from "lucide-react";

export type GuardrailsTab =
  | "policies"
  | "test"
  | "injections"
  | "pii"
  | "redteam";

export const GUARDRAILS_TABS = [
  "policies",
  "test",
  "injections",
  "pii",
  "redteam",
] as const;

/** Primary first-paint tabs — Red-team report lives in More (Wave 6.1). */
export const GUARDRAILS_PRIMARY_TABS = ["policies", "test"] as const;

export interface Policy {
  policy_id: string;
  name: string;
  kind: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface Violation {
  policy_id: string;
  severity: string;
  reason: string;
}

export interface EvaluateResult {
  passed: boolean;
  violations: Violation[];
  live?: boolean;
  verdict?: string;
  reason?: string;
}

export interface InjectionResult {
  injection_score: number;
  is_injection: boolean;
  matched_patterns: string[];
}

export interface PiiRedaction {
  category: string;
  count: number;
}

export interface RedactResult {
  redacted_content: string;
  redactions: PiiRedaction[];
}

export type TestResultKind = "evaluate" | "injection" | "redact";

export const KIND_LABELS: Record<
  string,
  {
    label: string;
    color: string;
    icon: typeof Shield;
  }
> = {
  injection: {
    label: "Injection",
    color: "bg-[var(--error-bg)] text-[var(--error)]",
    icon: Bug,
  },
  pii: {
    label: "PII",
    color: "bg-[var(--warning-bg)] text-[var(--warning)]",
    icon: FileLock2,
  },
  hallucination: {
    label: "Hallucination",
    color: "bg-[var(--warning-bg)] text-[var(--warning)]",
    icon: Sparkles,
  },
  content: {
    label: "Content",
    color: "bg-[var(--accent-faint)] text-[var(--accent)]",
    icon: Eye,
  },
};

export const SEVERITY_STYLES: Record<
  string,
  {
    bar: string;
    chip: string;
    icon: "high" | "default";
  }
> = {
  critical: {
    bar: "border-l-[3px] border-l-[var(--error)]",
    chip: "bg-[var(--error-dim)] text-[var(--error)]",
    icon: "high",
  },
  high: {
    bar: "border-l-[3px] border-l-[var(--error)]",
    chip: "bg-[var(--error-dim)] text-[var(--error)]",
    icon: "high",
  },
  medium: {
    bar: "border-l-[3px] border-l-[var(--warning)]",
    chip: "bg-[var(--warning-bg)] text-[var(--warning)]",
    icon: "default",
  },
  low: {
    bar: "border-l-[3px] border-l-[var(--terminal)]",
    chip: "bg-[var(--terminal-faint)] text-[var(--terminal)]",
    icon: "default",
  },
  info: {
    bar: "border-l-[3px] border-l-[var(--accent)]",
    chip: "bg-[var(--accent-faint)] text-[var(--accent)]",
    icon: "default",
  },
};
