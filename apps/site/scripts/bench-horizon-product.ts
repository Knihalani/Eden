#!/usr/bin/env bun
/**
 * Product-agent fair bench. No coding hooks/hookd/rewriteBash.
 * Win = compile after t1, MCP from t2, same gold predicates on decisions/prs.json.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolEvent } from "@eden/core";

const ROOT = join(import.meta.dir, "../../..");
const OUT = "/tmp/eden-horizon-product";
const PORT = 8797;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const KEY = "eden_dev";
const DB = join(OUT, "eden.db");
const EDEN_HOME = join(OUT, "eden-home");
const LOCAL = join(ROOT, "apps/site/src/local.ts");
const REPO = "KaiavN/Eden";
const PRS_LEARN = [170, 169, 168, 167, 166];
const PRS_MORE = [165, 164, 163];
const PRS_ALL = [...PRS_LEARN, ...PRS_MORE];

type ClaudeSummary = {
  arm: "with" | "without";
  task: string;
  wall_ms: number;
  duration_ms?: number;
  tool_calls: number;
  tool_names: Record<string, number>;
  cost_usd?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  result_text: string;
  is_error?: boolean;
  mcp_calls: number;
  gh_bash_calls: number;
  ingested?: number;
};

async function ghJson<T>(path: string): Promise<T> {
  const r = Bun.spawn(["gh", "api", path], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(r.stdout).text();
  await r.exited;
  return JSON.parse(text) as T;
}

async function goldPr(n: number) {
  const pr = await ghJson<{ title: string; number: number; head: { sha: string } }>(`repos/${REPO}/pulls/${n}`);
  const reviews = await ghJson<unknown[]>(`repos/${REPO}/pulls/${n}/reviews`);
  const status = await ghJson<{ state: string }>(`repos/${REPO}/commits/${pr.head.sha}/status`);
  const files = await ghJson<unknown[]>(`repos/${REPO}/pulls/${n}/files`);
  return { n, title: pr.title, review_count: reviews.length, status_state: status.state, files: files.length };
}

function parseStream(text: string) {
  const tool_names: Record<string, number> = {};
  let tool_calls = 0;
  let result: Record<string, unknown> | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        for (const c of ev.message.content as Array<{ type?: string; name?: string }>) {
          if (c.type === "tool_use" && c.name) {
            tool_calls++;
            tool_names[c.name] = (tool_names[c.name] || 0) + 1;
          }
        }
      }
      if (ev.type === "result") result = ev;
    } catch {
      /* ignore */
    }
  }
  return { tool_calls, tool_names, result };
}

function extractBashEvents(text: string): ToolEvent[] {
  const events: ToolEvent[] = [];
  let seq = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        for (const c of ev.message.content as Array<{
          type?: string;
          name?: string;
          id?: string;
          input?: Record<string, unknown>;
        }>) {
          if (c.type === "tool_use" && c.name === "Bash") {
            seq++;
            const command = String(c.input?.command || "");
            if (!/\bgh\s+|\bcurl\s+/.test(command)) continue;
            events.push({
              event_id: String(c.id || `bash-${seq}`),
              seq,
              name: "Bash",
              args: { command },
              command,
              ok: true,
            });
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return events;
}

function taskPrompts(work: string) {
  const t1 = `You are a product analyst. Work only in ${work}. Do not modify any other repo. Do not read .env or secrets. Do not write code or tests.

For EACH of these GitHub PRs in ${REPO}, fetch with separate \`gh api\` REST calls (pull JSON, reviews list, combined commit status). PRs: ${PRS_LEARN.join(", ")}.
Write decisions/prs.json as an array of {number, title, reviews, status}.
Write memo.md summarizing what you found. Then stop.`;

  const t2 = `Continue the analysis in ${work}. Do not modify any other repo. Do not write a coding CLI.

Fetch PRs ${PRS_MORE.join(", ")} the same way (pull + reviews + status) AND also \`gh api repos/${REPO}/pulls/{n}/files\` for every PR in ${PRS_ALL.join(", ")} (re-fetch the earlier ones too).
decisions/prs.json becomes {number, title, reviews, status, files}.
Write rank.md ranking those PRs. If Eden MCP offers github_pr_bundle or similar, use it instead of repeating gh api for title/reviews/status. Then stop.`;

  const t3 = `Finish the analysis in ${work}. Do not modify any other repo.

Re-fetch all PRs ${PRS_ALL.join(", ")} (title, reviews, status, files). Prefer Eden MCP tools when they exist.
Update rank.md ranking PRs by CI status (failure first), with title, reviews, files. Then stop.`;

  return [t1, t2, t3];
}

async function listTools() {
  const res = await fetch(`${ORIGIN}/v1/tools`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) return { tools: [] as Array<{ name: string; state: string }> };
  return res.json() as Promise<{ tools: Array<{ name: string; state: string; has_playback?: boolean }> }>;
}

async function ingestSession(runId: string, stdout: string) {
  const events = extractBashEvents(stdout);
  if (!events.length) return 0;
  const res = await fetch(`${ORIGIN}/v1/ingest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ run_id: runId, events, stretch_end: true }),
  });
  if (!res.ok) throw new Error(`ingest ${res.status} ${await res.text()}`);
  return events.length;
}

function scoreProduct(work: string, gold: Record<number, Awaited<ReturnType<typeof goldPr>>>, phase: 1 | 2 | 3) {
  const expectN = phase === 1 ? PRS_LEARN : PRS_ALL;
  const prsPath = join(work, "decisions/prs.json");
  let rows: Array<{ number?: number; title?: string; reviews?: number; status?: string; files?: number }> = [];
  if (existsSync(prsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(prsPath, "utf8"));
      rows = Array.isArray(parsed) ? parsed : [];
    } catch {
      rows = [];
    }
  }
  let titleHits = 0;
  let reviewHits = 0;
  let statusHits = 0;
  for (const n of expectN) {
    const row = rows.find((r) => Number(r.number) === n);
    const g = gold[n];
    if (!row || !g) continue;
    if (String(row.title || "").includes(g.title.slice(0, 20))) titleHits++;
    if (Number(row.reviews) === g.review_count) reviewHits++;
    if (String(row.status || "") === g.status_state) statusHits++;
  }
  const memo = existsSync(join(work, "memo.md")) ? readFileSync(join(work, "memo.md"), "utf8") : "";
  const rank = phase >= 2 && existsSync(join(work, "rank.md")) ? readFileSync(join(work, "rank.md"), "utf8") : "";
  return {
    rows: rows.length,
    expected: expectN.length,
    titleHits,
    reviewHits,
    statusHits,
    quality: titleHits + reviewHits + statusHits,
    qualityMax: expectN.length * 3,
    memo_bytes: memo.length,
    rank_bytes: rank.length,
    rank_mentions_failure: /failure/i.test(rank),
  };
}

async function runClaude(opts: {
  arm: "with" | "without";
  task: string;
  prompt: string;
  cwd: string;
  mcp: boolean;
}): Promise<ClaudeSummary> {
  const dir = join(OUT, "sessions", `${opts.arm}-${opts.task}`);
  mkdirSync(dir, { recursive: true });
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--max-budget-usd",
    "2.5",
    "--setting-sources",
    "local",
    "--strict-mcp-config",
    "--disallowedTools",
    "ToolSearch,Task,WebSearch,WebFetch,Skill,Agent",
  ];
  if (opts.mcp) {
    args.push(
      "--mcp-config",
      JSON.stringify({
        mcpServers: { eden: { type: "http", url: `${ORIGIN}/mcp`, headers: { Authorization: `Bearer ${KEY}` } } },
      }),
    );
  } else {
    args.push("--mcp-config", JSON.stringify({ mcpServers: {} }));
  }
  const t0 = Date.now();
  const proc = Bun.spawn(["claude", ...args], {
    cwd: opts.cwd,
    env: { ...process.env, EDEN_HOME, EDEN_BASE_URL: ORIGIN, EDEN_API_KEY: KEY, EDEN_KNOCK: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  const wall_ms = Date.now() - t0;
  writeFileSync(join(dir, "stdout.jsonl"), stdout);
  writeFileSync(join(dir, "stderr.txt"), stderr);
  const parsed = parseStream(stdout);
  const usage = ((parsed.result?.usage || {}) as Record<string, number>);
  const mcp_calls = Object.entries(parsed.tool_names)
    .filter(([k]) => k.startsWith("mcp__eden__"))
    .reduce((a, [, n]) => a + n, 0);
  let ingested = 0;
  if (opts.arm === "with") ingested = await ingestSession(`product-${opts.task}`, stdout);
  const summary: ClaudeSummary = {
    arm: opts.arm,
    task: opts.task,
    wall_ms,
    duration_ms: parsed.result?.duration_ms as number | undefined,
    tool_calls: parsed.tool_calls,
    tool_names: parsed.tool_names,
    cost_usd: parsed.result?.total_cost_usd as number | undefined,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    result_text: String(parsed.result?.result || "").slice(0, 700),
    is_error: Boolean(parsed.result?.is_error),
    mcp_calls,
    gh_bash_calls: parsed.tool_names.Bash || 0,
    ingested,
  };
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ arm: opts.arm, task: opts.task, wall_ms, cost: summary.cost_usd, tools: parsed.tool_names, ingested, err: summary.is_error }));
  return summary;
}

if (process.env.BENCH_RESUME !== "1") {
  rmSync(OUT, { recursive: true, force: true });
}
mkdirSync(OUT, { recursive: true });
mkdirSync(EDEN_HOME, { recursive: true });
mkdirSync(join(OUT, "with"), { recursive: true });
mkdirSync(join(OUT, "without"), { recursive: true });
writeFileSync(join(EDEN_HOME, "config.json"), JSON.stringify({ api_key: KEY, base_url: ORIGIN }, null, 2));

const tokenProc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe" });
const ghToken = (await new Response(tokenProc.stdout).text()).trim();
await tokenProc.exited;

const server = Bun.spawn(["bun", LOCAL], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    EDEN_SKIP_SEED: "1",
    EDEN_AUTO_APPROVE: "1",
    EDEN_DB: DB,
    EDEN_PUBLIC_URL: ORIGIN,
    EDEN_DEV: "1",
    EDEN_GH_OWNER: "KaiavN",
    EDEN_GH_REPO: "Eden",
    GH_TOKEN: ghToken,
    GITHUB_TOKEN: ghToken,
    DATABASE_URL: "",
    HOME: homedir(),
  },
  stdout: "pipe",
  stderr: "pipe",
});
let ready = false;
for (let i = 0; i < 40; i++) {
  await Bun.sleep(150);
  try {
    if ((await fetch(`${ORIGIN}/health`)).ok) {
      ready = true;
      break;
    }
  } catch {
    /* wait */
  }
}
if (!ready) {
  server.kill();
  throw new Error("server failed");
}
{
  const toolsRes = await fetch(`${ORIGIN}/v1/tools`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!toolsRes.ok) {
    const err = await new Response(server.stderr).text();
    server.kill();
    throw new Error(`tools ${toolsRes.status} ${err.slice(0, 400)}`);
  }
}
console.log("server", ORIGIN);

try {
  const gold: Record<number, Awaited<ReturnType<typeof goldPr>>> = {};
  for (const n of PRS_ALL) gold[n] = await goldPr(n);
  writeFileSync(join(OUT, "gold.json"), JSON.stringify(gold, null, 2));
  console.log("tools", JSON.stringify((await listTools()).tools));

  const scored: Array<{
    id: string;
    without: ClaudeSummary;
    with: ClaudeSummary;
    quality: { without: ReturnType<typeof scoreProduct>; with: ReturnType<typeof scoreProduct> };
    tools_after?: unknown;
  }> = [];

  const tasks = ["t1-build", "t2-extend", "t3-report"] as const;
  for (const [i, id] of tasks.entries()) {
    const phase = (i + 1) as 1 | 2 | 3;
    const without = await runClaude({
      arm: "without",
      task: id,
      prompt: taskPrompts(join(OUT, "without"))[i],
      cwd: join(OUT, "without"),
      mcp: false,
    });
    const withEden = await runClaude({
      arm: "with",
      task: id,
      prompt: taskPrompts(join(OUT, "with"))[i],
      cwd: join(OUT, "with"),
      mcp: i > 0,
    });
    const tools = await listTools();
    const row = {
      id,
      without,
      with: withEden,
      quality: {
        without: scoreProduct(join(OUT, "without"), gold, phase),
        with: scoreProduct(join(OUT, "with"), gold, phase),
      },
      tools_after: tools.tools,
    };
    scored.push(row);
    writeFileSync(join(OUT, "partial.json"), JSON.stringify({ scored, tools: tools.tools }, null, 2));
    console.log("quality", id, JSON.stringify(row.quality));
    console.log("compiled", JSON.stringify(tools.tools));
  }

  const sum = (arm: "without" | "with") => {
    const rows = scored.map((s) => s[arm === "without" ? "without" : "with"]);
    return {
      wall_ms: rows.reduce((a, r) => a + r.wall_ms, 0),
      cost_usd: rows.reduce((a, r) => a + (r.cost_usd || 0), 0),
      tool_calls: rows.reduce((a, r) => a + r.tool_calls, 0),
      mcp_calls: rows.reduce((a, r) => a + r.mcp_calls, 0),
      output_tokens: rows.reduce((a, r) => a + (r.output_tokens || 0), 0),
      quality: scored.reduce((a, s) => a + s.quality[arm === "without" ? "without" : "with"].quality, 0),
      qualityMax: scored.reduce((a, s) => a + s.quality[arm === "without" ? "without" : "with"].qualityMax, 0),
    };
  };

  const report = {
    protocol: {
      seed: "none",
      auto_approve: true,
      hooks: false,
      ingest: "POST /v1/ingest from jsonl Bash gh api",
      persist: "Eden DB + MCP across 3 sequential product sessions",
      tasks: "decisions/prs.json + memo/rank.md, same gold predicates as coding fair",
    },
    gold,
    scored,
    totals: { without: sum("without"), with: sum("with") },
  };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(ROOT, "apps/site/scripts/bench-horizon-product-results.json"), JSON.stringify(report, null, 2));
  console.log("\n=== TOTALS ===");
  console.log(JSON.stringify(report.totals, null, 2));
} finally {
  server.kill();
}
