#!/usr/bin/env bun
/**
 * Fair Claude Code bench: Eden must compile tools from warmup recordings
 * before the scored with/without runs. No seeded On tools.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(import.meta.dir, "../../..");
const OUT = "/tmp/eden-bench-compile";
const PORT = 8791;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const KEY = "eden_dev";
const DB = join(OUT, "eden.db");
const EDEN_HOME = join(OUT, "eden-home");
const CLI = join(ROOT, "packages/cli/src/cli.ts");
const LOCAL = join(ROOT, "apps/site/src/local.ts");
const REPO = "KaiavN/Eden";

type ClaudeSummary = {
  label: string;
  task: string;
  wall_ms: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  tool_calls: number;
  tool_names: Record<string, number>;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  result_text: string;
  outfile?: string;
  is_error?: boolean;
};

function authHeaders() {
  return { Authorization: `Bearer ${KEY}`, "content-type": "application/json" };
}

async function ghJson<T>(path: string): Promise<T> {
  const r = Bun.spawn(["gh", "api", path], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(r.stdout).text();
  await r.exited;
  return JSON.parse(text) as T;
}

async function goldForPr(n: number) {
  const pr = await ghJson<{ title: string; number: number; head: { sha: string } }>(`repos/${REPO}/pulls/${n}`);
  const reviews = await ghJson<unknown[]>(`repos/${REPO}/pulls/${n}/reviews`);
  const status = await ghJson<{ state: string }>(`repos/${REPO}/commits/${pr.head.sha}/status`);
  return {
    n,
    title: pr.title,
    sha: pr.head.sha,
    review_count: reviews.length,
    status_state: status.state,
    line: `${pr.title} | ${reviews.length} | ${status.state}`,
  };
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
      /* ignore incomplete lines */
    }
  }
  if (!result) {
    try {
      result = JSON.parse(text);
    } catch {
      result = null;
    }
  }
  return { tool_calls, tool_names, result };
}

function usageOf(result: Record<string, unknown> | null) {
  const usage = (result?.usage || {}) as Record<string, number>;
  return {
    duration_ms: result?.duration_ms as number | undefined,
    duration_api_ms: result?.duration_api_ms as number | undefined,
    num_turns: result?.num_turns as number | undefined,
    cost_usd: result?.total_cost_usd as number | undefined,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    result_text: String(result?.result || "").slice(0, 600),
    is_error: Boolean(result?.is_error),
  };
}

function prPrompt(n: number, outfile: string) {
  return `You are in the ${REPO} git repo. Do not edit, commit, or install anything.
Do not read .env or secrets.

Task: gather three facts about pull request ${n} using three separate \`gh api\` REST calls (not one combined command, not the website):
1) GET repos/${REPO}/pulls/${n} — title
2) GET repos/${REPO}/pulls/${n}/reviews — how many reviews
3) GET repos/${REPO}/commits/<head-sha>/status — combined state

Write exactly one line to ${outfile} in this shape:
<title> | <review_count> | <status_state>
Then stop.`;
}

function localPrompt(outfile: string) {
  return `You are in the Eden compiled-tool repo. Do not edit files. Do not call gh or curl.

Question: in apps/site/src/playback.ts, when a compiled step has no URL, does playTool treat the step as fail or success?
Write exactly one line to ${outfile}:
fail | apps/site/src/playback.ts
or
success | apps/site/src/playback.ts
Then stop.`;
}

function scorePr(text: string, gold: { title: string; review_count: number; status_state: string }) {
  const blob = text.toLowerCase();
  const title = blob.includes(gold.title.toLowerCase().slice(0, 24));
  const reviews = blob.includes(String(gold.review_count));
  const status = blob.includes(gold.status_state.toLowerCase());
  return { title, reviews, status, score: Number(title) + Number(reviews) + Number(status), max: 3 };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ORIGIN}${path}`, { ...init, headers: { ...authHeaders(), ...(init?.headers || {}) } });
  if (!res.ok) throw new Error(`${path} ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function drain() {
  const { readdirSync, appendFileSync, existsSync } = await import("node:fs");
  const runsDir = join(EDEN_HOME, "runs");
  const outbox = join(EDEN_HOME, "outbox.jsonl");
  if (existsSync(runsDir)) {
    for (const f of readdirSync(runsDir)) {
      if (!f.endsWith(".jsonl") || f.endsWith(".sent.jsonl")) continue;
      const runId = f.replace(/\.jsonl$/, "");
      appendFileSync(outbox, JSON.stringify({ run_id: runId, kind: "stretch_end", ts: Date.now() }) + "\n");
    }
  }
  const proc = Bun.spawn(["bun", CLI, "drain"], {
    env: { ...process.env, EDEN_HOME, EDEN_BASE_URL: ORIGIN, EDEN_API_KEY: KEY },
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

async function listTools() {
  return api<{ tools: Array<{ id: string; name: string; state: string; has_playback: boolean; when_to_use: string }> }>("/v1/tools");
}

async function approvePlayable() {
  const { tools } = await listTools();
  const approved: string[] = [];
  for (const t of tools) {
    if (t.state === "on") continue;
    if (!t.has_playback) continue;
    await fetch(`${ORIGIN}/v1/tools/${t.id}/approve`, { method: "POST", headers: { accept: "application/json" } });
    approved.push(t.name);
  }
  return approved;
}

function hooksSettings() {
  const cmd = `bun "${CLI}" hook`;
  return {
    hooks: {
      PreToolUse: [{ hooks: [{ type: "command", command: cmd }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: cmd }] }],
      PostToolUseFailure: [{ hooks: [{ type: "command", command: cmd }] }],
      Stop: [{ hooks: [{ type: "command", command: cmd }] }],
      SessionStart: [{ hooks: [{ type: "command", command: cmd }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd }] }],
    },
  };
}

async function runClaude(opts: {
  label: string;
  task: string;
  prompt: string;
  withEden: boolean;
  mcp: boolean;
}): Promise<ClaudeSummary> {
  const dir = join(OUT, "sessions", opts.label);
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(OUT, "hooks.json");
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--max-budget-usd",
    "1.5",
    "--setting-sources",
    "local",
    "--strict-mcp-config",
  ];
  if (opts.withEden) {
    args.push("--settings", settingsPath);
  }
  if (opts.mcp) {
    args.push(
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          eden: {
            type: "http",
            url: `${ORIGIN}/mcp`,
            headers: { Authorization: `Bearer ${KEY}` },
          },
        },
      }),
    );
  } else {
    args.push("--mcp-config", JSON.stringify({ mcpServers: {} }));
  }
  const env = {
    ...process.env,
    EDEN_HOME,
    EDEN_BASE_URL: ORIGIN,
    EDEN_API_KEY: KEY,
  };
  const t0 = Date.now();
  const proc = Bun.spawn(["claude", ...args], {
    cwd: ROOT,
    env,
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
  const u = usageOf(parsed.result);
  const summary: ClaudeSummary = {
    label: opts.label,
    task: opts.task,
    wall_ms,
    tool_calls: parsed.tool_calls,
    tool_names: parsed.tool_names,
    outfile: undefined,
    ...u,
  };
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ label: opts.label, wall_ms, cost: u.cost_usd, tools: parsed.tool_names, error: u.is_error }));
  if (opts.withEden) await drain();
  return summary;
}

function readOut(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

mkdirSync(OUT, { recursive: true });
mkdirSync(EDEN_HOME, { recursive: true });
mkdirSync(join(EDEN_HOME, "runs"), { recursive: true });
writeFileSync(join(OUT, "hooks.json"), JSON.stringify(hooksSettings(), null, 2));
writeFileSync(
  join(EDEN_HOME, "config.json"),
  JSON.stringify({ api_key: KEY, base_url: ORIGIN }, null, 2),
);

const tokenProc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe" });
const ghToken = (await new Response(tokenProc.stdout).text()).trim();
await tokenProc.exited;
if (!ghToken) throw new Error("gh auth token failed");

const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  EDEN_SKIP_SEED: "1",
  EDEN_DB: DB,
  EDEN_PUBLIC_URL: ORIGIN,
  EDEN_BASE_URL: ORIGIN,
  EDEN_DEV: "1",
  EDEN_GH_OWNER: "KaiavN",
  EDEN_GH_REPO: "Eden",
  GH_TOKEN: ghToken,
  GITHUB_TOKEN: ghToken,
  DATABASE_URL: "",
  HOME: homedir(),
};
const server = Bun.spawn(["bun", LOCAL], {
  cwd: ROOT,
  env: serverEnv,
  stdout: "pipe",
  stderr: "pipe",
});
let ready = false;
for (let i = 0; i < 40; i++) {
  await Bun.sleep(150);
  try {
    const h = await fetch(`${ORIGIN}/health`);
    if (h.ok) {
      ready = true;
      break;
    }
  } catch {
    /* wait */
  }
}
if (!ready) {
  server.kill();
  throw new Error("Eden local server failed to start");
}
console.log("server up", ORIGIN);

try {
  const gold = {
    170: await goldForPr(170),
    169: await goldForPr(169),
    168: await goldForPr(168),
    167: await goldForPr(167),
    166: await goldForPr(166),
  };
  writeFileSync(join(OUT, "gold.json"), JSON.stringify(gold, null, 2));

  console.log("\n=== COMPILE warmup (Eden hooks, no MCP tools) ===");
  const w1out = join(OUT, "warmup-170.txt");
  const w2out = join(OUT, "warmup-169.txt");
  const warmup1 = await runClaude({
    label: "warmup-170",
    task: "compile-pr-170",
    prompt: prPrompt(170, w1out),
    withEden: true,
    mcp: false,
  });
  const warmup2 = await runClaude({
    label: "warmup-169",
    task: "compile-pr-169",
    prompt: prPrompt(169, w2out),
    withEden: true,
    mcp: false,
  });
  await drain();
  const approved = await approvePlayable();
  const toolsAfter = await listTools();
  writeFileSync(join(OUT, "compiled-tools.json"), JSON.stringify({ approved, tools: toolsAfter.tools }, null, 2));
  console.log("compiled/approved", approved, toolsAfter.tools);

  const onNames = toolsAfter.tools.filter((t) => t.state === "on").map((t) => t.name);
  const edenHint =
    onNames.length > 0
      ? `\nEden MCP is connected. If it lists a tool that covers this PR bundle, call it instead of repeating the three gh api calls. Compiled tools: ${onNames.join(", ")}.`
      : `\nEden MCP is connected. Use a hosted Eden tool if one matches; otherwise use gh api.`;

  const tasks: Array<{
    id: string;
    kind: "pr" | "local";
    n?: number;
    promptFor: (arm: "with" | "without", outfile: string) => string;
  }> = [
    {
      id: "pr-168",
      kind: "pr",
      n: 168,
      promptFor: (arm, outfile) => prPrompt(168, outfile) + (arm === "with" ? edenHint : ""),
    },
    {
      id: "pr-167",
      kind: "pr",
      n: 167,
      promptFor: (arm, outfile) => prPrompt(167, outfile) + (arm === "with" ? edenHint : ""),
    },
    {
      id: "pr-166",
      kind: "pr",
      n: 166,
      promptFor: (arm, outfile) => prPrompt(166, outfile) + (arm === "with" ? edenHint : ""),
    },
    {
      id: "local-nourl",
      kind: "local",
      promptFor: (_arm, outfile) => localPrompt(outfile),
    },
  ];

  const scored: Array<{
    id: string;
    without: ClaudeSummary;
    with: ClaudeSummary;
    gold?: string;
    without_out: string;
    with_out: string;
    quality: { without: unknown; with: unknown };
  }> = [];

  console.log("\n=== SCORED tasks ===");
  for (const t of tasks) {
    const withoutFile = join(OUT, `${t.id}-without.txt`);
    const withFile = join(OUT, `${t.id}-with.txt`);
    const without = await runClaude({
      label: `${t.id}-without`,
      task: t.id,
      prompt: t.promptFor("without", withoutFile),
      withEden: false,
      mcp: false,
    });
    const withEden = await runClaude({
      label: `${t.id}-with`,
      task: t.id,
      prompt: t.promptFor("with", withFile),
      withEden: true,
      mcp: true,
    });
    const without_out = readOut(withoutFile);
    const with_out = readOut(withFile);
    let quality: { without: unknown; with: unknown };
    if (t.kind === "pr" && t.n) {
      const g = gold[t.n as 166 | 167 | 168];
      quality = {
        without: scorePr(`${without_out}\n${without.result_text}`, g),
        with: scorePr(`${with_out}\n${withEden.result_text}`, g),
      };
    } else {
      const ok = (s: string) => /fail/i.test(s) && /playback\.ts/.test(s);
      quality = {
        without: { correct: ok(without_out) || ok(without.result_text), out: without_out },
        with: { correct: ok(with_out) || ok(withEden.result_text), out: with_out },
      };
    }
    scored.push({
      id: t.id,
      without,
      with: withEden,
      gold: t.kind === "pr" && t.n ? gold[t.n as 166 | 167 | 168].line : "fail | apps/site/src/playback.ts",
      without_out,
      with_out,
      quality,
    });
    writeFileSync(join(OUT, "partial.json"), JSON.stringify({ approved, scored }, null, 2));
  }

  const sum = (arm: "without" | "with") => {
    const rows = scored.map((s) => s[arm]);
    return {
      wall_ms: rows.reduce((a, r) => a + r.wall_ms, 0),
      cost_usd: rows.reduce((a, r) => a + (r.cost_usd || 0), 0),
      tool_calls: rows.reduce((a, r) => a + r.tool_calls, 0),
      output_tokens: rows.reduce((a, r) => a + (r.output_tokens || 0), 0),
      duration_ms: rows.reduce((a, r) => a + (r.duration_ms || 0), 0),
    };
  };

  const report = {
    protocol: {
      seed: "none (EDEN_SKIP_SEED=1)",
      compile: "two Claude sessions (PR 170 then 169) with Eden hooks and empty MCP; auto-approve playable drafts",
      scored: "PR 168/167/166 held-out numbers + one local-code control; same prompts except Eden MCP hint on with-arm",
    },
    compiled_tools: toolsAfter.tools,
    approved,
    warmup: { warmup1, warmup2, out: { w1: readOut(w1out), w2: readOut(w2out) } },
    gold,
    scored,
    totals: { without: sum("without"), with: sum("with") },
  };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(ROOT, "apps/site/scripts/bench-compile-results.json"), JSON.stringify(report, null, 2));
  console.log("\n=== TOTALS ===");
  console.log(JSON.stringify(report.totals, null, 2));
  console.log("wrote", join(OUT, "report.json"));
} finally {
  server.kill();
}
