/** Shared display formatters for Observe traces/sessions rows. */

export function formatLatency(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const delta = Date.now() - ms;
  const mins = Math.round(delta / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function shortId(id: string, len = 8): string {
  if (id.length <= len) return id;
  return id.slice(0, len);
}

export function kindFromEventType(eventType: string | undefined): string {
  const t = (eventType ?? "").toLowerCase();
  if (t.includes("llm") || t.includes("chat") || t.includes("generation")) {
    return "llm";
  }
  if (t.includes("tool")) return "tool";
  if (t.includes("subagent") || t.includes("agent")) return "subagent";
  if (t.includes("error") || t.includes("fail")) return "error";
  return "span";
}
