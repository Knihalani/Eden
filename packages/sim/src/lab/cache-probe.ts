/**
 * A3 (docs/research/a3-cost-speed.md): does Anthropic cache the Pi agent's fixed prefix (tools + system prompt) on
 * Haiku 5.5, and how long is it? D260 inferred ~565 tokens for the `eden` arm and found it was not served from cache,
 * without establishing why. This probe answers it on the wire, for the exact request pi-ai builds:
 *
 * - builds each arm's first request as pi-ab does (`systemPrompt`, the arm's tools, the user turn) and lets pi-ai
 *   convert it, capturing the JSON body it would send (`fetch` wrapper; the capture call itself is answered locally);
 * - counts the prefix with `POST /v1/messages/count_tokens` (free), with and without the tools;
 * - sends the captured body twice, `max_tokens` 1, and reports `cache_creation_input_tokens` and
 *   `cache_read_input_tokens` of each (a few hundred tokens a call, booked to the spend ledger under `probe`);
 * - then repeats both with the tenant's house rules (`TENANT_GUIDE`, pi-ab's `--tenant-prompt`) in the system prompt.
 *
 *   env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cache-probe.ts --suite train1 --seed 41 \
 *     --spend-ledger .local/a3/ledger.jsonl --spend-cap 2 --run-label a3-cache-probe
 *
 * Simulated worlds only (no user data). The key is read by `keyFor` and never printed.
 */
import { Type, type Context } from "@earendil-works/pi-ai";
import { anthropicCost, anthropicPrice } from "@eden/llm";
import { ASK_QUESTION_DESCRIPTION } from "@eden/protocol";
import { REALISTIC, simSources } from "../sources";
import { ASK_DESCRIPTION, searchToolSpec, systemPrompt, userPrompt, worldOf } from "./ab-common";
import { keyFor, labAccess, piAnthropicModel, piRegistry } from "./free";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const MODEL = opt("model", "claude-haiku-5-5");
const SUITE = opt("suite", "train1");
const SEED = Number(opt("seed", "41"));
const access = labAccess(args, [MODEL]);
const meter = access.ledger!.meter("probe");
const key = keyFor(MODEL);
const API = "https://api.anthropic.com/v1";
const headers = { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };

const { world, tasks } = worldOf(SEED, SUITE, "hidden", { maxTasks: 30, maxOffworld: 5 });
const sources = simSources(world, REALISTIC, 0, SEED);
const queryParams = Type.Object({ query: Type.String({ description: "What to search for" }) });
const askParams = Type.Object({ question: Type.String({ description: ASK_QUESTION_DESCRIPTION }) });
const noop = async () => ({ content: [], details: {} });
const arms = {
  tools: sources.map((s) => ({ ...searchToolSpec(s), label: s.id, parameters: queryParams, execute: noop })),
  eden: [
    { name: "ask_context", description: ASK_DESCRIPTION, label: "ask_context", parameters: askParams, execute: noop },
  ],
};

const piModel = piAnthropicModel(MODEL, 1);
const models = piRegistry([piModel]);

/** The body pi-ai would send for this context (answered locally with an empty stream). */
async function capture(context: Context): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | null = null;
  const fake = (async (_u: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response("", { status: 400 });
  }) as unknown as typeof fetch;
  await models
    .streamSimple(piModel, context, { fetch: fake, maxRetries: 0, cacheRetention: "short", apiKey: "placeholder" })
    .result()
    .catch(() => undefined);
  if (!body) throw new Error("pi-ai sent nothing");
  return body;
}

async function post(path: string, body: unknown): Promise<Record<string, any>> {
  const res = await access.fetch(`${API}/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const json = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

const count = (b: Record<string, unknown>) => {
  const { stream: _s, max_tokens: _m, ...rest } = b;
  return post("messages/count_tokens", rest).then((r) => r.input_tokens as number);
};

async function send(body: Record<string, unknown>) {
  const req = { ...body, stream: false, max_tokens: 1 };
  meter.reserve(0.001);
  const t0 = performance.now();
  // A refused call is not billed: give its reservation back, so the ledger does not hold it.
  const r = await post("messages", req).catch((e: unknown) => {
    meter.release(0.001);
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
  meter.book({
    model: MODEL,
    usage,
    costUsd,
    latencyMs: Math.round(performance.now() - t0),
    ttftMs: null,
    stopReason: r.stop_reason ?? null,
  });
  return { input: u.input_tokens, write: u.cache_creation_input_tokens, read: u.cache_read_input_tokens, costUsd };
}

const task = tasks[0]!;
for (const tenant of [false, true]) {
  for (const [arm, tools] of Object.entries(arms)) {
    const system = systemPrompt(world, { lookups: false, data: true, tenant });
    const ctx: Context = {
      systemPrompt: system,
      tools: tools as never,
      messages: [{ role: "user", content: userPrompt(task), timestamp: Date.now() }],
    };
    const body = await capture(ctx);
    const noUser = { ...body, messages: [{ role: "user", content: "." }] };
    const prefixOnly = await count(noUser);
    const toolsOnly = await count({ ...noUser, system: undefined });
    const full = await count(body);
    // A different user turn per send so only the shared prefix can be read: what a new task does.
    const a = await send(body);
    const b = await send({ ...body, messages: [{ role: "user", content: userPrompt(tasks[1]!) }] });
    console.log(
      JSON.stringify({
        arm,
        tenant,
        tokens: { full, prefixPlusDot: prefixOnly, toolsPlusDot: toolsOnly },
        first: a,
        second: b,
      }),
    );
  }
}
