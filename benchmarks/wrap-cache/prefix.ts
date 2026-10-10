/**
 * P0.7's cached-prefix measure (D29, A1 annex §E): a scripted coding conversation of human turns, each with a tool
 * loop, sent request by request through the wrap's three injection paths, the way a client that keeps its own
 * history sends it (each request repeats the history the client holds, never what the wrap added):
 * - `anthropic`: the Anthropic wrap (`withKnowFactsAnthropic`);
 * - `openai`: the OpenAI-shaped wrap (`withKnowFacts`, which reaches `AgentMemory.injectBody`);
 * - `inject`: the library API `AgentMemory.inject` on an OpenAI message list;
 * - `anthropic-proxy`: the Anthropic proxy's handler (`handleAnthropicMessages`), which also sets the request's cache
 *   breakpoints, read from the body it sends upstream (added after the pre-registration: the handler reshapes the
 *   last message, which the `anthropic` path does not see).
 *
 * For each pair of consecutive requests it compares the earlier request's cacheable prefix (tools, system, then each
 * message, `cache_control` markers left out) with the later request's, block by block: a **prefix break** is a pair
 * where one of the earlier request's blocks changed. A break invalidates the cached conversation from that block on.
 * It also counts, per human turn, whether the packet the turn first received holds the turn's planted fact
 * (`need_hits`), so placement cannot pass by delivering nothing.
 *
 *   bun benchmarks/wrap-cache/prefix.ts [--root <checkout>] [--out <file.json>]
 *
 * `--root` measures another checkout's code (the baseline); the default is this one. The store is a temp dir.
 * `packages/wrap/src/cache-placement.test.ts` runs the same scenario (`measure`) as CI's gate.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Message = Record<string, unknown>;
export type Body = { system?: unknown; tools?: unknown; messages: Message[] };
export type Style = "anthropic" | "openai";

/** What the user told an earlier session: one fact per later turn, typed. */
export const SEED = [
  "We use Clerk for auth in apps/web.",
  "The database is Postgres 16.",
  "Our tests run with vitest.",
  "Deploys go through fly.io.",
];

/** Each human turn: its prompt, the word its packet must carry, and the tools its loop calls. */
const TURNS = [
  { prompt: "Add a login check to the settings page, using the auth provider in apps/web.", needs: "Clerk", tools: 2 },
  { prompt: "Write a migration that adds an index on users.email in the database.", needs: "Postgres", tools: 2 },
  { prompt: "Add a unit test for the email validator with our tests runner.", needs: "vitest", tools: 2 },
  { prompt: "Prepare the release notes and check how deploys go out.", needs: "fly.io", tools: 2 },
];

const SYSTEM = "You are a coding agent working in the acme monorepo. Be concise.";
const TOOLS = [{ name: "Bash", description: "Run a shell command", input_schema: { type: "object" } }];

/** A client's history after each request: the request's messages plus the reply and tool results it got. */
export function* requests(style: Style): Generator<{ turn: number; messages: Message[] }> {
  const history: Message[] = [];
  for (const [turn, spec] of TURNS.entries()) {
    history.push({ role: "user", content: spec.prompt });
    for (let step = 0; step <= spec.tools; step++) {
      yield { turn, messages: structuredClone(history) };
      if (step === spec.tools) {
        history.push({ role: "assistant", content: `Done with turn ${turn + 1}.` });
        break;
      }
      const id = `call_${turn}_${step}`;
      const command = `rg -n "turn${turn}" src/ # step ${step}`;
      const output = `src/a${turn}.ts:${step + 1}: match ${turn}-${step}`;
      if (style === "anthropic") {
        history.push({ role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] });
        history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] });
      } else {
        history.push({
          role: "assistant",
          content: null,
          tool_calls: [{ id, type: "function", function: { name: "Bash", arguments: JSON.stringify({ command }) } }],
        });
        history.push({ role: "tool", tool_call_id: id, content: output });
      }
    }
  }
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (k !== "cache_control") out[k] = withoutCacheControl(v);
  return out;
}

/** The cacheable prefix in order (tools, system, messages), one canonical block each. */
function prefixBlocks(body: Body): string[] {
  const head = [JSON.stringify(withoutCacheControl(body.tools ?? null))];
  head.push(JSON.stringify(withoutCacheControl(body.system ?? null)));
  return [...head, ...body.messages.map((m) => JSON.stringify(withoutCacheControl(m)))];
}

/** Every packet text a request carries, wherever it sits. */
export function packetsOf(body: Body, marks: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      for (const mark of marks) {
        const at = value.indexOf(mark);
        if (at >= 0) out.push(value.slice(at));
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(body.system);
  visit(body.messages);
  return out;
}

export interface PathResult {
  requests: number;
  pairs: number;
  prefix_breaks: number;
  /** The first changed block of each break: "tools", "system" or "message <i>". */
  break_at: string[];
  turns: number;
  need_hits: number;
}

/** Sends the conversation through one path (`send`) and counts its prefix breaks and need hits. */
export async function measure(
  send: (body: Body) => Body | Promise<Body>,
  style: Style,
  marks: readonly string[],
): Promise<PathResult> {
  const result: PathResult = { requests: 0, pairs: 0, prefix_breaks: 0, break_at: [], turns: 0, need_hits: 0 };
  let previous: Body | undefined;
  let lastTurn = -1;
  for (const { turn, messages } of requests(style)) {
    const body: Body =
      style === "anthropic"
        ? { system: SYSTEM, tools: TOOLS, messages }
        : { tools: TOOLS, messages: [{ role: "system", content: SYSTEM }, ...messages] };
    const sent = await send(structuredClone(body));
    result.requests++;
    if (previous) {
      result.pairs++;
      const before = prefixBlocks(previous);
      const after = prefixBlocks(sent);
      const changed = before.findIndex((block, i) => after[i] !== block);
      if (changed >= 0) {
        result.prefix_breaks++;
        result.break_at.push(changed === 0 ? "tools" : changed === 1 ? "system" : `message ${changed - 2}`);
      }
    }
    if (turn !== lastTurn) {
      result.turns++;
      const old = new Set(previous ? packetsOf(previous, marks) : []);
      const fresh = packetsOf(sent, marks).filter((p) => !old.has(p));
      if (fresh.some((p) => p.includes(TURNS[turn]!.needs))) result.need_hits++;
      lastTurn = turn;
    }
    previous = sent;
  }
  return result;
}

type Handler<S> = (req: Request, opts: { state: S; fetch: typeof fetch }) => Promise<Response>;

/** The Anthropic proxy as a path: each request through its handler, and the body it sends upstream. */
export function viaAnthropicProxy<S>(handle: Handler<S>, state: S): (body: Body) => Promise<Body> {
  return async (body) => {
    let upstream: Body | undefined;
    const reply = { id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] };
    const fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      upstream = JSON.parse(String(init?.body ?? "{}")) as Body;
      return Response.json({ ...reply, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    }) as typeof globalThis.fetch;
    const req = new Request("http://local/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k" },
      body: JSON.stringify({ model: "m", max_tokens: 10, ...body }),
    });
    await handle(req, { state, fetch });
    if (!upstream) throw new Error("the proxy sent nothing upstream");
    return upstream;
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const root = resolve(flag("--root") ?? join(import.meta.dir, "../.."));
  const home = mkdtempSync(join(tmpdir(), "eden-wrap-cache-"));
  const work = mkdtempSync(join(tmpdir(), "eden-wrap-cwd-"));
  process.env.EDEN_HOME = home;
  process.env.EDEN_MEMORY_DIR = join(home, "memory");
  process.chdir(work);
  try {
    const index = await import(join(root, "src/index.ts"));
    const sota = await import(join(root, "src/memory-sota.ts"));
    const know = await import(join(root, "packages/wrap/src/know-inject.ts"));
    const proxy = await import(join(root, "packages/wrap/src/anthropic.ts"));
    const tools = await import(join(root, "packages/wrap/src/wrap-tools.ts"));
    const marks: string[] = sota.MEMORY_PACKET_MARKS;
    const seed = SEED.map((content) => ({ role: "user", content }));
    // Each wrap path gets a store of its own, so none reads the turns another path's conversation left.
    const seeded = (name: string) => {
      process.env.EDEN_MEMORY_DIR = join(home, name);
      index.processMemory().observe(seed);
    };
    const library = index.openMemory({ dir: join(home, "library") });
    library.observe(seed);
    seeded("anthropic");
    const anthropic = await measure((b) => know.withKnowFactsAnthropic(b), "anthropic", marks);
    seeded("openai");
    const openai = await measure((b) => know.withKnowFacts(b) as Body, "openai", marks);
    const inject = await measure((b) => ({ ...b, messages: library.inject(b.messages) }), "openai", marks);
    seeded("anthropic-proxy");
    const state = tools.createState({ programs: [] });
    const anthropicProxy = await measure(viaAnthropicProxy(proxy.handleAnthropicMessages, state), "anthropic", marks);
    const out = { root, anthropic, openai, inject, "anthropic-proxy": anthropicProxy };
    const json = JSON.stringify(out, null, 2);
    const file = flag("--out");
    if (file) writeFileSync(file, json + "\n");
    console.log(json);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
