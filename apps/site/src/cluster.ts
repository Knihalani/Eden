import type { EdenDb } from "./db";
import {
  compileStepUrl,
  cutIslands,
  extractLoopIds,
  fingerprintIsland,
  heuristicName,
  isCompilableToolName,
  mergeConstantFlip,
  parameterizeUrl,
  requiredK,
  type ToolEvent,
} from "@eden/core";

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

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
  await rememberIssues(db, workspaceId, events);
  if (!stretchEnd) return { drafts: 0 };
  const rows = await db.all<{
    event_id: string;
    seq: number;
    name: string;
    args: string;
    command: string | null;
    ok: number;
  }>(`SELECT event_id, seq, name, args, command, ok FROM tool_event WHERE workspace_id = ? AND run_id = ? ORDER BY seq`, [
    workspaceId,
    runId,
  ]);
  const parsed: ToolEvent[] = rows.map((r) => ({
    event_id: r.event_id,
    seq: r.seq,
    name: r.name,
    args: parseJson(r.args || "{}", {}),
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
    const dup = await db.get(`SELECT 1 as ok FROM stretch WHERE workspace_id = ? AND run_id = ? AND fingerprint = ? AND island_index = ?`, [
      workspaceId,
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
      `SELECT count, status, steps FROM cluster WHERE fingerprint = ? AND workspace_id = ?`,
      [fp, workspaceId],
    );
    let storedSteps = steps;
    if (existing?.steps) {
      const prev = parseJson(existing.steps, null as unknown[] | null);
      storedSteps = (Array.isArray(prev) ? mergeConstantFlip(prev as typeof steps, steps) : null) || steps;
    }
    // The conflict target is scoped, so one tenant's ingest can no longer land
    // in another's row. The count is incremented in SQL rather than
    // read-modify-written: two concurrent ingests both read N and both wrote
    // N+1, and because the knock below tests the count exactly, a single lost
    // update left the cluster stuck as a draft forever.
    await db.run(
      `INSERT INTO cluster (fingerprint, workspace_id, count, steps, status) VALUES (?, ?, 1, ?, 'draft')
       ON CONFLICT(workspace_id, fingerprint) DO UPDATE SET
         count = cluster.count + 1,
         steps = excluded.steps,
         status = CASE WHEN cluster.count + 1 >= 2 THEN 'knock' ELSE 'draft' END`,
      [fp, workspaceId, JSON.stringify(storedSteps)],
    );
    const after = await db.get<{ count: number }>(
      `SELECT count FROM cluster WHERE fingerprint = ? AND workspace_id = ?`,
      [fp, workspaceId],
    );
    const count = Number(after?.count ?? (existing?.count || 0) + 1);
    if (count === 1) {
      const compiled = stepsToCompiled(storedSteps);
      const base = heuristicName(storedSteps);
      if (!isCompilableToolName(base)) continue;
      const prior = await db.get<{ id: string; steps: string }>(
        `SELECT id, steps FROM tool WHERE workspace_id = ? AND (name = ? OR name LIKE ?) LIMIT 1`,
        [workspaceId, base, `${base}_%`],
      );
      if (prior) {
        const prev = parseJson(prior.steps || "[]", [] as Array<{ url?: string }>);
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
    // `>= 2`, not `=== 2`: if the count ever skips past 2 — a concurrent
    // ingest, a replayed batch — an exact test means the knock is never created
    // and the tool stays a draft permanently. The insert below is guarded by
    // the absence of an existing knock, so a later ingest cannot duplicate it.
    if (count >= 2) {
      const tool = await db.get<{ id: string }>(`SELECT id FROM tool WHERE fingerprint = ? AND workspace_id = ?`, [fp, workspaceId]);
      const already = tool
        ? await db.get<{ id: string }>(`SELECT id FROM knock WHERE tool_id = ? AND workspace_id = ?`, [
            tool.id,
            workspaceId,
          ])
        : undefined;
      if (tool && !already) {
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

async function rememberIssues(db: EdenDb, workspaceId: string, events: ToolEvent[]): Promise<void> {
  const now = Date.now();
  const ids = new Set<string>();
  for (const e of events) {
    const command = e.command || String((e.args as { command?: string } | undefined)?.command || "");
    for (const n of extractLoopIds(command)) ids.add(n);
  }
  for (const issue of ids) {
    await db.run(`INSERT OR REPLACE INTO watched_issue (workspace_id, issue, seen_at) VALUES (?, ?, ?)`, [
      workspaceId,
      issue,
      now,
    ]);
  }
}

async function uniqueToolName(db: EdenDb, workspaceId: string, base: string): Promise<string> {
  let name = base.slice(0, 48);
  let n = 2;
  while (await db.get(`SELECT 1 as ok FROM tool WHERE workspace_id = ? AND name = ?`, [workspaceId, name])) {
    name = `${base.slice(0, 44)}_${n++}`;
  }
  return name;
}

/**
 * The tool description the model actually sees.
 *
 * Kept terse — it is truncated to MCP_DESC_CHARS — but every branch now says
 * what the tool *replaces*. The three special-cased families used to return a
 * bare schema hint with no preference language at all, which left the flagship
 * `github_pr_bundle` competing against the model's habit of writing the loop
 * with nothing but a field list. The generic branch had always said it.
 */
function whenToUse(name: string): string {
  if (name.startsWith("github_pr_bundle")) {
    return "issues csv → JSON [{number,title,reviews:int,status:CI,files:int}]. One call for all PRs; use instead of a per-PR gh api loop.";
  }
  if (name.startsWith("github_pr_files")) {
    return "issues csv → number | files. One call for all PRs; use instead of a per-PR gh api loop.";
  }
  if (name.startsWith("github_issue_bundle")) {
    return "issues csv → number | title | comments. One call for all issues; use instead of a per-issue gh api loop.";
  }
  const label = name.replaceAll("_", " ");
  return `ids csv → JSON rows from ${label}. Prefer this over repeating the same curl/CLI loop.`;
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
  if (heuristicName(steps).startsWith("github_pr")) ensurePrBundleSteps(compiled);
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

function githubRepoOrigin(url: string): string | undefined {
  const m = url.match(/^(https?:\/\/[^/]+\/(?:forge\/)?repos\/[^/]+\/[^/]+)/);
  return m?.[1];
}

function ensurePrBundleSteps(
  compiled: Array<{
    id: string;
    kind: string;
    name: string;
    commute: boolean;
    url?: string;
    command?: string;
    bind?: Record<string, string>;
  }>,
): void {
  const origin = compiled.map((s) => githubRepoOrigin(s.url || "")).find(Boolean);
  if (!origin) return;
  const add = (url: string) => {
    if (compiled.some((s) => s.url === url)) return;
    compiled.push({
      id: `s${compiled.length + 1}`,
      kind: "cloud_http",
      name: "gh.api",
      commute: true,
      url,
      command: "gh.api",
    });
  };
  add(`${origin}/pulls/{issue}`);
  add(`${origin}/pulls/{issue}/reviews`);
  add(`${origin}/commits/{sha}/status`);
  add(`${origin}/pulls/{issue}/files`);
}

function rankPlaybackUrl(url: string): number {
  if (/\/(pulls|issues)\/\{issue\}$/.test(url)) return 1;
  if (/\/reviews/.test(url)) return 2;
  if (/\/status|\/check-runs/.test(url)) return 3;
  if (/\/files/.test(url)) return 4;
  return 5;
}
