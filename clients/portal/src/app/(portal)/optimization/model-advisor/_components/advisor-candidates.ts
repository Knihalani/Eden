"use client";

export interface CandidateOption {
  provider: string;
  modelId: string;
  label: string;
  tier: "frontier" | "mid" | "budget" | "local";
  color: string;
}

export const CANDIDATES: CandidateOption[] = [
  // OpenAI
  { provider: "openai",     modelId: "gpt-5",            label: "GPT-5",         tier: "frontier", color: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30" },
  { provider: "openai",     modelId: "gpt-5-mini",       label: "GPT-5 mini",    tier: "mid",      color: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30" },
  { provider: "openai",     modelId: "gpt-5-nano",       label: "GPT-5 nano",    tier: "budget",   color: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30" },
  { provider: "openai",     modelId: "gpt-4o",           label: "GPT-4o",        tier: "frontier", color: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30" },
  { provider: "openai",     modelId: "gpt-4o-mini",      label: "GPT-4o mini",   tier: "mid",      color: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30" },
  { provider: "openai",     modelId: "o3",               label: "o3 (reasoning)", tier: "frontier", color: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30" },
  { provider: "openai",     modelId: "o3-mini",          label: "o3-mini",       tier: "mid",      color: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30" },
  // Anthropic
  { provider: "anthropic",  modelId: "claude-opus-4-5",  label: "Claude Opus 4.5", tier: "frontier", color: "bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]/30" },
  { provider: "anthropic",  modelId: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "frontier", color: "bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]/30" },
  { provider: "anthropic",  modelId: "claude-haiku-4-5", label: "Claude Haiku 4.5", tier: "mid", color: "bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]/30" },
  // Google
  { provider: "google",     modelId: "gemini-3-pro",     label: "Gemini 3 Pro",  tier: "frontier", color: "bg-sky-500/10 text-sky-300 border-sky-500/30" },
  { provider: "google",     modelId: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "mid", color: "bg-sky-500/10 text-sky-300 border-sky-500/30" },
  // Local / self-hosted
  { provider: "ollama",     modelId: "llama3.1:8b",      label: "Llama 3.1 8B (local)", tier: "local", color: "bg-zinc-500/10 text-zinc-300 border-zinc-500/30" },
  { provider: "vllm",       modelId: "qwen2.5:32b",      label: "Qwen 2.5 32B (local)", tier: "local", color: "bg-zinc-500/10 text-zinc-300 border-zinc-500/30" },
];

export const DEFAULT_CANDIDATE_IDS = [
  "openai::gpt-4o",
  "openai::gpt-4o-mini",
  "anthropic::claude-sonnet-4-6",
  "google::gemini-2.5-flash",
];

export function optKey(c: CandidateOption): string {
  return `${c.provider}::${c.modelId}`;
}

export function findOpt(provider: string, modelId: string): CandidateOption | undefined {
  return CANDIDATES.find((c) => c.provider === provider && c.modelId === modelId);
}

// ─────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────

export function fmtUsd(n: number, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (opts.compact) {
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
    if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
    return `${sign}$${(abs * 100).toFixed(1)}¢`;
  }
  if (abs === 0) return "$0.00";
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  if (abs < 1) return `${sign}$${abs.toFixed(3)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

export function fmtMs(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(2)}s`;
  return `${Math.round(n)}ms`;
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${Math.round(n)}`;
}
