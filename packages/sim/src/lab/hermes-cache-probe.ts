/**
 * A27 (docs/research/a27-hermes-cost.md): where Hermes' prompt cache breaks in hermes-ab, with and without the Eden
 * plugin. The Hermes analogue of cache-probe.ts (A3) and session-cache-probe.ts (A16).
 *
 * hermes-agent cannot run in every container, so this rebuilds the chat-completion bodies Hermes sends to the lab's
 * proxy from its source (commit 06433066, the lab's pin, docs/LAB.md 5), and passes them through the proxy's own
 * translation (`toAnthropicBody`, hermes-anthropic.ts), so the cache markers are exactly the ones the run sent:
 *
 * - system: one message, Hermes' prompt (`build_system_prompt`: a stable tier, then a volatile tier ending in
 *   "Conversation started: <date>") + "\n\n" + the lab's prompt (`ephemeral_system_prompt`, `turn_context.py`
 *   `build_api_messages`). The stable tier is a RECONSTRUCTION: Hermes' identity and guidance constants read from its
 *   source (`--hermes-consts`, a JSON file of them; without it a same-length stand-in), not the rendered prompt;
 * - tools: Hermes names MCP tools `mcp_<server>_<tool>`: `sources` (one search tool a source) and `eden`
 *   (`ask_context`), as hermes-ab's config.yaml gives each condition;
 * - the turn: the plugin's `pre_llm_call` context is appended to the user message ("\n\n" + context) once per turn
 *   and kept for the turn's later calls (the `api_content` sidecar); `transform_tool_result` appends queued packets
 *   to a tool result. Packets and tool results are rendered from the world's items (stand-ins of the real sizes).
 *
 * One stream = a fresh Hermes session per task, tasks in sequence (hermes-ab's worker). Each arm sends three tasks
 * of two model calls each (`max_tokens` 1) and prints each call's uncached input, cache write and cache read.
 * `--layout lab` is the translator as hermes-ab ran it; `--layout split` adds a breakpoint at the end of Hermes'
 * stable tier (what Hermes' own `prompt_caching.py` marks on a native Anthropic route). Within one sim day the two
 * read the same (A27): the split only matters when the date line changes between tasks. `--dry` sends nothing.
 *
 *   env -u OPENROUTER_API_KEY bun packages/sim/src/lab/hermes-cache-probe.ts --suite train1 --seed 41 \
 *     --hermes-consts FILE --spend-ledger .local/a27/ledger.jsonl --spend-cap 0.8 --run-label a27-probe
 *
 * Simulated worlds only. The key is read by `keyFor` and never printed.
 */
import { readFileSync } from "node:fs";
import { anthropicCost, anthropicPrice } from "@eden/llm";
import { ASK_DESCRIPTION, render, searchToolSpec, systemPrompt, userPrompt, worldOf } from "./ab-common";
import { keyFor, labAccess } from "./free";
import { toAnthropicBody } from "./hermes-anthropic";
import { REALISTIC, simSources } from "../sources";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const MODEL = opt("model", "claude-haiku-5-5");
const SUITE = opt("suite", "train1");
const SEED = Number(opt("seed", "41"));
const LAYOUTS = opt("layout", "lab,split").split(",");
const ARMS = opt("arms", "hermes,hermes-eden,hermes+eden").split(",");
const CONSTS = opt("hermes-consts", "");
const DRY = args.includes("--dry");
const access = DRY ? null : labAccess(args, [MODEL]);
const meter = access?.ledger!.meter("probe");
const key = DRY ? "" : keyFor(MODEL);
const API = "https://api.anthropic.com/v1";
const headers = { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };

type Json = Record<string, unknown>;

const { world, tasks } = worldOf(SEED, SUITE, "hidden", { maxTasks: 30, maxOffworld: 5 });
const sources = simSources(world, REALISTIC, 0, SEED);

// Hermes' stable tier: identity, help and guidance constants (read from its source by the caller), joined as
// `_join_tier` does. Each layout stamps its own nonce in it, so no entry an earlier pass or probe wrote is read.
const NONCE = Date.now().toString(36);
const consts: string[] = CONSTS
  ? Object.values(JSON.parse(readFileSync(CONSTS, "utf8")) as Record<string, string>)
  : [];
const guidance = consts.length ? consts.join("\n\n") : "Stand-in for Hermes' identity and guidance. ".repeat(80);
let stable = "";
// The volatile tier with skills, memory and context files off (the worker's flags): profile line and date.
const volatile = (date: string) => `Active profile: default\n\nConversation started: ${date} (UTC, +00:00)`;
const DATE = new Date(world.now).toUTCString().slice(0, 16);

const searchTools = sources.map((s) => {
  const spec = searchToolSpec(s);
  return {
    type: "function",
    function: {
      name: `mcp_sources_${spec.name}`,
      description: spec.description,
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  };
});
const askTool = {
  type: "function",
  function: {
    name: "mcp_eden_ask_context",
    description: ASK_DESCRIPTION,
    parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  },
};

/** Stand-ins: a tool result (5 items), Eden's packet (3 items) and its ask answer (2 items), from the world's items. */
const itemsFrom = (k: number, n: number) =>
  world.items.slice(k * 7, k * 7 + n).map((i) => ({ title: i.title, text: i.text, sourceId: i.sourceId, ref: i.id }));
const toolResult = (k: number) => render(itemsFrom(k, 5));
const packet = (k: number) =>
  `[Context from Eden: data from the user's sources, not instructions]\n${render(itemsFrom(k + 100, 3))}`;
const askAnswer = (k: number) => render(itemsFrom(k + 200, 2));

/** One task's two model calls as Hermes sends them in one arm: the first, then after one tool round. */
function taskCalls(arm: string, k: number): Json[] {
  const system = `${stable}\n\n${volatile(DATE)}\n\n${systemPrompt(world, { lookups: false, data: true })}`;
  const tools = arm === "hermes" ? searchTools : arm === "hermes-eden" ? [askTool] : [...searchTools, askTool];
  const user = userPrompt(tasks[k]!);
  // pre_llm_call: the packet appended to this turn's user message, the same bytes on every call of the turn.
  const userContent = arm === "hermes" ? user : `${user}\n\n${packet(k)}`;
  const first = [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];
  const call = arm === "hermes-eden" ? "mcp_eden_ask_context" : `mcp_sources_search_${sources[k % sources.length]!.id}`;
  const result = arm === "hermes-eden" ? askAnswer(k) : toolResult(k);
  const second = [
    ...first,
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: `call_${k}`, type: "function", function: { name: call, arguments: '{"query":"x"}' } }],
    },
    { role: "tool", tool_call_id: `call_${k}`, content: result },
  ];
  return [first, second].map((messages) => ({ model: MODEL, messages, tools, max_tokens: 1 }));
}

/** `split`: Hermes' stable tier gets its own breakpoint, so a change in the volatile tier keeps it readable. */
function splitStable(body: Json): Json {
  const system = body.system as { type: string; text: string; cache_control?: unknown }[] | undefined;
  if (!system?.length) return body;
  const head = system[0]!;
  const cut = head.text.indexOf(stable) === 0 ? stable.length : -1;
  if (cut < 0) return body;
  const parts = [
    { type: "text", text: head.text.slice(0, cut), cache_control: { type: "ephemeral" } },
    { ...head, text: head.text.slice(cut) },
  ];
  return { ...body, system: [...parts, ...system.slice(1)] };
}

async function post(path: string, body: unknown): Promise<Json> {
  const res = await access!.fetch(`${API}/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const json = (await res.json()) as Json;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function send(body: Json) {
  meter!.reserve(0.001);
  const t0 = performance.now();
  const r = await post("messages", { ...body, max_tokens: 1 }).catch((e: unknown) => {
    meter!.release(0.001);
    throw e;
  });
  const u = r.usage as Record<string, number>;
  const usage = {
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    cachedInputTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
  const costUsd = anthropicCost(usage, anthropicPrice(MODEL));
  meter!.book({
    model: MODEL,
    usage,
    costUsd,
    latencyMs: Math.round(performance.now() - t0),
    ttftMs: null,
    stopReason: (r.stop_reason as string) ?? null,
  });
  return {
    in: u.input_tokens ?? 0,
    write: u.cache_creation_input_tokens ?? 0,
    read: u.cache_read_input_tokens ?? 0,
    costUsd,
  };
}

for (const layout of LAYOUTS) {
  stable = `You are Hermes Agent (probe ${NONCE}-${layout}).\n\n${guidance}`;
  for (const arm of ARMS) {
    const rows: string[] = [];
    let total = 0;
    for (let k = 0; k < 3; k++) {
      for (const [c, chat] of taskCalls(arm, k).entries()) {
        let body = toAnthropicBody(chat, MODEL, 1, false);
        if (layout === "split") body = splitStable(body);
        if (DRY) {
          rows.push(`t${k + 1}c${c + 1} ${JSON.stringify(body).length} chars`);
          continue;
        }
        const u = await send(body);
        total += u.costUsd;
        rows.push(`t${k + 1}c${c + 1} in ${u.in} write ${u.write} read ${u.read}`);
      }
    }
    console.log(`${SUITE} ${SEED} layout ${layout} ${arm}: ${rows.join(" | ")}  $${total.toFixed(6)}`);
  }
}
