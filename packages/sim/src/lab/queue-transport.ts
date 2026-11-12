/**
 * The "queue" lab transport (F9, D1101; packages/sim/lab/subagent/README.md): every lab model call is answered by a
 * Claude Code subagent through files instead of a paid API. LAB ONLY, sim data only: nothing in packages/server or
 * packages/engine imports it.
 *
 * `EDEN_LAB_QUEUE=DIR` (or `--provider queue --queue-dir DIR`, read by `labAccess`) replaces the global `fetch` for
 * Anthropic's Messages API (`https://api.anthropic.com/v1/messages`); every other host keeps the real fetch. Since
 * every role reaches that API through the global fetch (`AnthropicModel` via the pacer, Pi's agent via pi-ai's SDK
 * client), one switch covers the agent, the push check, cards, intent, the reader, the judge and the grader. Run
 * every role on a `claude-*` id: an OpenRouter id is not served here.
 *
 * - A request is keyed by a hash of its role, model and normalised body (system, messages, tools, tool choice, max
 *   tokens, stop sequences, output config; cache markers dropped), so the same prompt is the same key everywhere.
 * - `DIR/done/<key>.json` is the replay store: a hit is answered at once.
 * - A miss writes `DIR/pending/<key>.json` (the request and its expected output shape, `outputSpec`) and polls for
 *   `DIR/done/<key>.json` (`EDEN_LAB_QUEUE_TIMEOUT_S`, default 4 hours). Files are written to a temporary name and
 *   renamed, so many processes and many requests in flight never see half a file; one process waits once per key.
 * - The answer is streamed back as the API would (text or tool_use blocks) with zero usage, so the spend ledger books
 *   $0. Every call is logged to `DIR/calls.jsonl` with `transport: "subagent-sim"`.
 * - The request's abort signal is ignored while it waits: a role's 60 s timeout would otherwise drop every miss.
 *   A role with its own deadline above the fetch (Promise.race) fails open on a miss; run the command again once the
 *   queue is drained and it hits.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROLE_HEADER = "x-eden-lab-role";
export const TRANSPORT = "subagent-sim";
const JSON_INSTRUCTION = "Reply with one JSON object only";

export interface OutputSpec {
  /** "json": one JSON object; "tools": text and/or calls to the listed tools; "text": plain text. */
  kind: "text" | "json" | "tools";
  maxTokens?: number;
  stop?: string[];
  tools?: { name: string; required: string[] }[];
}

export interface QueuedRequest {
  id: string;
  role: string;
  model: string;
  system: string;
  messages: { role: string; content: string }[];
  tools?: { name: string; description?: string; input_schema?: unknown }[];
  outputSpec: OutputSpec;
  createdAt: string;
}

export interface Answer {
  text?: string;
  toolCalls?: { name: string; input: Record<string, unknown> }[];
}

type Block = { type: string; text?: string; name?: string; input?: unknown; content?: unknown; tool_use_id?: string };
type Body = {
  model?: string;
  system?: string | Block[];
  messages?: { role: string; content: string | Block[] }[];
  tools?: { name: string; description?: string; input_schema?: { required?: string[] } }[];
  tool_choice?: unknown;
  max_tokens?: number;
  stop_sequences?: string[];
  output_config?: unknown;
  stream?: boolean;
};

const textOf = (c: unknown): string => {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return (c as Block[])
    .map((b) => {
      if (b.type === "text") return b.text ?? "";
      if (b.type === "tool_use") return `[tool call ${b.name} ${JSON.stringify(b.input)}]`;
      if (b.type === "tool_result") return `[tool result ${b.tool_use_id ?? ""}]\n${textOf(b.content)}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

/** Drops cache markers (and other per-call noise) so the key depends on the prompt alone. */
function normalise(body: Body) {
  return {
    model: body.model ?? "",
    system: textOf(body.system),
    messages: (body.messages ?? []).map((m) => ({ role: m.role, content: textOf(m.content) })),
    tools: (body.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    tool_choice: body.tool_choice ?? null,
    max_tokens: body.max_tokens ?? null,
    stop: body.stop_sequences ?? [],
    output_config: body.output_config ?? null,
  };
}

/**
 * The role a request is for: the header `labModel` sets, else "agent" (the harnesses' agents call through pi-ai or
 * their own clients, which carry no header).
 */
export function roleOf(headers: Headers): string {
  return headers.get(ROLE_HEADER) ?? "agent";
}

export function keyOf(role: string, body: Body): string {
  return createHash("sha256")
    .update(JSON.stringify({ role, ...normalise(body) }))
    .digest("hex")
    .slice(0, 32);
}

export function outputSpecOf(body: Body): OutputSpec {
  const system = textOf(body.system);
  const tools = (body.tools ?? []).map((t) => ({ name: t.name, required: t.input_schema?.required ?? [] }));
  const kind = tools.length ? "tools" : system.includes(JSON_INSTRUCTION) ? "json" : "text";
  return {
    kind,
    ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}),
    ...(body.stop_sequences?.length ? { stop: body.stop_sequences } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

export function requestOf(id: string, role: string, body: Body): QueuedRequest {
  const n = normalise(body);
  return {
    id,
    role,
    model: n.model,
    system: n.system,
    messages: n.messages,
    ...(n.tools.length ? { tools: n.tools } : {}),
    outputSpec: outputSpecOf(body),
    createdAt: new Date().toISOString(),
  };
}

/** Writes JSON atomically: a temporary name in the same directory, then a rename. */
export function writeAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  renameSync(tmp, path);
}

export const queueDirs = (dir: string) => ({
  pending: join(dir, "pending"),
  taken: join(dir, "taken"),
  done: join(dir, "done"),
});

export function ensureQueue(dir: string): void {
  for (const d of Object.values(queueDirs(dir))) mkdirSync(d, { recursive: true });
}

/** Cuts the answer at the first stop sequence it contains, as the API would. */
function stopAt(text: string, stop: string[] | undefined): { text: string; stopped: boolean } {
  let cut = -1;
  for (const s of stop ?? []) {
    const i = text.indexOf(s);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  return cut < 0 ? { text, stopped: false } : { text: text.slice(0, cut), stopped: true };
}

/** The Messages API events for an answer: text and tool_use blocks, zero usage (the ledger books $0). */
export function messageEvents(model: string, answer: Answer, stop?: string[]): Record<string, unknown>[] {
  const cut = stopAt(answer.text ?? "", stop);
  const calls = cut.stopped ? [] : (answer.toolCalls ?? []);
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const id = `msg_queue_${Math.random().toString(36).slice(2)}`;
  const events: Record<string, unknown>[] = [
    {
      type: "message_start",
      message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, usage },
    },
  ];
  let index = 0;
  if (cut.text || !calls.length) {
    events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    if (cut.text) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: cut.text } });
    events.push({ type: "content_block_stop", index });
    index++;
  }
  for (const call of calls) {
    const toolId = `toolu_queue_${Math.random().toString(36).slice(2)}`;
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: toolId, name: call.name, input: {} },
    });
    events.push({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input ?? {}) },
    });
    events.push({ type: "content_block_stop", index });
    index++;
  }
  const reason = cut.stopped ? "stop_sequence" : calls.length ? "tool_use" : "end_turn";
  events.push({
    type: "message_delta",
    delta: {
      stop_reason: reason,
      stop_sequence: cut.stopped ? (stop?.find((s) => answer.text?.includes(s)) ?? null) : null,
    },
    usage: { output_tokens: 0 },
  });
  events.push({ type: "message_stop" });
  return events;
}

/** The same answer as one non-streamed Messages API response. */
export function messageJson(model: string, answer: Answer, stop?: string[]): Record<string, unknown> {
  const cut = stopAt(answer.text ?? "", stop);
  const calls = cut.stopped ? [] : (answer.toolCalls ?? []);
  const content: Record<string, unknown>[] = [];
  if (cut.text || !calls.length) content.push({ type: "text", text: cut.text });
  for (const c of calls) {
    content.push({
      type: "tool_use",
      id: `toolu_queue_${Math.random().toString(36).slice(2)}`,
      name: c.name,
      input: c.input,
    });
  }
  return {
    id: `msg_queue_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: cut.stopped ? "stop_sequence" : calls.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

const sse = (events: Record<string, unknown>[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

const isMessagesUrl = (url: string) => /^https:\/\/api\.anthropic\.com\/v1\/messages(\?|$)/.test(url);

let installed: string | null = null;
let restore: (() => void) | null = null;

/** Whether the queue transport is on in this process (and its directory). */
export const queueDir = () => installed;

/** Replaces the global fetch for Anthropic's Messages API with the queue in `dir`. Idempotent. */
export function installQueue(dir: string, options: { pollMs?: number; timeoutS?: number } = {}): void {
  if (installed) {
    if (installed !== dir) throw new Error(`queue transport already on ${installed}, not ${dir}`);
    return;
  }
  ensureQueue(dir);
  const { pending, done } = queueDirs(dir);
  const pollMs = options.pollMs ?? 500;
  const timeoutS = options.timeoutS ?? Number(process.env.EDEN_LAB_QUEUE_TIMEOUT_S ?? 4 * 3600);
  // Roles that need a key to start get a placeholder: no request leaves this process for that API.
  process.env.HAIKU_API_KEY ||= "queue-transport-no-key";
  const real = globalThis.fetch;
  const inflight = new Map<string, Promise<Answer>>();
  const log = (line: Record<string, unknown>) =>
    appendFileSync(
      join(dir, "calls.jsonl"),
      JSON.stringify({ ...line, transport: TRANSPORT, pid: process.pid }) + "\n",
    );

  const wait = (key: string, request: QueuedRequest): Promise<Answer> => {
    const donePath = join(done, `${key}.json`);
    if (existsSync(donePath)) return Promise.resolve(readDone(donePath));
    const known = inflight.get(key);
    if (known) return known;
    const p = (async () => {
      // Another process may already have queued (or a driver taken) the same key: queueing it twice is harmless,
      // since the answer lands under the same name.
      const pendingPath = join(pending, `${key}.json`);
      if (!existsSync(pendingPath) && !existsSync(join(queueDirs(dir).taken, `${key}.json`))) {
        writeAtomic(pendingPath, request);
      }
      const until = Date.now() + timeoutS * 1000;
      while (Date.now() < until) {
        if (existsSync(donePath)) return readDone(donePath);
        await new Promise((r) => setTimeout(r, pollMs));
      }
      throw new Error(`queue transport: no answer for ${key} (${request.role}) in ${timeoutS}s`);
    })();
    inflight.set(key, p);
    p.finally(() => inflight.delete(key)).catch(() => {});
    return p;
  };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isMessagesUrl(url)) return real(input as Parameters<typeof fetch>[0], init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const raw = init?.body ?? (input instanceof Request ? await input.text() : "");
    const body = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer)) as Body;
    const role = roleOf(headers);
    const key = keyOf(role, body);
    const hit = existsSync(join(done, `${key}.json`));
    const t0 = Date.now();
    const answer = await wait(key, requestOf(key, role, body));
    // `EDEN_LAB_QUEUE_RUN` labels a run's calls, so two arms sharing one queue (and its replay store) price apart (F7).
    const run = process.env.EDEN_LAB_QUEUE_RUN;
    log({
      key,
      role,
      model: body.model,
      hit,
      waitedMs: Date.now() - t0,
      at: new Date().toISOString(),
      ...(run ? { run } : {}),
    });
    const model = body.model ?? "claude-haiku-5-5";
    return body.stream
      ? sse(messageEvents(model, answer, body.stop_sequences))
      : Response.json(messageJson(model, answer, body.stop_sequences));
  }) as typeof fetch;
  installed = dir;
  restore = () => {
    globalThis.fetch = real;
    installed = null;
    restore = null;
  };
  process.stderr.write(`[queue transport] model calls are answered through ${dir} (transport: ${TRANSPORT}, $0)\n`);
}

/** Puts the real fetch back (tests). */
export function uninstallQueue(): void {
  restore?.();
}

function readDone(path: string): Answer {
  const d = JSON.parse(readFileSync(path, "utf8")) as { answer: Answer };
  return d.answer;
}

/** A fetch that tags each request with its role, so the queue keys and labels it. */
export function withRole(f: typeof fetch, role: string): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set(ROLE_HEADER, role);
    return f(input, { ...init, headers });
  }) as typeof fetch;
}

/**
 * The queue's directory from a runner's arguments or the environment: `--provider queue --queue-dir DIR`, or
 * `EDEN_LAB_QUEUE=DIR`. Null when the queue is off.
 */
export function queueDirFrom(args: string[], env = process.env): string | null {
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const provider = opt("provider");
  if (provider === "queue") {
    const dir = opt("queue-dir") ?? env.EDEN_LAB_QUEUE;
    if (!dir) throw new Error("--provider queue needs --queue-dir DIR (or EDEN_LAB_QUEUE)");
    return dir;
  }
  return env.EDEN_LAB_QUEUE || null;
}
