/**
 * Lab signal compile — mirrors Eden model router T3 primary.
 * @see src/eden/optimization/model_router.py TIER_MODELS[T3]
 */
export const T3_PRIMARY_MODEL = "x-ai/grok-4.5";

export type CompiledSignalDraft = {
  name: string;
  description: string;
  kind: "error" | "latency" | "cost" | "policy" | "custom";
  severity: "critical" | "error" | "warn";
  condition: string;
  watching: string;
  model: string;
  tier: "t3";
};

export type CompileSignalRequest = {
  prompt: string;
  agentId?: string | null;
  notify?: boolean;
  channel?: "slack" | "email" | "webhook";
  destination?: string;
  severity?: "auto" | "critical" | "error" | "warn";
};

/** Local fallback when OpenRouter / gateway is unavailable. */
export function compileNaturalLanguageFallback(prompt: string): CompiledSignalDraft {
  const text = prompt.trim();
  const lower = text.toLowerCase();

  if (/python|command not found|exit 127|bash/.test(lower)) {
    return {
      name: "Python missing on bash",
      description: text,
      kind: "error",
      severity: "critical",
      condition: "bash.exit_code == 127 AND command matches /\\bpython\\b/",
      watching:
        "Bash exits with “command not found” when an agent calls bare python",
      model: "local-fallback",
      tier: "t3",
    };
  }
  if (/latency|slow|longer than|p95|timeout|fan-?out|second/.test(lower)) {
    return {
      name: "Slow tool fan-out",
      description: text,
      kind: "latency",
      severity: "warn",
      condition: "latency.tool_fanout.p95_ms > 900",
      watching: "Parallel tool calls stretch past ~900ms during a run",
      model: "local-fallback",
      tier: "t3",
    };
  }
  if (/write_file|eexist|already exists|loop/.test(lower)) {
    return {
      name: "write_file path conflict loop",
      description: text,
      kind: "error",
      severity: "error",
      condition: "tool.write_file.error == EEXIST count >= 2",
      watching: "write_file hits EEXIST twice or more in the same run",
      model: "local-fallback",
      tier: "t3",
    };
  }
  if (/cost|spend|\$|dollar|budget/.test(lower)) {
    return {
      name: "Run cost spike",
      description: text,
      kind: "cost",
      severity: "warn",
      condition: "run.cost_usd > 1.0",
      watching: "A single run’s spend crosses about $1",
      model: "local-fallback",
      tier: "t3",
    };
  }
  if (/pii|policy|leak|secret|credential/.test(lower)) {
    return {
      name: "Policy / PII risk",
      description: text,
      kind: "policy",
      severity: "critical",
      condition: "policy.pii_detected == true OR policy.secret_leak == true",
      watching: "Output looks like it contains PII or leaked secrets",
      model: "local-fallback",
      tier: "t3",
    };
  }

  const short =
    text.length > 48 ? `${text.slice(0, 45).trimEnd()}…` : text || "Custom signal";
  return {
    name: short,
    description: text || "Custom detector from natural language",
    kind: "custom",
    severity: "error",
    condition: `nl.match(${JSON.stringify(text.slice(0, 120))})`,
    watching: text
      ? `Eden will watch runs for: “${text}”`
      : "Describe what you want Eden to catch",
    model: "local-fallback",
    tier: "t3",
  };
}

export const COMPILE_SYSTEM_PROMPT = `You compile Eden observability signals from natural language.
Return ONLY valid JSON (no markdown) with this shape:
{
  "name": "short human title",
  "description": "the user's request, cleaned up",
  "kind": "error" | "latency" | "cost" | "policy" | "custom",
  "severity": "critical" | "error" | "warn",
  "condition": "compact matcher expression Eden can evaluate",
  "watching": "one plain-English sentence of what Eden will watch for"
}
Do not invent metric freestyle for the user to type — produce the condition yourself.
Keep name under 60 characters. Prefer practical detectors for agent runs.`;
