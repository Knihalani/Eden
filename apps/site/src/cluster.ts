import type { EdenDb } from "./db";
import {
  compileStepUrl,
  cutIslands,
  fingerprintIsland,
  heuristicName,
  mergeConstantFlip,
  requiredK,
  type ToolEvent,
} from "@eden/core";

export async function ingest(
  db: EdenDb,
  workspaceId: string,
  runId: string,
  events: ToolEvent[],
  stretchEnd: boolean,
) {
  for (const e of events) {
    await db.run(
      `INSERT OR IGNORE INTO tool_event (event_id, workspace_id, run_id, seq, name, args, command, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.event_id,
        workspaceId,
        runId,
        e.seq,
        e.name,
        JSON.stringify(e.args || {}),
        e.command ?? (e.args as { command?: string })?.command ?? null,
        e.ok ? 1 : 0,
      ],
    );
  }
  if (!stretchEnd) return { drafts: 0 };
  const rows = await db.all<{
    event_id: string;
    seq: number;
    name: string;
    args: string;
    command: string | null;
    ok: number;
  }>(`SELECT event_id, seq, name, args, command, ok FROM tool_event WHERE run_id = ? ORDER BY seq`, [runId]);
  const parsed: ToolEvent[] = rows.map((r) => ({
    event_id: r.event_id,
    seq: r.seq,
    name: r.name,
    args: JSON.parse(r.args || "{}"),
    command: r.command || undefined,
    ok: Number(r.ok) === 1,
  }));
  const islands = cutIslands(parsed);
  let drafts = 0;
  for (const [island_index, steps] of islands.entries()) {
    const fp = fingerprintIsland(steps);
    const ignored = await db.get(`SELECT 1 as ok FROM ignore_fp WHERE workspace_id = ? AND fingerprint = ?`, [
      workspaceId,
      fp,
    ]);
    if (ignored) continue;
    const dup = await db.get(`SELECT 1 as ok FROM stretch WHERE run_id = ? AND fingerprint = ? AND island_index = ?`, [
      runId,
      fp,
      island_index,
    ]);
    if (dup) continue;
    await db.run(
      `INSERT INTO stretch (id, workspace_id, run_id, fingerprint, steps, island_index) VALUES (?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), workspaceId, runId, fp, JSON.stringify(steps), island_index],
    );
    const existing = await db.get<{ count: number; status: string; steps: string }>(
      `SELECT count, status, steps FROM cluster WHERE fingerprint = ?`,
      [fp],
    );
    let storedSteps = steps;
    if (existing?.steps) {
      try {
        const prev = JSON.parse(existing.steps);
        storedSteps = mergeConstantFlip(prev, steps) || steps;
      } catch {
        storedSteps = steps;
      }
    }
    const count = (existing?.count || 0) + 1;
    await db.run(
      `INSERT INTO cluster (fingerprint, workspace_id, count, steps, status) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET count = excluded.count, steps = excluded.steps`,
      [fp, workspaceId, count, JSON.stringify(storedSteps), count >= 2 ? "knock" : "draft"],
    );
    if (count === 1) {
      const id = crypto.randomUUID();
      const name = heuristicName(storedSteps);
      await db.run(
        `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint, required_k)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
        [
          id,
          workspaceId,
          name,
          `Use when repeating ${name.replaceAll("_", " ")}`,
          JSON.stringify(stepsToCompiled(storedSteps)),
          JSON.stringify(storedSteps.map((s) => s.name)),
          fp,
          requiredK(storedSteps),
        ],
      );
      drafts++;
    }
    if (count === 2) {
      const tool = await db.get<{ id: string }>(`SELECT id FROM tool WHERE fingerprint = ?`, [fp]);
      if (tool) {
        await db.run(`UPDATE tool SET steps = ?, seen = ? WHERE id = ?`, [
          JSON.stringify(stepsToCompiled(storedSteps)),
          JSON.stringify(storedSteps.map((s) => s.name)),
          tool.id,
        ]);
        await db.run(`INSERT INTO knock (id, workspace_id, tool_id, attempt, resolution) VALUES (?, ?, ?, 1, NULL)`, [
          crypto.randomUUID(),
          workspaceId,
          tool.id,
        ]);
      }
    }
  }
  return { drafts, islands: islands.length };
}

function stepsToCompiled(steps: ReturnType<typeof cutIslands>[number]) {
  return steps.map((s, i) => ({
    id: `s${i + 1}`,
    kind: s.kind,
    name: s.name,
    commute: s.commute,
    url: compileStepUrl(s),
    command: s.cli_family,
  }));
}
