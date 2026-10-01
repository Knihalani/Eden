#!/usr/bin/env bun
/**
 * Fair multi-domain workshop. Both arms start empty. Eden must compile
 * tools from recorded curl traces — shop orders, customers, tickets —
 * not a planted GitHub catalog. t4 is a local-file control (no HTTP).
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { shopOrder, shopItems, shopCustomer, shopCustomerOrders, shopTicket, shopTicketComments } from "../src/forge";

const ROOT = join(import.meta.dir, "../../..");
const OUT = "/tmp/eden-workshop";
const PORT = 8801;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const KEY = "eden_dev";
const DB = join(OUT, "eden.db");
const EDEN_HOME = join(OUT, "eden-home");
const CLI = join(ROOT, "packages/cli/src/cli.ts");
const LOCAL = join(ROOT, "apps/site/src/local.ts");
const HOOKD_PORT = 8802;
const HOOKD = `http://127.0.0.1:${HOOKD_PORT}`;

const ORDERS_LEARN = [11, 12, 13];
const ORDERS_MORE = [14, 15];
const ORDERS_ALL = [...ORDERS_LEARN, ...ORDERS_MORE];
const CUSTOMERS = [21, 22];
const TICKETS = [31, 32, 33];

type ClaudeSummary = {
  arm: "with" | "without";
  task: string;
  wall_ms: number;
  duration_ms?: number;
  tool_calls: number;
  tool_names: Record<string, number>;
  cost_usd?: number;
  output_tokens?: number;
  result_text: string;
  is_error?: boolean;
  mcp_calls: number;
  bash_calls: number;
};

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
  const api = `${ORIGIN}/shop`;
  const t1 = `You are working in ${work}. Do not modify any other repo. Do not read .env or secrets.

This desk talks to a local shop API at ${api}. Use curl (not a browser).

For EACH order id ${ORDERS_LEARN.join(", ")} fetch:
1) GET ${api}/orders/{id}
2) GET ${api}/orders/{id}/items

Write data/orders.json as an array of {id, title, total, status, items} where items is the item count (integer).
Then stop.`;

  const t2 = `Continue the desk in ${work}. Do not modify any other repo.

1) Fetch orders ${ORDERS_MORE.join(", ")} the same way (order JSON + items). data/orders.json must cover ALL ids ${ORDERS_ALL.join(", ")}.
2) For EACH customer id ${CUSTOMERS.join(", ")} fetch:
   GET ${api}/customers/{id}
   GET ${api}/customers/{id}/orders
   Write data/customers.json as [{id, name, email, orders}] where orders is the order count (integer).

If an Eden MCP tool already fetches one of these resources, use it instead of repeating the curl loop.
Then stop.`;

  const t3 = `Finish the desk in ${work}. Do not modify any other repo.

For EACH ticket id ${TICKETS.join(", ")} fetch:
GET ${api}/tickets/{id}
GET ${api}/tickets/{id}/comments
Write data/tickets.json as [{id, title, state, comments}] where comments is the comment count (integer).

Write REPORT.md with three short sections (orders, customers, tickets) listing each id and its title/name.
If Eden MCP tools exist for any of these, prefer them over repeating curl.
Then stop.`;

  const t4 = `Stay in ${work}. Do not call curl, gh, or any HTTP API.

Read notes.md. Count how many lines contain the word ship (case-insensitive).
Write exactly that integer to ANSWER.txt and nothing else.
Then stop.`;

  return [t1, t2, t3, t4];
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

function readJsonArray(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function countish(row: Record<string, unknown>, keys: string[], expected: number): boolean {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && v === expected) return true;
    if (Array.isArray(v) && v.length === expected) return true;
    if (typeof v === "string" && Number(v) === expected) return true;
  }
  return false;
}

function scoreDesk(work: string, phase: 1 | 2 | 3 | 4) {
  const orderIds = phase === 1 ? ORDERS_LEARN : ORDERS_ALL;
  const orders = readJsonArray(join(work, "data/orders.json"));
  let orderHits = 0;
  for (const id of orderIds) {
    const row = orders.find((r) => Number(r.id) === id);
    const g = shopOrder(String(id));
    if (!row) continue;
    const title = String(row.title || "") === g.title;
    const total = Number(row.total) === g.total;
    const status = String(row.status || "") === g.status;
    const items = countish(row, ["items", "count"], shopItems(String(id)).length);
    orderHits += Number(title) + Number(total) + Number(status) + Number(items);
  }
  const orderMax = orderIds.length * 4;

  let customerHits = 0;
  let customerMax = 0;
  if (phase >= 2) {
    customerMax = CUSTOMERS.length * 3;
    const customers = readJsonArray(join(work, "data/customers.json"));
    for (const id of CUSTOMERS) {
      const row = customers.find((r) => Number(r.id) === id);
      const g = shopCustomer(String(id));
      if (!row) continue;
      const name = String(row.name || "") === g.name;
      const email = String(row.email || "") === g.email;
      const n = countish(row, ["orders", "count"], shopCustomerOrders(String(id)).length);
      customerHits += Number(name) + Number(email) + Number(n);
    }
  }

  let ticketHits = 0;
  let ticketMax = 0;
  let report = false;
  if (phase >= 3) {
    ticketMax = TICKETS.length * 3;
    const tickets = readJsonArray(join(work, "data/tickets.json"));
    for (const id of TICKETS) {
      const row = tickets.find((r) => Number(r.id) === id);
      const g = shopTicket(String(id));
      if (!row) continue;
      const title = String(row.title || "") === g.title;
      const state = String(row.state || "") === g.state;
      const n = countish(row, ["comments", "count"], shopTicketComments(String(id)).length);
      ticketHits += Number(title) + Number(state) + Number(n);
    }
    const md = existsSync(join(work, "REPORT.md")) ? readFileSync(join(work, "REPORT.md"), "utf8") : "";
    report = /Order 1[1-5]/.test(md) && /Customer 2[12]/.test(md) && /Ticket 3[123]/.test(md);
  }

  let controlHits = 0;
  let controlMax = 0;
  if (phase === 4) {
    controlMax = 1;
    const ans = existsSync(join(work, "ANSWER.txt")) ? readFileSync(join(work, "ANSWER.txt"), "utf8").trim() : "";
    controlHits = ans === "3" ? 1 : 0;
  }

  const quality = orderHits + customerHits + ticketHits + Number(report) + controlHits;
  const qualityMax = orderMax + customerMax + ticketMax + (phase >= 3 ? 1 : 0) + controlMax;
  return {
    orderHits,
    orderMax,
    customerHits,
    customerMax,
    ticketHits,
    ticketMax,
    report,
    controlHits,
    quality,
    qualityMax,
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
    result_text: String(parsed.result?.result || "").slice(0, 700),
    is_error: Boolean(parsed.result?.is_error),
    mcp_calls,
    bash_calls: parsed.tool_names.Bash || 0,
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

function seedWork(dir: string) {
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(
    join(dir, "notes.md"),
    [
      "the flagship launch is Tuesday",
      "weather is fine",
      "do not miss the shipment window",
      "coffee first",
      "ownership of the ship is shared",
    ].join("\n") + "\n",
  );
}

for (const port of [PORT, HOOKD_PORT]) {
  const killer = Bun.spawn(["sh", "-c", `lsof -iTCP:${port} -sTCP:LISTEN -t | xargs kill -9 2>/dev/null || true`]);
  await killer.exited;
}

if (process.env.BENCH_RESUME !== "1") {
  rmSync(OUT, { recursive: true, force: true });
}
mkdirSync(OUT, { recursive: true });
mkdirSync(EDEN_HOME, { recursive: true });
mkdirSync(join(EDEN_HOME, "runs"), { recursive: true });
mkdirSync(join(OUT, "with"), { recursive: true });
mkdirSync(join(OUT, "without"), { recursive: true });
seedWork(join(OUT, "with"));
seedWork(join(OUT, "without"));
writeFileSync(join(OUT, "hooks.json"), JSON.stringify(hooksSettings(), null, 2));
writeFileSync(join(EDEN_HOME, "config.json"), JSON.stringify({ api_key: KEY, base_url: ORIGIN }, null, 2));

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
  const shop = await fetch(`${ORIGIN}/shop/orders/11`);
  if (!shop.ok) {
    server.kill();
    throw new Error(`shop mock missing ${shop.status}`);
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
  console.log("tools", JSON.stringify((await listTools()).tools));
  const scored: Array<{
    id: string;
    without: ClaudeSummary;
    with: ClaudeSummary;
    quality: { without: ReturnType<typeof scoreDesk>; with: ReturnType<typeof scoreDesk> };
    tools_after?: unknown;
  }> = [];

  const tasks = ["t1-orders", "t2-customers", "t3-tickets", "t4-control"] as const;
  for (const [i, id] of tasks.entries()) {
    const phase = (i + 1) as 1 | 2 | 3 | 4;
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
        without: scoreDesk(join(OUT, "without"), phase),
        with: scoreDesk(join(OUT, "with"), phase),
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
      bash_calls: rows.reduce((a, r) => a + r.bash_calls, 0),
      output_tokens: rows.reduce((a, r) => a + (r.output_tokens || 0), 0),
      quality: scored.reduce((a, r) => a + r.quality[arm].quality, 0),
      qualityMax: scored.reduce((a, r) => a + r.quality[arm].qualityMax, 0),
    };
  };

  const report = {
    protocol: {
      seed: "none",
      auto_approve: true,
      domains: ["shop orders", "shop customers", "shop tickets", "local-file control"],
      persist: "Eden DB + live-tools across 4 sequential sessions",
      note: "Gold is the local /shop mock. No GitHub PR catalog. Eden compiles from traces.",
    },
    scored,
    totals: { without: sum("without"), with: sum("with") },
    compiled: (await listTools()).tools,
  };
  writeFileSync(join(OUT, "results.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(ROOT, "apps/site/scripts/bench-workshop-results.json"), JSON.stringify(report, null, 2));
  console.log("TOTALS", JSON.stringify(report.totals, null, 2));
  console.log("COMPILED", JSON.stringify(report.compiled));
} finally {
  hookd.kill();
  server.kill();
}
