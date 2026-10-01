import type { EdenDb } from "./db";
import { canaryWorkspaceDeps } from "./canary-bind";
import { maybeRecompileWorkspace } from "./canary";
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
  templateKeys,
  toolNameFromUrls,
  type ToolEvent,
} from "@eden/core";

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function ingest(db: EdenDb, workspaceId: string, runId: string, events: ToolEvent[], stretchEnd: boolean) {
  // The events are independent rows keyed by (workspace_id, event_id) and are
  // read back ORDER BY seq, so insertion order carries no meaning. One round
  // trip per event dominated ingest latency on a remote driver, and Promise.all
  // only hides it up to the connection pool — a 100-event batch is one INSERT
  // per chunk now, not one per event.
  const CHUNK = 50;
  for (let i = 0; i < events.length; i += CHUNK) {
    const chunk = events.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => `(?, ?, ?, ?, ?, ?, ?, ?, ?)`).join(", ");
    await db.run(
      `INSERT OR IGNORE INTO tool_event (event_id, workspace_id, run_id, seq, name, args, command, ok, created_at)
       VALUES ${placeholders}`,
      chunk.flatMap((e) => [
        e.event_id,
        workspaceId,
        runId,
        // Normalised, not trusted: SQLite's INTEGER affinity silently accepts
        // a numeric string where Postgres refuses the bind — the same payload
        // must not succeed locally and 500 remotely.
        Number.isFinite(Number(e.seq)) ? Number(e.seq) : 0,
        String(e.name ?? ""),
        JSON.stringify(e.args || {}),
        e.command ?? (e.args as { command?: string })?.command ?? null,
        e.ok ? 1 : 0,
        Date.now(),
      ]),
    );
  }
  await rememberIssues(db, workspaceId, events);
  // Fire-and-forget drift canary: after the events are persisted, sweep this
  // workspace's deopt ledger and queue a recompiled draft for any tool that
  // has drifted enough. It is guarded twice over so ingest latency stays
  // exactly what it was — the call is not awaited, and a synchronous throw
  // before the first await cannot escape either.
  // On Vercel, Fluid Compute waits for pending promises before freezing the
  // isolate. Starting the canary here made POST /v1/ingest look hung.
  if (!process.env.VERCEL) {
    try {
      void maybeRecompileWorkspace(db, workspaceId, canaryWorkspaceDeps()).catch(() => undefined);
    } catch {
      /* ingest must never wait on the canary */
    }
  }
  // Sampled housekeeping, same shape as the result_cache sweep. tool_event
  // and stretch are mining inputs, not records queried forever; without a
  // ceiling a long-lived install grew both without bound. TTL-based, because
  // there is no portable "newest N" across SQLite and Postgres.
  if (Math.random() < 0.02) {
    const cutoff = Date.now() - 14 * 24 * 60 * 60_000;
    void db.run(`DELETE FROM tool_event WHERE created_at < ?`, [cutoff]).catch(() => undefined);
    void db.run(`DELETE FROM stretch WHERE created_at < ?`, [cutoff]).catch(() => undefined);
    // Watched issues drive cache warming; anything colder than a month will
    // not be re-warmed. Also bounds what one ingest can plant: every numeric
    // id harvested from recorded commands becomes a row here.
    void db
      .run(`DELETE FROM watched_issue WHERE seen_at < ?`, [Date.now() - 30 * 24 * 60 * 60_000])
      .catch(() => undefined);
  }
  if (!stretchEnd) return { drafts: 0, islands: 0, stored: events.length };
  const rows = await db.all<{
    event_id: string;
    seq: number;
    name: string;
    args: string;
    command: string | null;
    ok: number;
  }>(
    `SELECT event_id, seq, name, args, command, ok FROM tool_event WHERE workspace_id = ? AND run_id = ? ORDER BY seq`,
    [workspaceId, runId],
  );
  const parsed: ToolEvent[] = rows.map((r) => ({
    event_id: r.event_id,
    seq: r.seq,
    name: r.name,
    args: parseJson(r.args || "{}", {}),
    command: r.command || undefined,
    ok: Number(r.ok) === 1,
  }));
  // Prior ingests' shell commands vote on slot variation: the first run of
  // `kubectl logs api -n dev` has no peers, but its stored command lets the
  // second run (`logs web`) abstract both onto one skeleton — which is what
  // makes their fingerprints merge instead of forking per pod name.
  const priorShell = await db.all<{ steps: string }>(
    `SELECT steps FROM stretch WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200`,
    [workspaceId],
  );
  const peerCommands: string[] = [];
  for (const r of priorShell) {
    const arr = parseJson(r.steps, [] as unknown[]);
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      if (s && typeof s === "object" && typeof (s as { command?: unknown }).command === "string") {
        peerCommands.push((s as { command: string }).command);
      }
    }
  }
  const islands = cutIslands(parsed, {
    // Laptop registries execute runner steps (Bash/cwd/fs), so a local wrap
    // may compile pure-CLI stretches — kubectl/aws/psql loops. The hosted
    // MCP cannot play them ("runner_unbound"), so cloud-only stays the
    // default there.
    allowRunnerOnly: process.env.EDEN_RUNNER_ISLANDS === "1",
    peerCommands,
  });
  let drafts = 0;
  for (const [island_index, steps] of islands.entries()) {
    const fp = fingerprintIsland(steps);
    const ignored = await db.get(`SELECT 1 as ok FROM ignore_fp WHERE workspace_id = ? AND fingerprint = ?`, [
      workspaceId,
      fp,
    ]);
    if (ignored) continue;
    const dup = await db.get(
      `SELECT 1 as ok FROM stretch WHERE workspace_id = ? AND run_id = ? AND fingerprint = ? AND island_index = ?`,
      [workspaceId, runId, fp, island_index],
    );
    if (dup) continue;
    // OR IGNORE, not INSERT: the dup-check read races concurrent ingests of
    // the same run, and the unique index from migrate() is what actually
    // enforces one observation — a loser here just keeps its count honest.
    await db.run(
      `INSERT OR IGNORE INTO stretch (id, workspace_id, run_id, fingerprint, steps, island_index, ` +
        `created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), workspaceId, runId, fp, JSON.stringify(steps), island_index, Date.now()],
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
      // Named from the *enriched* compiled steps, not the raw island: two
      // observations of one routine that happen to carry different endpoint
      // subsets (a PR loop with files, one without) canonicalise to the same
      // compiled steps here, so they must land on the same tool name and the
      // second observation updates the first instead of forking it.
      const base = toolNameFromUrls(compiled.map((s) => s.url || "").filter(Boolean)) || heuristicName(storedSteps);
      if (!isCompilableToolName(base)) continue;
      const prior = await db.get<{ id: string; steps: string }>(
        `SELECT id, steps FROM tool WHERE workspace_id = ? AND (name = ? OR name LIKE ?) LIMIT 1`,
        [workspaceId, base, `${base}_%`],
      );
      if (prior) {
        const prev = parseJson(prior.steps || "[]", [] as Array<{ url?: string }>);
        const next = compiled.length >= prev.length ? compiled : prev;
        // `state = 'draft'` is the whole point of this clause. Without it an
        // ingest silently rewrote the steps of a tool that had already been
        // approved and published to MCP — no re-approval, no knock, no
        // notification, state left at 'on'. That defeats the one invariant the
        // workshop page states outright: approve only there, a key never turns
        // a tool On. A key could not turn one on, but it could change what an
        // on tool does, which is worse.
        await db.run(`UPDATE tool SET steps = ?, seen = ?, when_to_use = ? WHERE id = ? AND state = 'draft'`, [
          JSON.stringify(next),
          JSON.stringify(storedSteps.map((s) => s.name)),
          whenToUseFor(
            base,
            compiled.map((s) => s.url || ""),
          ),
          prior.id,
        ]);
        await maybeAutoOn(db, workspaceId, prior.id, compiled);
      } else {
        const id = crypto.randomUUID();
        const name = await uniqueToolName(db, workspaceId, base);
        // OR IGNORE + re-read: a concurrent ingest of the same fingerprint can
        // win the (workspace_id, fingerprint) unique index; the loser must not
        // count a draft that does not exist, and both paths converge on the
        // surviving row.
        await db.run(
          `INSERT OR IGNORE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint, required_k)
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
          [
            id,
            workspaceId,
            name,
            whenToUseFor(
              name,
              compiled.map((s) => s.url || ""),
            ),
            JSON.stringify(compiled),
            JSON.stringify(storedSteps.map((s) => s.name)),
            fp,
            requiredK(storedSteps),
          ],
        );
        const winner = await db.get<{ id: string }>(`SELECT id FROM tool WHERE workspace_id = ? AND fingerprint = ?`, [
          workspaceId,
          fp,
        ]);
        if (winner) await maybeAutoOn(db, workspaceId, winner.id, compiled);
        if (winner?.id === id) drafts++;
      }
    }
    // `>= 2`, not `=== 2`: if the count ever skips past 2 — a concurrent
    // ingest, a replayed batch — an exact test means the knock is never created
    // and the tool stays a draft permanently. The insert below is guarded by
    // the absence of an existing knock, so a later ingest cannot duplicate it.
    if (count >= 2) {
      const tool = await db.get<{ id: string; state: string }>(
        `SELECT id, state FROM tool WHERE fingerprint = ? AND workspace_id = ?`,
        [fp, workspaceId],
      );
      const already = tool
        ? await db.get<{ id: string }>(`SELECT id FROM knock WHERE tool_id = ? AND workspace_id = ?`, [
            tool.id,
            workspaceId,
          ])
        : undefined;
      // A tool already approved and live is not a draft: knocking about it
      // reported a "draft" the workshop did not have, and the step rewrite
      // below could never apply to it anyway. Skip promotion entirely — a
      // change to what an On tool does needs a human, per the workshop's own
      // invariant.
      if (tool && tool.state !== "on" && !already) {
        const compiled = stepsToCompiled(storedSteps);
        // Draft-only, for the same reason as the update above: an approved
        // tool's steps are frozen until a human approves a change.
        await db.run(`UPDATE tool SET steps = ?, seen = ?, when_to_use = ? WHERE id = ? AND state = 'draft'`, [
          JSON.stringify(compiled),
          JSON.stringify(storedSteps.map((s) => s.name)),
          whenToUseFor(
            heuristicName(storedSteps),
            storedSteps.map((s) => s.source_url || ""),
          ),
          tool.id,
        ]);
        await maybeAutoOn(db, workspaceId, tool.id, compiled);
        await db.run(`INSERT INTO knock (id, workspace_id, tool_id, attempt, resolution) VALUES (?, ?, ?, 1, NULL)`, [
          crypto.randomUUID(),
          workspaceId,
          tool.id,
        ]);
      }
    }
  }
  return { drafts, islands: islands.length, stored: events.length };
}

async function rememberIssues(db: EdenDb, workspaceId: string, events: ToolEvent[]): Promise<void> {
  const now = Date.now();
  const ids = new Set<string>();
  for (const e of events) {
    const command = e.command || String((e.args as { command?: string } | undefined)?.command || "");
    for (const n of extractLoopIds(command)) ids.add(n);
  }
  if (!ids.size) return;
  // One statement, not one per id: the id list is attacker-influenced (every
  // number harvested from recorded commands), so a single event could have
  // fanned out into hundreds of round trips.
  const list = [...ids];
  const CHUNK = 50;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => `(?, ?, ?)`).join(", ");
    await db.run(
      `INSERT OR REPLACE INTO watched_issue (workspace_id, issue, seen_at) VALUES ${placeholders}`,
      chunk.flatMap((issue) => [workspaceId, issue, now]),
    );
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
    return (
      "issues csv → JSON [{number,title,reviews:int,status:CI,files:int}]. One call for all PRs; use " +
      "instead of a per-PR gh api loop."
    );
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

/**
 * Domain-general hint built from what the stretch actually fetched: the
 * resource chain plus its template parameters. Vendor bundles keep their
 * hand-tuned copy; everything else gets a description naming the parameters
 * it accepts, which is what a model needs to connect the tool to the loop
 * it was about to write.
 */
function whenToUseFor(name: string, urls: string[]): string {
  if (name.startsWith("github_")) return whenToUse(name);
  const keys = templateKeys(urls).filter((k) => k !== "origin");
  if (!keys.length) return `Replaces a repeated multi-step routine with one call (${name}).`;
  const plural = keys.map((k) => `${k}s`).join("/");
  return `${name}: pass ${plural} (csv) → compact JSON rows, one call instead of the per-id loop.`;
}

async function maybeAutoOn(
  db: EdenDb,
  workspaceId: string,
  toolId: string,
  compiled: Array<{ url?: string }>,
): Promise<void> {
  if (process.env.EDEN_AUTO_APPROVE !== "1") return;
  if (!compiled.some((s) => Boolean(s.url))) return;
  await db.run(`UPDATE tool SET state = 'on', published = 1 WHERE id = ? AND workspace_id = ?`, [toolId, workspaceId]);
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
  // PR-bundle enrichment keys off what the island actually fetched, not a
  // name prefix: names are now domain-general resource chains
  // (pulls_reviews_status), and the same enrichment should one day serve
  // other vendors' expandable bundles.
  if (
    steps.some((s) => /\/pulls\/\d+/.test(s.source_url || "")) &&
    steps.some((s) => /\/(reviews|files|commits)/.test(s.source_url || ""))
  ) {
    ensurePrBundleSteps(compiled);
  }
  compiled.sort((a, b) => rankPlaybackUrl(a.url || "") - rankPlaybackUrl(b.url || ""));
  compiled.forEach((step, i) => {
    step.id = `s${i + 1}`;
  });
  compiled.forEach((step, i) => {
    if (!(step.url || "").includes("{sha}")) return;
    const prior = compiled.find((s, j) => j < i && /\/(pulls|issues)\/\{issue\}$/.test(s.url || ""));
    if (prior) step.bind = { sha: `{{${prior.id}.head.sha}}` };
  });
  return compiled.map(({ bind, ...rest }) => (bind ? { ...rest, bind } : rest));
}

/**
 * Hosts whose /repos/{owner}/{name} shape we are willing to synthesise
 * additional requests against.
 *
 * `forge` is Eden's own in-process fixture, so it is always allowed.
 */
function isForgeHost(host: string): boolean {
  const h = host.replace(/:\d+$/, "").toLowerCase();
  if (h === "api.github.com" || h === "github.com" || h.endsWith(".github.com")) return true;
  const configured = (process.env.EDEN_FORGE_HOST || "").toLowerCase();
  return Boolean(configured) && h === configured;
}

/**
 * The `repos/{owner}/{name}` prefix of a URL, if it names a forge we know.
 *
 * The host class here used to be `[^/]+`, i.e. anything — the "github" in the
 * name was aspirational. ensurePrBundleSteps then fabricates four *more* step
 * URLs against whatever origin this returns, and heuristicName decides to call
 * it by testing for "/pulls/" anywhere in the concatenated URLs without
 * looking at the host at all. So a single ingested event containing
 * `curl http://attacker.tld/repos/a/b/pulls/1` made Eden invent four requests
 * to attacker.tld that appear in no trace, each replayed with three retries:
 * an outbound amplifier aimed by whoever could write one event. The target is
 * a public host, so the SSRF guard permits it — that guard answers a different
 * question.
 */
function githubRepoOrigin(url: string): string | undefined {
  const m = url.match(/^(https?:\/\/([^/]+)\/(?:forge\/)?repos\/[^/]+\/[^/]+)/);
  if (!m) return undefined;
  const host = m[2]!;
  if (url.includes("/forge/repos/") || isForgeHost(host)) return m[1];
  return undefined;
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
