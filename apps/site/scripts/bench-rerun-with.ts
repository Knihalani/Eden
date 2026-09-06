#!/usr/bin/env bun
/** Re-run scored WITH arm after forge-host fix, keeping without-arm results. */
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

function prPrompt(n: number, outfile: string) {
  return `You are in the ${REPO} git repo. Do not edit, commit, or install anything.
Do not read .env or secrets.

Task: gather three facts about pull request ${n} using three separate \`gh api\` REST calls (not one combined command, not the website):
1) GET repos/${REPO}/pulls/${n} — title
2) GET repos/${REPO}/pulls/${n}/reviews — how many reviews
3) GET repos/${REPO}/commits/<head-sha>/status — combined state

Write exactly one line to ${outfile} in this shape:
<title> | <review_count> | <status_state>
Then stop.

Eden MCP is connected. If it lists a tool that covers this PR bundle, call it instead of repeating the three gh api calls. Compiled tools: gh_api_gh_api_gh_api.`;
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

function scorePr(text: string, gold: { title: string; review_count: number; status_state: string }) {
  const blob = text.toLowerCase();
  const title = blob.includes(gold.title.toLowerCase().slice(0, 24));
  const reviews = blob.includes(String(gold.review_count));
  const status = blob.includes(gold.status_state.toLowerCase());
  return { title, reviews, status, score: Number(title) + Number(reviews) + Number(status), max: 3 };
}

const tokenProc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe" });
const ghToken = (await new Response(tokenProc.stdout).text()).trim();
await tokenProc.exited;

const server = Bun.spawn(["bun", LOCAL], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    EDEN_SKIP_SEED: "1",
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

const report = JSON.parse(readFileSync(join(OUT, "report.json"), "utf8"));
const gold = report.gold;
const settingsPath = join(OUT, "hooks.json");

try {
  for (const n of [168, 167, 166]) {
    const outfile = join(OUT, `pr-${n}-with.txt`);
    const dir = join(OUT, "sessions", `pr-${n}-with-rerun`);
    mkdirSync(dir, { recursive: true });
    const args = [
      "-p",
      prPrompt(n, outfile),
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--max-budget-usd",
      "1.5",
      "--setting-sources",
      "local",
      "--strict-mcp-config",
      "--settings",
      settingsPath,
      "--mcp-config",
      JSON.stringify({
        mcpServers: { eden: { type: "http", url: `${ORIGIN}/mcp`, headers: { Authorization: `Bearer ${KEY}` } } },
      }),
    ];
    const t0 = Date.now();
    const proc = Bun.spawn(["claude", ...args], {
      cwd: ROOT,
      env: { ...process.env, EDEN_HOME, EDEN_BASE_URL: ORIGIN, EDEN_API_KEY: KEY },
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
    const summary = {
      label: `pr-${n}-with`,
      task: `pr-${n}`,
      wall_ms,
      tool_calls: parsed.tool_calls,
      tool_names: parsed.tool_names,
      duration_ms: parsed.result?.duration_ms,
      duration_api_ms: parsed.result?.duration_api_ms,
      num_turns: parsed.result?.num_turns,
      cost_usd: parsed.result?.total_cost_usd,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      result_text: String(parsed.result?.result || "").slice(0, 600),
      is_error: Boolean(parsed.result?.is_error),
      rerun_after_forge_fix: true,
    };
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
    const out = existsSync(outfile) ? readFileSync(outfile, "utf8").trim() : "";
    const g = gold[String(n)];
    const quality = scorePr(`${out}\n${summary.result_text}`, g);
    const row = report.scored.find((s: { id: string }) => s.id === `pr-${n}`);
    if (row) {
      row.with_before_forge_fix = row.with;
      row.with = summary;
      row.with_out = out;
      row.quality.with = quality;
    }
    console.log(JSON.stringify({ n, wall_ms, cost: summary.cost_usd, tools: summary.tool_names, out, quality }));
  }
  const scored = report.scored;
  const sum = (arm: "without" | "with") => {
    const rows = scored.map((s: Record<string, { wall_ms: number; cost_usd?: number; tool_calls: number; output_tokens?: number; duration_ms?: number }>) => s[arm]);
    return {
      wall_ms: rows.reduce((a: number, r: { wall_ms: number }) => a + r.wall_ms, 0),
      cost_usd: rows.reduce((a: number, r: { cost_usd?: number }) => a + (r.cost_usd || 0), 0),
      tool_calls: rows.reduce((a: number, r: { tool_calls: number }) => a + r.tool_calls, 0),
      output_tokens: rows.reduce((a: number, r: { output_tokens?: number }) => a + (r.output_tokens || 0), 0),
      duration_ms: rows.reduce((a: number, r: { duration_ms?: number }) => a + (r.duration_ms || 0), 0),
    };
  };
  report.totals = { without: sum("without"), with: sum("with") };
  report.note = "WITH PR tasks re-run after handleForge stopped intercepting api.github.com. Compile warmups and without-arm unchanged.";
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(ROOT, "apps/site/scripts/bench-compile-results.json"), JSON.stringify(report, null, 2));
  console.log("totals", JSON.stringify(report.totals, null, 2));
} finally {
  server.kill();
}
