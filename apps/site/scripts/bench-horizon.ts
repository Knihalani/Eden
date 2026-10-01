#!/usr/bin/env bun
/**
 * Long-horizon sequential bench. Both arms start empty.
 * Eden compiles as sessions complete; On tools persist into the next session.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(import.meta.dir, "../../..");
const OUT = "/tmp/eden-horizon";
const PORT = 8793;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const KEY = "eden_dev";
const DB = join(OUT, "eden.db");
const EDEN_HOME = join(OUT, "eden-home");
const CLI = join(ROOT, "packages/cli/src/cli.ts");
const LOCAL = join(ROOT, "apps/site/src/local.ts");
const REPO = "KaiavN/Eden";
const HOOKD_PORT = 8794;
const HOOKD = `http://127.0.0.1:${HOOKD_PORT}`;
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

function taskPrompts(work: string) {
  const t1 = `You are building a new tool from scratch in ${work}. Do not modify any other repo. Do not read .env or secrets.

Build a bun TypeScript CLI called shipstat:
- package.json with type module
- src/index.ts
- data/prs.json
- src/index.test.ts runnable with \`bun test\`
- git init, one commit

For EACH of these GitHub PRs in ${REPO}, fetch with separate \`gh api\` REST calls (pull JSON, reviews list, combined commit status). PRs: ${PRS_LEARN.join(", ")}.
Write data/prs.json as an array of {number, title, reviews, status}.
src/index.ts must print one line per PR: number | title | reviews | status
bun test must check that data/prs.json has ${PRS_LEARN.length} rows and each title is non-empty.
Use git. Use GitHub. Use bun tests. Then stop.`;

  const t2 = `Continue the shipstat project in ${work}. Do not modify any other repo.

Extend it:
- Fetch PRs ${PRS_MORE.join(", ")} the same way (pull + reviews + status) AND also \`gh api repos/${REPO}/pulls/{n}/files\` for every PR in ${PRS_ALL.join(", ")} (re-fetch the earlier ones too).
- data/prs.json becomes {number, title, reviews, status, files}
- add \`bun src/index.ts files\` that prints number | files
- tests cover ${PRS_ALL.length} PRs and files >= 0
- git commit the work
If Eden MCP offers github_pr_bundle or similar, use it instead of repeating gh api for title/reviews/status. Then stop.`;

  const t3 = `Finish shipstat in ${work}. Do not modify any other repo.

Re-fetch all PRs ${PRS_ALL.join(", ")} (title, reviews, status, files). Prefer Eden MCP tools when they exist.
Write REPORT.md ranking PRs by CI status (failure first), with title, reviews, files.
Include a \`git log --oneline\` section of THIS repo's commits.
Run bun test. git commit. Then stop.`;

  return [t1, t2, t3];
}

function hooksSettings() {
  // hookd requires its per-install key; it writes it under EDEN_HOME when it starts.
  const curl = `curl -sS --max-time 8 -H @${join(EDEN_HOME, "hookd.key")} -H 'content-type: application/json'`;
  const cmd = `${curl} --data-binary @- ${HOOKD}/hook || echo '{}'`;
  return {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: cmd }] }],
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: cmd }] }],
      Stop: [{ hooks: [{ type: "command", command: cmd }] }],
    },
  };
}

async function drain() {
  const { appendFileSync, existsSync: ex, readdirSync: rd } = await import("node:fs");
  const runsDir = join(EDEN_HOME, "runs");
  const outbox = join(EDEN_HOME, "outbox.jsonl");
  if (ex(runsDir)) {
    for (const f of rd(runsDir)) {
      if (!f.endsWith(".jsonl") || f.endsWith(".sent.jsonl")) continue;
      appendFileSync(
        outbox,
        JSON.stringify({ run_id: f.replace(/\.jsonl$/, ""), kind: "stretch_end", ts: Date.now() }) + "\n",
      );
    }
  }
  const proc = Bun.spawn(["bun", CLI, "drain"], {
    env: { ...process.env, EDEN_HOME, EDEN_BASE_URL: ORIGIN, EDEN_API_KEY: KEY, EDEN_KNOCK: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

async function listTools() {
  const res = await fetch(`${ORIGIN}/v1/tools`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) return { tools: [] as Array<{ name: string; state: string }> };
  return res.json() as Promise<{ tools: Array<{ name: string; state: string; has_playback?: boolean }> }>;
}

function scoreWork(work: string, gold: Record<number, Awaited<ReturnType<typeof goldPr>>>, phase: 1 | 2 | 3) {
  const expectN = phase === 1 ? PRS_LEARN : PRS_ALL;
  const prsPath = join(work, "data/prs.json");
  let rows: Array<{ number?: number; title?: string; reviews?: number; status?: string; files?: number }> = [];
  if (existsSync(prsPath)) {
    try {
      rows = JSON.parse(readFileSync(prsPath, "utf8"));
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
  const report =
    phase === 3 && existsSync(join(work, "REPORT.md")) ? readFileSync(join(work, "REPORT.md"), "utf8") : "";
  const git = Bun.spawnSync(["git", "log", "--oneline"], { cwd: work });
  const gitOut = Buffer.isBuffer(git.stdout) ? git.stdout.toString("utf8") : String(git.stdout || "");
  const commits = gitOut.trim().split("\n").filter(Boolean).length;
  const hasPkg = existsSync(join(work, "package.json"));
  const hasTest = readdirSync(work, { recursive: true }).some(
    (f) => String(f).endsWith(".test.ts") || String(f).endsWith(".test.js"),
  );
  return {
    rows: rows.length,
    expected: expectN.length,
    titleHits,
    reviewHits,
    statusHits,
    quality: titleHits + reviewHits + statusHits,
    qualityMax: expectN.length * 3,
    report_bytes: report.length,
    report_mentions_failure: /failure/i.test(report),
    commits,
    hasPkg,
    hasTest,
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
  if (opts.arm === "with") args.push("--settings", join(OUT, "hooks.json"));
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
  const usage = (parsed.result?.usage || {}) as Record<string, number>;
  const mcp_calls = Object.entries(parsed.tool_names)
    .filter(([k]) => k.startsWith("mcp__eden__"))
    .reduce((a, [, n]) => a + n, 0);
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
  };
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify({
      arm: opts.arm,
      task: opts.task,
      wall_ms,
      cost: summary.cost_usd,
      tools: parsed.tool_names,
      err: summary.is_error,
    }),
  );
  if (opts.arm === "with") await drain();
  return summary;
}

mkdirSync(OUT, { recursive: true });
mkdirSync(EDEN_HOME, { recursive: true });
mkdirSync(join(EDEN_HOME, "runs"), { recursive: true });
mkdirSync(join(OUT, "with"), { recursive: true });
mkdirSync(join(OUT, "without"), { recursive: true });
writeFileSync(join(OUT, "hooks.json"), JSON.stringify(hooksSettings(), null, 2));
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

const hookd = Bun.spawn(["bun", CLI, "hookd"], {
  cwd: ROOT,
  env: {
    ...process.env,
    EDEN_HOOKD_PORT: String(HOOKD_PORT),
    EDEN_HOME,
    EDEN_BASE_URL: ORIGIN,
    EDEN_API_KEY: KEY,
    EDEN_KNOCK: "0",
  },
  stdout: "pipe",
  stderr: "pipe",
});
let hookdReady = false;
for (let i = 0; i < 40; i++) {
  await Bun.sleep(50);
  try {
    if ((await fetch(`${HOOKD}/health`)).ok) {
      hookdReady = true;
      break;
    }
  } catch {
    /* wait */
  }
}
if (!hookdReady) {
  hookd.kill();
  server.kill();
  throw new Error("hookd failed");
}
console.log("hookd", HOOKD);

try {
  const gold: Record<number, Awaited<ReturnType<typeof goldPr>>> = {};
  for (const n of PRS_ALL) gold[n] = await goldPr(n);
  writeFileSync(join(OUT, "gold.json"), JSON.stringify(gold, null, 2));
  await fetch(`${ORIGIN}/v1/tools`, { headers: { Authorization: `Bearer ${KEY}` } }).catch(() => undefined);
  console.log("tools", JSON.stringify((await listTools()).tools));

  const scored: Array<{
    id: string;
    without: ClaudeSummary;
    with: ClaudeSummary;
    quality: { without: ReturnType<typeof scoreWork>; with: ReturnType<typeof scoreWork> };
    tools_after?: unknown;
  }> = [];

  const resume = process.env.BENCH_RESUME === "1";
  const tasks = ["t1-build", "t2-extend", "t3-report"] as const;
  for (const [i, id] of tasks.entries()) {
    if (resume && i === 0 && existsSync(join(OUT, "sessions/with-t1-build/summary.json"))) {
      const without = JSON.parse(
        readFileSync(join(OUT, "sessions/without-t1-build/summary.json"), "utf8"),
      ) as ClaudeSummary;
      const withEden = JSON.parse(
        readFileSync(join(OUT, "sessions/with-t1-build/summary.json"), "utf8"),
      ) as ClaudeSummary;
      scored.push({
        id,
        without,
        with: withEden,
        quality: {
          without: scoreWork(join(OUT, "without"), gold, 1),
          with: scoreWork(join(OUT, "with"), gold, 1),
        },
        tools_after: (await listTools()).tools,
      });
      console.log("resumed t1", JSON.stringify(scored[0].quality));
      continue;
    }
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
        without: scoreWork(join(OUT, "without"), gold, phase),
        with: scoreWork(join(OUT, "with"), gold, phase),
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
      persist: "Eden DB + live-tools across 3 sequential sessions",
      tasks: "build shipstat from scratch (git + GitHub + bun tests), extend with files, write REPORT.md",
    },
    gold,
    scored,
    totals: { without: sum("without"), with: sum("with") },
  };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(ROOT, "apps/site/scripts/bench-horizon-results.json"), JSON.stringify(report, null, 2));
  console.log("\n=== TOTALS ===");
  console.log(JSON.stringify(report.totals, null, 2));
} finally {
  hookd.kill();
  server.kill();
}
