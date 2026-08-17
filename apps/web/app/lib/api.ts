import type { Edits, Inbox } from "./types";

export function packEdits(
  name: string,
  original: string,
  drop: string[],
  forceIsland: string[],
  pinAssert: string[],
): Edits | undefined {
  const edits: Edits = {};
  if (name.trim() && name.trim() !== original) edits.name = name.trim();
  if (drop.length) edits.drop = drop;
  if (forceIsland.length) edits.forceIsland = forceIsland;
  if (pinAssert.length) edits.pinAssert = pinAssert;
  return edits.name || edits.drop || edits.forceIsland || edits.pinAssert ? edits : undefined;
}

export async function getInbox(): Promise<Inbox> {
  const r = await fetch("/v1/inbox", { cache: "no-store" });
  if (!r.ok) throw new Error(`inbox ${r.status}`);
  return r.json() as Promise<Inbox>;
}

export async function postJson(path: string, token: string, body: unknown = {}) {
  const r = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(j.error || `${r.status}`);
  return j;
}

export function approve(id: string, token: string, edits?: Edits) {
  return postJson(`/v1/tools/${id}/approve`, token, { edits });
}

export function compileTraces(token: string) {
  return postJson("/v1/compile", token);
}

export function pauseTool(id: string, token: string) {
  return postJson(`/v1/tools/${id}/pause`, token);
}

export function resumeTool(id: string, token: string) {
  return postJson(`/v1/tools/${id}/resume`, token);
}

export function rollbackTool(id: string, token: string) {
  return postJson(`/v1/tools/${id}/rollback`, token);
}

export function dismissCandidate(id: string, token: string) {
  return fetch(`/v1/candidates/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  }).then(async (r) => {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) throw new Error(j.error || `${r.status}`);
  });
}

export function seqLabel(names: string[]): string {
  return names.join(" → ");
}

export function fmtX(n: number | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "—";
  return `${n.toFixed(1)}×`;
}

export function fmtMs(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

export function ago(ts: number | undefined): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export async function getReceipts(token: string, toolId: string) {
  const r = await fetch(`/v1/receipts?tool=${encodeURIComponent(toolId)}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`receipts ${r.status}`);
  return r.json() as Promise<{
    receipts: Array<{ id: string; ok: number; ms: number; llm_calls: number; created_at: number }>;
  }>;
}
