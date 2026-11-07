/**
 * `bun run demo`: Eden in five minutes, no key, $0 (D292).
 *
 * Builds one simulated user (`buildWorld`: about 1,500 items over mail, calendar, docs, CRM and chat) with a few
 * things planted that change what a good assistant should do (a training suite's `hidden` variant), starts the real
 * HTTP server on it (`buildPartner` with the shipped `DEFAULT_CONFIG`, `createHandler`, on a free loopback port), and
 * sends a short day of requests through `@eden/client`, the way an agent would. For each request it prints what Eden
 * added before the agent's first model call, why (`/v1/explain`, content-free), and whether that was the fact the
 * request needed. One request is chatter, where Eden should stay silent, and one is a plain question (`ask`).
 *
 * With `OPENAI_API_KEY` (and optionally `OPENAI_BASE_URL`, `AGENT_MODEL`, as examples/personal-agent does) the agent
 * model answers each request twice, without and with Eden's context, so the difference is visible; without one the
 * demo shows what the agent would receive and spends nothing. Eden itself runs its no-model path either way: the
 * servers' model roles need OPENROUTER_API_KEY, which the demo never reads.
 *
 * Simulated data only (packages/sim/CLAUDE.md); nothing leaves the machine unless the agent key is set.
 *
 *   bun run demo                    # seed 41, the personal-finance suite (train1), no key
 *   bun run demo --seed 42 --json   # another user; machine-readable rows
 *   bun run demo --trace demo.log && bun run digest demo.log   # the log a server writes, and its digest
 */
import { EdenClient, withContext } from "@eden/client";
import type { ExplainedDecision, Injection } from "@eden/protocol";
import { buildPartner, createHandler } from "@eden/server";
import { SourceMap } from "@eden/graph";
import { worldOf, type Task } from "./lab/ab-common";
import { IDEAL, simSources } from "./sources";
import type { World } from "./world";

/** One request of the demo's day: what was sent, what Eden added, why, and (with an agent key) both answers. */
export interface DemoRow {
  label: string;
  request: string;
  kind: "act" | "chatter" | "question";
  /** What the request needed but did not say (a planted item's detail), for an acting request. */
  needed?: string;
  /** Titles of the items Eden put in front of the agent (or the ask's answer cited). */
  added: { itemId: string; title: string; source: string; line: string; planted: boolean }[];
  /** The planted item was among them. */
  caught?: boolean;
  why: string[];
  latencyMs: number;
  modelCalls: number;
  costUsd: number;
  /** The agent model's answers, only with OPENAI_API_KEY. */
  answers?: { without: string; with: string };
}

export interface DemoOptions {
  seed?: number;
  suite?: string;
  /** Template names of the acting requests, in order (default: `DEFAULT_PICKS[suite]`). */
  picks?: string[];
  /** An agent model to answer each request without and with Eden's context; none by default. */
  agent?: (messages: { role: string; content: string }[]) => Promise<string>;
  /** Receives each trace and usage record as the server's `EDEN_TRACE=1` log writes it (`bun run digest` reads it). */
  log?: (line: string) => void;
}

/**
 * The acting requests the demo sends by default: three of a suite's templates, each from a different part of life.
 * Picked on seed 41 for being ordinary requests whose deciding fact sits in another source; the demo prints whether
 * Eden caught it on whatever seed runs, so a miss shows as a miss.
 */
export const DEFAULT_PICKS: Record<string, string[]> = {
  train1: ["builder-details-hacked", "sister-cottage-repaid", "debit-card-blocked"],
};
export const DEFAULT_SUITE = "train1";

const CHATTER = "thanks, that's all for now";

/** Runs the demo's day and returns its rows; the caller prints them. */
export async function runDemo(options: DemoOptions = {}): Promise<{ world: World; rows: DemoRow[] }> {
  const seed = options.seed ?? 41;
  const suite = options.suite ?? DEFAULT_SUITE;
  const { world, tasks } = worldOf(seed, suite, "hidden", { maxTasks: 30, maxOffworld: 0 });
  const picks = options.picks ?? DEFAULT_PICKS[suite] ?? tasks.slice(0, 3).map((t) => t.type);
  const chosen = picks.map((p) => {
    const t = tasks.find((x) => x.type === p);
    if (!t) throw new Error(`demo: no template "${p}" in ${suite} (have ${tasks.map((x) => x.type).join(", ")})`);
    return t;
  });
  const sources = simSources(world, IDEAL, 0, seed);
  // The shipped wiring with no model roles (no key), on the world's clock: its items are dated around its own "now".
  const partner = buildPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(":memory:"),
    now: () => world.now,
    ...(options.log
      ? {
          onTrace: (t) => options.log!(JSON.stringify(t)),
          onUsage: (u) => options.log!(JSON.stringify({ usage: u })),
        }
      : {}),
  });
  // A server's background sync reads a user's listable sources into their index before (and while) they work; the demo
  // runs that backfill up front, a minute of the world's clock a tick, as the lab's harnesses do (pi-ab.ts).
  const sync = partner.sync;
  if (sync) {
    const scope = { tenantId: "dev", userId: `demo-${seed}` };
    sync.track(scope, world.now);
    for (let i = 0; i < 120 && !sync.warm(scope); i++) await sync.tick();
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createHandler(partner, { keys: new Map(), dev: true }),
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const userId = `demo-${seed}`;
  const rows: DemoRow[] = [];
  try {
    let turn = 0;
    const client = (sessionId: string) => new EdenClient({ baseUrl, userId, sessionId, tenantId: "dev" });
    for (const t of chosen) rows.push(await actingRow(client(`s${++turn}`), t, options.agent));
    // Chatter: nothing in it needs the user's sources; Eden may search, but should hand the agent nothing.
    const chat = client(`s${++turn}`);
    const said = await chat.collect((await chat.observe({ kind: "user_message", text: CHATTER })).injection);
    rows.push({
      label: "chatter",
      request: CHATTER,
      kind: "chatter",
      added: once(said.flatMap(cited(chosen))),
      why: (await chat.explain()).map((d) => d.why),
      ...totals(await chat.explain()),
    });
    // A plain question through ask_context's call: the first request's subject, asked outright.
    const q = client(`s${++turn}`);
    const question = questionFor(world, chosen[0]!);
    const answer = await q.ask(question);
    rows.push({
      label: "question",
      request: question,
      kind: "question",
      // The client fails open (null) rather than throw into an agent's loop.
      added: (answer?.citations ?? []).map((c) => ({
        itemId: c.itemId,
        title: c.title,
        source: c.sourceId,
        line: c.title,
        planted: false,
      })),
      why: (await q.explain()).map((d) => d.why),
      ...totals(await q.explain()),
    });
    for (const c of [chat, q]) await c.observe({ kind: "session_end" });
  } finally {
    server.stop(true);
    partner.stopSync();
  }
  return { world, rows };
}

async function actingRow(eden: EdenClient, task: Task, agent: DemoOptions["agent"]): Promise<DemoRow> {
  const { injection } = await eden.observe({ kind: "user_message", text: task.text });
  const added = await eden.collect(injection);
  const decisions = await eden.explain();
  const shown = once(added.flatMap(cited([task])));
  const row: DemoRow = {
    label: task.type,
    request: task.text,
    kind: "act",
    needed: task.must[0]?.detail ?? "",
    added: shown,
    caught: shown.some((s) => s.planted),
    why: decisions.map((d) => d.why),
    ...totals(decisions),
  };
  if (agent) {
    const base = [
      { role: "system", content: "You are a personal assistant. Be concise and name the details you rely on." },
      { role: "user", content: task.text },
    ];
    row.answers = { without: await agent(base), with: await agent(withContext(base, added)) };
    // Reporting the agent's answer lets Eden infer whether it used what it added (D18), as an integration would.
    await eden.observe({ kind: "agent_message", text: row.answers.with });
  }
  await eden.observe({ kind: "session_end" });
  return row;
}

/**
 * Each injection's items as the agent reads them: the packet's `- [source] title: excerpt` lines (one per citation,
 * in order, D11), each with its citation, the planted items of the given tasks marked. An item two packets of one
 * request both carry (the rule path and the candidates race, D258) is listed once.
 */
const cited = (tasks: Task[]) => (i: Injection) => {
  const lines = i.text.split("\n").filter((l) => l.startsWith("- ["));
  return i.citations.map((c, n) => ({
    itemId: c.itemId,
    title: c.title,
    source: c.sourceId,
    line: lines[n]?.replace(/^- \[[^\]]*\] /, "") ?? c.title,
    planted: tasks.some((t) => t.planted !== undefined && t.planted === c.itemId),
  }));
};

const once = <T extends { itemId: string }>(xs: T[]): T[] => {
  const seen = new Set<string>();
  return xs.filter((x) => !seen.has(x.itemId) && !!seen.add(x.itemId));
};

const totals = (d: ExplainedDecision[]) => ({
  latencyMs: Math.round(Math.max(0, ...d.map((x) => x.latencyMs))),
  modelCalls: d.reduce((n, x) => n + x.modelCalls, 0),
  costUsd: d.reduce((n, x) => n + x.costUsd, 0),
});

/** A plain question about the first request's subject: what its planted item's sender has said lately. */
function questionFor(world: World, task: Task): string {
  const item = world.items.find((i) => i.id === task.planted);
  const sender = item?.meta?.people?.split(";")[0]?.replace(/<.*$/, "").trim();
  return sender ? `What has ${sender} told me lately?` : `Anything I should know before: ${task.text}`;
}

/** The demo's printout: one block per request, then a short summary. */
export function printDemo(world: World, rows: DemoRow[], log: (line: string) => void = console.log): void {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  log(
    `Simulated user: ${world.user.full}, ${world.items.length.toLocaleString("en-US")} items over mail, calendar, docs, CRM and chat.`,
  );
  log(`Eden: the shipped default, no model key (no model call on any path).\n`);
  for (const [i, r] of rows.entries()) {
    log(
      `── ${i + 1}. ${r.kind === "act" ? "A request that acts" : r.kind === "chatter" ? "Chatter" : "A question (ask_context)"}`,
    );
    log(`   user: "${r.request}"`);
    if (r.needed) log(`   what it needs but does not say: ${r.needed}`);
    if (r.added.length === 0) log("   Eden added: nothing (silent)");
    else {
      log(
        `   Eden added ${r.added.length} item${r.added.length === 1 ? "" : "s"}${r.kind === "act" ? " before the agent's first model call" : ""}:`,
      );
      for (const a of r.added) log(`     ${a.planted ? "★" : "·"} [${a.source}] ${cut(a.line, 150)}`);
    }
    if (r.caught !== undefined)
      log(
        `   ${r.caught ? "★ caught: the item that changes the answer is in what the agent sees" : "✗ missed: the deciding item was not among them"}`,
      );
    log(`   why (from /v1/explain, no content):`);
    for (const w of r.why) log(`     - ${w}`);
    log(`   Eden's time ${r.latencyMs} ms, model calls ${r.modelCalls}, cost $${r.costUsd.toFixed(4)}`);
    if (r.answers) {
      log(`   agent without Eden: ${cut(r.answers.without.replace(/\s+/g, " "), 400)}`);
      log(`   agent with Eden:    ${cut(r.answers.with.replace(/\s+/g, " "), 400)}`);
    }
    log("");
  }
  const acts = rows.filter((r) => r.kind === "act");
  log(
    `Summary: ${acts.filter((r) => r.caught).length} of ${acts.length} requests got the fact they needed; ` +
      `chatter got ${rows.find((r) => r.kind === "chatter")?.added.length ?? 0} items; ` +
      `$${rows.reduce((n, r) => n + r.costUsd, 0).toFixed(4)} spent by Eden.`,
  );
  log("Next: README's quick start runs the same server over your own sources; docs/INTEGRATION.md wires an agent.");
}

/** An OpenAI-compatible chat call (examples/personal-agent's convention), or null without OPENAI_API_KEY. */
export function agentFromEnv(env: Record<string, string | undefined> = process.env): DemoOptions["agent"] | undefined {
  const key = env.OPENAI_API_KEY;
  if (!key) return undefined;
  const baseUrl = (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = env.AGENT_MODEL ?? "gpt-4o-mini";
  const agent = async (messages: { role: string; content: string }[]) => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, max_tokens: 1500 }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return `(agent call failed: HTTP ${res.status})`;
    const body = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    agentUsage.calls++;
    agentUsage.inputTokens += body.usage?.prompt_tokens ?? 0;
    agentUsage.outputTokens += body.usage?.completion_tokens ?? 0;
    // A reasoning model can spend the whole allowance thinking and return no text (seen once at 400 tokens on Haiku 5.5
    // through Anthropic's OpenAI-compatible endpoint): said so, rather than printed as a blank answer.
    const choice = body.choices?.[0];
    return choice?.message?.content || `(no answer; finish reason ${choice?.finish_reason ?? "none"})`;
  };
  return agent;
}

/** What the optional agent model was sent and returned over the run, as its provider reported it. */
export const agentUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  for (const a of args) {
    if (a.startsWith("--") && !["--seed", "--suite", "--picks", "--json", "--trace", "--help"].includes(a)) {
      console.error(`demo: unknown flag ${a} (flags: --seed N, --suite NAME, --picks a,b,c, --trace FILE, --json)`);
      process.exit(2);
    }
  }
  if (args.includes("--help")) {
    console.log("bun run demo [--seed 41] [--suite train1] [--picks t1,t2,t3] [--trace FILE] [--json]");
    process.exit(0);
  }
  const agent = agentFromEnv();
  if (!agent) console.error("[demo] no OPENAI_API_KEY: showing what the agent would receive, no model call ($0)");
  const trace = opt("trace");
  const logged: string[] = [];
  const { world, rows } = await runDemo({
    ...(trace ? { log: (l: string) => logged.push(l) } : {}),
    ...(opt("seed") ? { seed: Number(opt("seed")) } : {}),
    ...(opt("suite") ? { suite: opt("suite")! } : {}),
    ...(opt("picks") ? { picks: opt("picks")!.split(",") } : {}),
    ...(agent ? { agent } : {}),
  });
  if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else printDemo(world, rows);
  if (trace) {
    await Bun.write(trace, logged.join("\n") + "\n");
    console.log(
      `Wrote ${logged.length} trace and usage lines to ${trace}: \`bun run digest ${trace}\` summarises them.`,
    );
  }
  if (agent) {
    console.log(
      `Agent model: ${agentUsage.calls} calls, ${agentUsage.inputTokens} input and ${agentUsage.outputTokens} ` +
        "output tokens (billed by your provider, not Eden).",
    );
  }
  process.exit(0);
}
