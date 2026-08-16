import type { EdenDb } from "./db";
import {
  compileStepUrl,
  cutIslands,
  fingerprintIsland,
  heuristicName,
  mergeConstantFlip,
  parameterizeUrl,
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
      const compiled = stepsToCompiled(storedSteps);
      const base = heuristicName(storedSteps);
      const prior =
        base.startsWith("github_pr_bundle")
          ? await db.get<{ id: string; steps: string }>(
              `SELECT id, steps FROM tool WHERE workspace_id = ? AND (name = 'github_pr_bundle' OR name LIKE 'github_pr_bundle_%') LIMIT 1`,
              [workspaceId],
            )
          : undefined;
      if (prior) {
        const prev = JSON.parse(prior.steps || "[]") as Array<{ url?: string }>;
        const next = compiled.length >= prev.length ? compiled : prev;
        await db.run(`UPDATE tool SET steps = ?, seen = ?, when_to_use = ? WHERE id = ?`, [
          JSON.stringify(next),
          JSON.stringify(storedSteps.map((s) => s.name)),
          whenToUse(base),
          prior.id,
        ]);
        await maybeAutoOn(db, prior.id, compiled);
      } else {
        const id = crypto.randomUUID();
        const name = await uniqueToolName(db, workspaceId, base);
        await db.run(
          `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint, required_k)
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
          [
            id,
            workspaceId,
            name,
            whenToUse(name),
            JSON.stringify(compiled),
            JSON.stringify(storedSteps.map((s) => s.name)),
            fp,
            requiredK(storedSteps),
          ],
        );
        await maybeAutoOn(db, id, compiled);
        drafts++;
      }
    }
    if (count === 2) {
      const tool = await db.get<{ id: string }>(`SELECT id FROM tool WHERE fingerprint = ?`, [fp]);
      if (tool) {
        const compiled = stepsToCompiled(storedSteps);
        await db.run(`UPDATE tool SET steps = ?, seen = ?, when_to_use = ? WHERE id = ?`, [
          JSON.stringify(compiled),
          JSON.stringify(storedSteps.map((s) => s.name)),
          whenToUse(heuristicName(storedSteps)),
          tool.id,
        ]);
        await maybeAutoOn(db, tool.id, compiled);
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

async function uniqueToolName(db: EdenDb, workspaceId: string, base: string): Promise<string> {
  let name = base.slice(0, 48);
  let n = 2;
  while (await db.get(`SELECT 1 as ok FROM tool WHERE workspace_id = ? AND name = ?`, [workspaceId, name])) {
    name = `${base.slice(0, 44)}_${n++}`;
  }
  return name;
}

function whenToUse(name: string): string {
  if (name.startsWith("github_pr_bundle")) return "issues csv. table: n | title | reviews:int | CI | files:int";
  if (name.startsWith("github_pr_files")) return "issues: csv of PRs. table: number | files";
  if (name.startsWith("github_issue_bundle")) return "issues: csv. table: number | title | comments";
  return `One call with all ids for ${name.replaceAll("_", " ")}.`;
}

async function maybeAutoOn(
  db: EdenDb,
  toolId: string,
  compiled: Array<{ url?: string }>,
): Promise<void> {
  if (process.env.EDEN_AUTO_APPROVE !== "1") return;
  if (!compiled.some((s) => Boolean(s.url))) return;
  await db.run(`UPDATE tool SET state = 'on', published = 1 WHERE id = ?`, [toolId]);
}

function stepsToCompiled(steps: ReturnType<typeof cutIslands>[number]) {
  const seen = new Set<string>();
  const compiled: Array<{
    id: string;
    kind: string;
    name: string;
    commute: boolean;
    url?: string;
    command?: string;
    bind?: Record<string, string>;
  }> = [];
  for (const s of steps) {
    const url = compileStepUrl(s);
    const key = url ? parameterizeUrl(url) : s.name;
    if (seen.has(key)) continue;
    seen.add(key);
    compiled.push({
      id: `s${compiled.length + 1}`,
      kind: s.kind,
      name: s.name,
      commute: s.commute,
      url,
      command: s.cli_family,
    });
  }
  if (heuristicName(steps).startsWith("github_pr_bundle") && !compiled.some((s) => /\/files/.test(s.url || ""))) {
    const pull = compiled.find((s) => /\/pulls\/\{issue\}$/.test(s.url || ""));
    if (pull?.url) {
      compiled.push({
        id: `s${compiled.length + 1}`,
        kind: "cloud_http",
        name: "gh.api",
        commute: true,
        url: `${pull.url}/files`,
        command: "gh.api",
      });
    }
  }
  compiled.sort((a, b) => rankPlaybackUrl(a.url || "") - rankPlaybackUrl(b.url || ""));
  for (let i = 0; i < compiled.length; i++) compiled[i].id = `s${i + 1}`;
  for (let i = 0; i < compiled.length; i++) {
    const url = compiled[i].url || "";
    if (!url.includes("{sha}")) continue;
    const prior = compiled.find((s, j) => j < i && /\/(pulls|issues)\/\{issue\}$/.test(s.url || ""));
    if (prior) compiled[i].bind = { sha: `{{${prior.id}.head.sha}}` };
  }
  return compiled.map(({ bind, ...rest }) => (bind ? { ...rest, bind } : rest));
}

function rankPlaybackUrl(url: string): number {
  if (/\/(pulls|issues)\/\{issue\}$/.test(url)) return 1;
  if (/\/reviews/.test(url)) return 2;
  if (/\/status|\/check-runs/.test(url)) return 3;
  if (/\/files/.test(url)) return 4;
  return 5;
}
