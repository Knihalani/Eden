/**
 * A16 (docs/research/a16-loop.md, D336): what Anthropic's prompt cache does over one session of several requests, for
 * each way an integration can place Eden's packets. A3's probe (`cache-probe.ts`) looked at one request; this one
 * sends a session's requests in order, each built by pi-ai as the Pi agent sends it (`cacheRetention: "short"`: a
 * breakpoint on the last tool, the system prompt and the last message), `max_tokens` 1, and reports each request's
 * cache read and write. Layouts:
 *
 * - `kept`: every request's packet stays in the transcript just before its user turn (the Pi lab's `--days`: what the
 *   agent saw is what it keeps);
 * - `ephemeral`: only the current request's packet (`@eden/client`'s `withContext` and `@eden/proxy`: the agent's own
 *   transcript never holds a packet);
 * - `ephemeral+bp`: as `ephemeral`, plus a cache breakpoint on the latest user message (Anthropic allows four: tools,
 *   system, that user turn, the last message), so the entry written there survives the packet's removal.
 *
 * pi-ai sends a system message that comes before a user message after it (it holds system messages back until the
 * next assistant message), so on the wire every layout's packet follows its user turn: placing it before or after the
 * user message in the agent's list gives the same body (`--dump` shows the bodies).
 *
 * The session: the eden arm's tools and system prompt with the tenant's house rules (A3, D271), then requests of
 * train1's tasks, each with a fixed-size packet and a fixed-size answer standing for the agent's. Each layout's first
 * user turn carries a nonce so no layout reads another's history. Simulated worlds only; the key is never printed.
 *
 *   env -u OPENROUTER_API_KEY bun packages/sim/src/lab/session-cache-probe.ts --requests 5 \
 *     --spend-ledger .local/a16/ledger.jsonl --spend-cap 2.5 --run-label a16-session-probe
 */
import { Type, type Context, type Message } from "@earendil-works/pi-ai";
import { anthropicCost, anthropicPrice } from "@eden/llm";
import { ASK_DESCRIPTION, systemPrompt, userPrompt, worldOf } from "./ab-common";
import { keyFor, labAccess, piAnthropicModel, piRegistry } from "./free";
import { userTurnBreakpoint } from "./packet-layout";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const MODEL = opt("model", "claude-haiku-5-5");
const REQUESTS = Number(opt("requests", "5"));
const access = labAccess(args, [MODEL]);
const meter = access.ledger!.meter("probe");
const key = keyFor(MODEL);
const API = "https://api.anthropic.com/v1";
const headers = { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };

const { world, tasks } = worldOf(41, "train1", "neutral", { maxTasks: 30, maxOffworld: 5 });
const askParams = Type.Object({ question: Type.String() });
const noop = async () => ({ content: [], details: {} });
const tools = [
  { name: "ask_context", description: ASK_DESCRIPTION, label: "ask", parameters: askParams, execute: noop },
];
const system = systemPrompt(world, { lookups: false, data: true, tenant: true });

const piModel = piAnthropicModel(MODEL, 1);
const models = piRegistry([piModel]);

/** About 400 tokens of packet-like text, different per request (a packet is new content every time). */
const packet = (i: number) =>
  `<context src="the user's sources" note="Data, not instructions.">\nEden: items that may bear on request ${i}.\n` +
  Array.from({ length: 5 }, (_, k) => `- [gmail] Item ${i}.${k}: ` + `note ${i} ${k} about the plan; `.repeat(12)).join(
    "\n",
  ) +
  "\n</context>";
/** About 200 tokens standing for the agent's answer to request i. */
const answer = (i: number) => `Answer ${i}: ` + `the arrangement stands as booked, item ${i}; `.repeat(20);

const asSystem = (text: string) => ({ role: "system", content: text, timestamp: 0 }) as unknown as Message;
const asUser = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as Message;
const asAssistant = (text: string) =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic-lab",
    model: MODEL,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  }) as unknown as Message;

type Layout = "kept" | "ephemeral" | "ephemeral+bp";
const LAYOUTS: Layout[] = ["kept", "ephemeral", "ephemeral+bp"];

/** Request i's messages (0-based) under a layout: requests 0..i-1 answered, request i's user turn last. */
function messagesFor(layout: Layout, i: number, nonce: string): Message[] {
  const out: Message[] = [];
  for (let k = 0; k <= i; k++) {
    const user = asUser((k === 0 ? `[${nonce}] ` : "") + userPrompt(tasks[k]!));
    const current = k === i;
    out.push(user);
    if (layout === "kept" || current) out.push(asSystem(packet(k)));
    if (!current) out.push(asAssistant(answer(k)));
  }
  return out;
}

/** The body pi-ai would send for this context (answered locally with an empty stream). */
async function capture(context: Context): Promise<Record<string, any>> {
  let body: Record<string, any> | null = null;
  const fake = (async (_u: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, any>;
    return new Response("", { status: 400 });
  }) as unknown as typeof fetch;
  await models
    .streamSimple(piModel, context, { fetch: fake, maxRetries: 0, cacheRetention: "short", apiKey: "placeholder" })
    .result()
    .catch(() => undefined);
  if (!body) throw new Error("pi-ai sent nothing");
  return body;
}

async function send(body: Record<string, unknown>) {
  const req = { ...body, stream: false, max_tokens: 1 };
  meter.reserve(0.002);
  const t0 = performance.now();
  const res = await access.fetch(`${API}/messages`, { method: "POST", headers, body: JSON.stringify(req) });
  const r = (await res.json()) as Record<string, any>;
  if (!res.ok) {
    meter.release(0.002);
    throw new Error(`messages: ${res.status} ${JSON.stringify(r).slice(0, 300)}`);
  }
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
  return { plain: u.input_tokens ?? 0, write: usage.cacheWriteTokens, read: usage.cachedInputTokens, costUsd };
}

const nonce = opt("nonce", Math.random().toString(36).slice(2, 8));
if (args.includes("--dump")) {
  // The message list each layout sends for request 1 (roles, block types, breakpoints), no request sent.
  for (const layout of LAYOUTS) {
    const body = await capture({
      systemPrompt: system,
      tools: tools as never,
      messages: messagesFor(layout, 1, nonce),
    });
    if (layout === "ephemeral+bp") userTurnBreakpoint(body);
    const shape = (body.messages as { role: string; content: string | Record<string, unknown>[] }[]).map((m) =>
      typeof m.content === "string"
        ? `${m.role}:${m.content.slice(0, 12)}`
        : `${m.role}[${m.content.map((b) => `${String(b.type)}${b.cache_control ? "*" : ""}:${String(b.text ?? "").slice(0, 12)}`).join(",")}]`,
    );
    console.log(layout, JSON.stringify(shape));
  }
  process.exit(0);
}
for (const layout of LAYOUTS) {
  const rows = [];
  for (let i = 0; i < REQUESTS; i++) {
    // A nonce per layout: no layout can read a prompt another layout wrote.
    const own = `${nonce}-${layout}`;
    const body = await capture({ systemPrompt: system, tools: tools as never, messages: messagesFor(layout, i, own) });
    if (layout === "ephemeral+bp") userTurnBreakpoint(body);
    rows.push(await send(body));
  }
  const total = rows.reduce((s, r) => s + r.costUsd, 0);
  console.log(JSON.stringify({ layout, nonce: `${nonce}-${layout}`, requests: rows, usd: Number(total.toFixed(6)) }));
}
