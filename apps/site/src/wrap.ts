import type { EdenDb } from "./db";
import { playTool } from "./playback";

export type OnTool = { id: string; name: string; steps: string; seen: string };

const recentPlays = new Map<string, { facts: unknown; ok: boolean; at: number }>();

export async function findOnTool(db: EdenDb, workspaceId: string, name: string): Promise<OnTool | undefined> {
  const byName = await db.get<OnTool>(
    `SELECT id, name, steps, seen FROM tool WHERE workspace_id = ? AND name = ? AND state = 'on'`,
    [workspaceId, name],
  );
  if (byName) return byName;
  const tools = await db.all<OnTool>(
    `SELECT id, name, steps, seen FROM tool WHERE workspace_id = ? AND state = 'on'`,
    [workspaceId],
  );
  return tools.find((t) => {
    try {
      const seen = JSON.parse(t.seen || "[]") as string[];
      return seen.includes(name);
    } catch {
      return false;
    }
  });
}

export function toolHasPlayback(tool: OnTool): boolean {
  try {
    const steps = JSON.parse(tool.steps || "[]") as Array<{ url?: string }>;
    return steps.some((s) => Boolean(s.url));
  } catch {
    return false;
  }
}

export async function wrapPlay(
  db: EdenDb,
  tool: OnTool,
  args: Record<string, string>,
  origin: string,
  runId?: string,
): Promise<{ action: "play"; facts: unknown; ok: boolean; server_ms: number }> {
  const issues = String(args.issues || args.issue || args.pr || args.number || "");
  const cacheId = `${tool.id}:${issues}`;
  const cacheKey = runId ? `${runId}:${cacheId}` : "";
  if (cacheKey) {
    const hit = recentPlays.get(cacheKey);
    if (hit && Date.now() - hit.at < 120_000) {
      return { action: "play", facts: hit.facts, ok: hit.ok, server_ms: 0 };
    }
    const row = await db.get<{ facts: string }>(
      `SELECT facts FROM wrap_cache WHERE run_id = ? AND tool_id = ?`,
      [runId, cacheId],
    );
    if (row?.facts) {
      const facts = JSON.parse(row.facts);
      recentPlays.set(cacheKey, { facts, ok: true, at: Date.now() });
      return { action: "play", facts, ok: true, server_ms: 0 };
    }
  }
  const receipt = await playTool(db, tool, { ...args, origin });
  const facts = receipt.table || receipt.facts;
  if (cacheKey && receipt.ok) {
    recentPlays.set(cacheKey, { facts, ok: true, at: Date.now() });
    await db.run(
      `INSERT INTO wrap_cache (run_id, tool_id, facts, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id, tool_id) DO UPDATE SET facts = excluded.facts, created_at = excluded.created_at`,
      [runId, cacheId, JSON.stringify(facts ?? null), Date.now()],
    );
  }
  return { action: "play", facts, ok: receipt.ok, server_ms: receipt.server_ms };
}
