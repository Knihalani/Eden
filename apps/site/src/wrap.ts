import type { EdenDb } from "./db";
import { playTool } from "./playback";

export type OnTool = { id: string; name: string; steps: string; seen: string };

const RECENT_TTL_MS = 30 * 60_000;
const recentPlays = new Map<string, { facts: unknown; ok: boolean; at: number }>();

/**
 * Entries past the TTL are dead — the lookup tests age before use — but
 * nothing removed them, so a long-lived process grew this map with every
 * wrapped call for as long as it ran. Pruned on write instead: bounded
 * amortised cost, no timer.
 */
function rememberPlay(cacheKey: string, facts: unknown) {
  const now = Date.now();
  recentPlays.set(cacheKey, { facts, ok: true, at: now });
  if (recentPlays.size < 1024) return;
  for (const [k, v] of recentPlays) {
    if (now - v.at >= RECENT_TTL_MS) recentPlays.delete(k);
  }
  // Still over budget means the working set is genuinely hot; drop the oldest
  // half rather than growing without bound.
  if (recentPlays.size < 1024) return;
  const oldest = [...recentPlays.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, recentPlays.size >> 1);
  for (const [k] of oldest) recentPlays.delete(k);
}

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
  workspaceId: string,
  tool: OnTool,
  args: Record<string, string>,
  origin: string,
  runId?: string,
): Promise<{ action: "play"; facts: unknown; ok: boolean; server_ms: number }> {
  const issues = String(args.issues || args.ids || args.issue || args.id || args.pr || args.number || "");
  // Scoped by workspace, not just run:tool:issues. Tool ids are minted here as
  // UUIDs, so a collision needs a bug elsewhere — that is precisely what
  // defense-in-depth is for — and the cached facts of one tenant answering
  // another's call would be a silent cross-tenant leak.
  const cacheId = `${workspaceId}:${tool.id}:${issues}`;
  const cacheKey = runId ? `${runId}:${cacheId}` : "";
  if (cacheKey) {
    const hit = recentPlays.get(cacheKey);
    if (hit && Date.now() - hit.at < RECENT_TTL_MS) {
      return { action: "play", facts: hit.facts, ok: hit.ok, server_ms: 0 };
    }
    const row = await db.get<{ facts: string }>(
      `SELECT facts FROM wrap_cache WHERE run_id = ? AND tool_id = ?`,
      [runId, cacheId],
    );
    if (row?.facts) {
      try {
        const facts = JSON.parse(row.facts);
        recentPlays.set(cacheKey, { facts, ok: true, at: Date.now() });
        return { action: "play", facts, ok: true, server_ms: 0 };
      } catch {
        /* ignore corrupt cache */
      }
    }
  }
  const receipt = await playTool(db, tool, { ...args, origin });
  const facts = receipt.rows?.length ? receipt.rows : receipt.table || receipt.facts;
  if (cacheKey && receipt.ok) {
    rememberPlay(cacheKey, facts);
    await db.run(
      `INSERT INTO wrap_cache (run_id, tool_id, facts, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id, tool_id) DO UPDATE SET facts = excluded.facts, created_at = excluded.created_at`,
      [runId, cacheId, JSON.stringify(facts ?? null), Date.now()],
    );
    // A run_id never repeats, so rows past a week are unreachable by any
    // future lookup — same unbounded-growth shape as result_cache. Swept on
    // the same ~2% sample so the hot path pays almost nothing.
    if (Math.random() < 0.02) {
      void db
        .run(`DELETE FROM wrap_cache WHERE created_at < ?`, [Date.now() - 7 * 24 * 60 * 60_000])
        .catch(() => undefined);
    }
  }
  return { action: "play", facts, ok: receipt.ok, server_ms: receipt.server_ms };
}
