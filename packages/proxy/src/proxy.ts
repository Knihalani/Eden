/**
 * Eden in front of the agent's model, as an OpenAI-compatible proxy (D280).
 * The agent changes only its base URL; on each `POST …/chat/completions` the proxy
 *
 * 1. reports the conversation's new messages to Eden as events (a user message, the assistant's text and tool calls,
 *    tool results), each message once per conversation,
 * 2. puts the context Eden returns in a system message just before the latest user message (`withContext`'s place),
 *    keeping the turn's earlier packets so every model call of a tool-using turn sees them, and
 * 3. forwards the request to the upstream model and streams its answer back unchanged.
 *
 * Fails open (D14): with Eden down, slow or refusing, the request goes upstream as it came. Identity: the
 * `x-eden-user-id` header, else the body's OpenAI `user` field; the conversation is `x-eden-session-id`, else a hash
 * of its first message that is not a system prompt (stable as it grows). Ids pass through `edenId`. No user id: no
 * Eden. With `proxyKey`, every caller must send it (`x-eden-proxy-key`). One deadline bounds Eden's work per request.
 * The upstream key (`Authorization`) is forwarded and never logged; only the message text goes to Eden, as with the
 * SDK. Eden's `ask_context` is not added: give the agent the MCP tool for that (docs/INTEGRATION.md). Tool calls are
 * not checked: the agent runs them between two requests, after their answer streamed through, so an agent that acts
 * wraps its acting tools with the SDK's `guardTools` (D420).
 *
 * `POST /v1/messages` (Anthropic's Messages API, D653) gets the same treatment: `fromAnthropic` reads the conversation
 * as chat messages, the code above runs on that view, and `toAnthropic` writes each packet into its user message as a
 * text block. There the user is `x-eden-user-id`, else `metadata.user_id`; `x-api-key` is forwarded and never logged;
 * the proxy's own errors have Anthropic's shape. `POST /v1/responses` (OpenAI's Responses API, D656) likewise:
 * `fromResponses` reads `input`'s items as chat messages and `toResponses` puts each packet back as a system item.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { DEFAULT_WAIT_MS, EdenClient, edenId, withContext } from "@eden/client";
import { keylessOriginAllowed, MAX_TEXT_CHARS, type Injection } from "@eden/protocol";
import {
  ASK_LOOP_MS,
  MAX_ASK_ROUNDS,
  MAX_ASKS_PER_ROUND,
  NO_CONTEXT,
  conversationOf,
  readRound,
  withAskTool,
  type AskRouteName,
} from "./ask";
import { withMessages } from "./with-messages";

export { withMessages };

export interface ProxyOptions {
  /** The model's OpenAI-compatible base URL, with its version path (`https://api.openai.com/v1`). */
  upstream: string;
  /** Eden's HTTP API. */
  edenUrl: string;
  edenApiKey?: string;
  /** How long a user message's observe may wait for Eden's lookup (ms); the client's default, 3,000. */
  waitMs?: number;
  /**
   * A secret callers must send as `x-eden-proxy-key`. The proxy holds the tenant's Eden key and trusts the user id a
   * caller names, so anything beyond this machine must not reach it without one (`main.ts` refuses to start so).
   */
  proxyKey?: string;
  /** Conversations remembered (which messages were reported, the turn's packets); least recent dropped. */
  maxSessions?: number;
  /**
   * Shadow mode: report events and let Eden decide, but forward every request unchanged. A trial with no risk to the
   * agent's answers: what Eden would have added is in its traces (`/v1/explain`, `bun run trace-report`) and in
   * `onShadow`'s counts.
   */
  shadow?: boolean;
  /**
   * Keep every packet the agent was shown where it was shown, on every later request of the conversation, as an agent
   * that stored it in its transcript would (default on, D336). Off, only the current turn's packets are inserted:
   * each new turn's request then no longer starts with the previous one, so a provider whose cache entries end at its
   * breakpoints (Anthropic's) writes the history again (+$0.057 per 1,000 tasks over a user's days on Pi), and an item
   * Eden showed earlier in the session, which it does not send twice, is gone from the agent's view
   * (docs/research/a16-loop.md). Held per conversation up to `maxKeptBytes`.
   */
  keepPackets?: boolean;
  /**
   * `keepPackets`: the most packet text (UTF-8 bytes) kept per conversation, 64,000 by default. Past it the placements
   * whose user message is no longer in the request go first, then the oldest; about 640 MB over the default 10,000
   * conversations at most (`maxSessions` lowers it).
   */
  maxKeptBytes?: number;
  /**
   * On by default (F10, D1273, promoted by the integrator; `false` or `EDEN_PROXY_SPECULATE=0` turns it off): at a
   * new turn, send the request upstream at once, shaped as it would go if Eden had nothing new for the turn, while Eden
   * works; hold its answer. When Eden's work lands and the request
   * that would go upstream is byte for byte the speculative one, the held answer goes to the agent (Eden's wait is
   * saved); otherwise the speculative call is aborted and the request goes as today. The agent sees exactly what it
   * would without the option. An aborted call is paid for: its input, and any output the provider wrote or bills after
   * the abort (a non-streamed request may be finished and billed anyway). A 429 or 5xx on the early call is not passed
   * on (the request goes again as today). Chat and Anthropic routes only: not the Responses route, not with
   * `askTool`, in shadow mode or with `store: true` (F7 §9's design, docs/research/f10-rule-index.md §9).
   */
  speculate?: boolean;
  /**
   * Opt-in (D851, D857; `EDEN_PROXY_ASK=1`): add Eden's `ask_context` to each request's tools and answer the model's
   * calls to it in the proxy (`ask.ts`), so a proxy user gets the tool D70 measured at +11.9 points on the SDK. Not
   * measured through the proxy. Never in shadow mode.
   */
  askTool?: boolean;
  /** In shadow mode, per request Eden would have changed: the user, session and the packets' item ids (no text). */
  onShadow?: (record: { userId: string; sessionId: string; packets: number; itemIds: string[] }) => void;
  fetch?: typeof fetch;
  onError?: (error: unknown) => void;
}

interface Message {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
}

interface Conversation {
  /**
   * What was already reported, by content: per message hash, how many copies of it were seen in one request. A
   * message is new when the request holds more copies of it than were seen, so a history that is compacted or slides
   * (old messages dropped, a summary added) still reports its new messages, and never an old one again.
   */
  seen: Map<string, number>;
  /** Bumped by every request with a new user message; Eden's answers for an older turn are dropped. */
  turn: number;
  /** The packets Eden gave in the current turn, re-inserted on every call of the turn. */
  packets: Injection[];
  /** The last request's messages, as one hash: the same messages again are a retry, not a new turn. */
  last?: string;
  /**
   * `keepPackets` (D336): the packet text placed before each user message, by `userKeys`' key, with the turn that
   * placed it; and the texts' total UTF-8 bytes. Oldest placement first.
   */
  placed?: Map<string, { text: string; turn: number; bytes: number }>;
  placedBytes?: number;
  /** With the history held by the provider: ids of the packets already sent upstream, each inserted once. */
  sent?: Set<string>;
}

const MAX_KEPT_BYTES = 64_000;

/**
 * Each user message's key for `Conversation.placed`: its hash with the hash of the message before it (system and
 * developer messages left out), and which copy of that pair this is in the request. Anchored on its neighbour, a
 * placement keeps to its own message when a window slides or a history is compacted ahead of it, where a copy number
 * alone shifted ("yes" in turn 4 took turn 2's packet once turn 2's "yes" slid out; the review).
 */
function userKeys(messages: readonly Message[]): (string | null)[] {
  const copies = new Map<string, number>();
  let before = "start";
  return messages.map((m) => {
    if (m.role === "system" || m.role === "developer") return null;
    const h = hashOf(m);
    const anchor = before;
    before = h;
    if (m.role !== "user") return null;
    const pair = `${anchor}>${h}`;
    const k = (copies.get(pair) ?? 0) + 1;
    copies.set(pair, k);
    return `${pair}#${k}`;
  });
}

/** Message hashes kept per conversation; the oldest go first (their messages may then be reported again). */
const MAX_SEEN = 2_000;
/** Beyond the observe's wait: the most Eden's work may add to a request before it goes upstream regardless (ms). */
const EDEN_SLACK_MS = 800;

const HOP_BY_HOP = [
  "host",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
];
const DROP_FROM_UPSTREAM = ["content-encoding", "content-length", "transfer-encoding", "connection"];

/** The text of an OpenAI message's content (a string, or text parts); images and other parts are left out. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) =>
      p && typeof p === "object" && (p as { type?: unknown }).type === "text" ? (p as { text?: unknown }).text : "",
    )
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join("\n");
}

/**
 * Text cut to what Eden's API takes: past it the event was refused whole (a 400 the client swallows), so a large file
 * read reached Eden as nothing; the engine reads only a text's head anyway (audit A11). No lone high surrogate is left.
 */
function capped(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  const cut = text.slice(0, MAX_TEXT_CHARS);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * A tool call's input as Eden's API takes it: past `MAX_TEXT_CHARS` of JSON the event was refused whole, as long text
 * was (a write of a large file); such input goes as the head of its arguments' text, cut until its JSON fits (escapes
 * can make it longer than the text). The engine reads only an input's head (the review of audit A11).
 */
function cappedInput(input: unknown, args: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(input) ?? "";
  } catch {
    return {};
  }
  if (json.length <= MAX_TEXT_CHARS) return input;
  let text = capped(typeof args === "string" ? args : json);
  while (text.length > 0 && JSON.stringify(text).length > MAX_TEXT_CHARS) {
    text = text.slice(0, Math.floor(text.length * 0.9)).replace(/[\uD800-\uDBFF]$/, "");
  }
  return text;
}

/** A message's identity for "already reported": role, text, tool call ids and calls. */
function hashOf(m: Message): string {
  const calls = Array.isArray(m.tool_calls) ? JSON.stringify(m.tool_calls) : "";
  const id = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
  return createHash("sha256")
    .update(`${String(m.role)}\u0000${textOf(m.content)}\u0000${id}\u0000${calls}`)
    .digest("hex");
}

type EventInput = Parameters<EdenClient["observe"]>[0];

/**
 * Whether a request asks the provider to run tools on its side (D1273's review): remote MCP servers (`mcp_servers`),
 * chat's web search (`web_search_options`), a code-execution `container`, or any tool typed other than a client tool
 * (`function` on chat, `custom` or untyped on Anthropic: `web_search_*`, `web_fetch_*`, `code_execution_*`, and the
 * computer-use tools too, to be safe). `speculate` never sends such a request early: the provider would run its tools
 * (which may write, and are billed per use) for the early call and again for the packet's request.
 */
export function providerRunsTools(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.mcp_servers !== undefined || b.web_search_options !== undefined || b.container !== undefined) return true;
  const tools = Array.isArray(b.tools) ? (b.tools as unknown[]) : [];
  return tools.some((t) => {
    const type = t && typeof t === "object" ? (t as { type?: unknown }).type : undefined;
    return type !== undefined && type !== "function" && type !== "custom";
  });
}

/** Eden events for one message; `tools` maps a tool call id to its tool's name, for the results that follow. */
export function eventsOf(m: Message, tools: Map<string, string>): EventInput[] {
  const text = capped(textOf(m.content));
  if (m.role === "user") return text ? [{ kind: "user_message", text }] : [];
  if (m.role === "assistant") {
    const out: EventInput[] = text ? [{ kind: "agent_message", text }] : [];
    for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      const fn = (call as { function?: { name?: unknown; arguments?: unknown } })?.function;
      if (typeof fn?.name !== "string") continue;
      const id = (call as { id?: unknown }).id;
      if (typeof id === "string") tools.set(id, fn.name);
      let input: unknown = fn.arguments;
      try {
        if (typeof input === "string") input = JSON.parse(input);
      } catch {
        // Arguments that are not JSON go as their text.
      }
      out.push({ kind: "tool_call", tool: fn.name, input: cappedInput(input ?? {}, fn.arguments) });
    }
    return out;
  }
  if (m.role === "tool" || m.role === "function") {
    const id = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
    const tool = tools.get(id) ?? (typeof m.name === "string" ? m.name : "tool");
    return text ? [{ kind: "tool_result", tool, output: text }] : [];
  }
  return [];
}

export function createProxy(options: ProxyOptions): (req: Request) => Promise<Response> {
  const upstream = options.upstream.replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const maxSessions = options.maxSessions ?? 10_000;
  const keepPackets = options.keepPackets ?? true;
  const conversations = new Map<string, Conversation>();
  /** The client `withEden` made for a request whose user it identified, for the ask rounds (`askTool`). */
  const clients = new WeakMap<Request, EdenClient>();
  let warnedNoUser = false;
  const report = (e: unknown) => {
    try {
      options.onError?.(e);
    } catch {
      // A broken logger never breaks the agent's call.
    }
  };

  const forward = (
    req: Request,
    path: string,
    body: string | ArrayBuffer | null,
    signal: AbortSignal = req.signal,
  ): Promise<Response> => {
    const headers = new Headers(req.headers);
    // Headers the client's own Connection header names are for this hop only, like the fixed list.
    for (const h of (req.headers.get("connection") ?? "").split(",")) if (h.trim()) headers.delete(h.trim());
    for (const h of HOP_BY_HOP) headers.delete(h);
    for (const h of [...headers.keys()]) if (h.startsWith("x-eden-")) headers.delete(h);
    // The caller's signal: an agent that hangs up cancels the model call, which would otherwise run (and be billed) to
    // the end for an answer nobody reads (audit A11).
    return doFetch(`${upstream}${path}`, { method: req.method, headers, body, signal }).then((res) => {
      const out = new Headers(res.headers);
      for (const h of DROP_FROM_UPSTREAM) out.delete(h);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
    });
  };

  /** The request's messages with Eden's context in place, or null when Eden has nothing or cannot be used. */
  const withEden = async (
    req: Request,
    body: Record<string, unknown>,
    anthropic = false,
    /** The provider's own id for the conversation (the Responses API's `conversation`), when the caller sent no id. */
    conversation?: string,
    /**
     * Set when the provider holds the history (the Responses API's `previous_response_id`, else its `conversation`):
     * the request is only what is new, and what an earlier request inserted is already in that history. The value is
     * what the input follows, folded into the retry check: "yes" after a different response is a new turn.
     */
    held?: string,
    /**
     * `speculate` (F10): called once, before Eden's wait at a new turn, with the messages as they would go if the turn
     * got no packet (null: as the caller sent them).
     */
    onSpeculate?: (placed: Message[] | null) => void,
  ): Promise<Message[] | null> => {
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) return null;
    // The caller's header, else the body's user: `user` on the chat route, `metadata.user_id` on Anthropic's (each
    // route reads only its own field: a chat body's free-form `metadata` names nobody).
    const field = anthropic ? (body.metadata as { user_id?: unknown } | null | undefined)?.user_id : body.user;
    const named = typeof field === "string" ? field : "";
    const rawUser = req.headers.get("x-eden-user-id") ?? named;
    if (!rawUser) {
      // Once per proxy, through onError: otherwise a caller that forgot the header saw the agent work with no packet
      // and no word anywhere of why (D365). No content: the line names the header, not the request.
      if (!warnedNoUser) {
        warnedNoUser = true;
        report(
          new Error(
            "eden proxy: a chat request named no user (send x-eden-user-id, or the body's user or" +
              " metadata.user_id); it went upstream" +
              " without Eden's context, and later ones will too (said once)",
          ),
        );
      }
      return null;
    }
    const userId = edenId(rawUser);
    // The conversation: the caller's id, else its first message that is not a system prompt (a system prompt may
    // carry today's date and change every request), stable as the conversation grows.
    const rawSession = req.headers.get("x-eden-session-id");
    const first = (messages as Message[]).find((m) => m.role !== "system" && m.role !== "developer");
    const opening = first ? `${String(first.role)}:${textOf(first.content)}` : "";
    const sessionId = rawSession
      ? edenId(rawSession)
      : conversation
        ? edenId(conversation)
        : `c:${createHash("sha256").update(opening).digest("hex").slice(0, 32)}`;
    const key = `${userId}#${sessionId}`;
    const known = conversations.get(key);
    const conv: Conversation = known ?? { seen: new Map(), turn: 0, packets: [] };
    conversations.delete(key);
    conversations.set(key, conv);
    if (conversations.size > maxSessions) conversations.delete(conversations.keys().next().value!);

    // Which messages are new, by content (see `Conversation.seen`). On first sight of a conversation (a restart, an
    // eviction) only the latest user message and what follows it are reported: a long history is not replayed.
    const tools = new Map<string, string>();
    const copies = new Map<string, number>();
    const fresh: Message[] = [];
    const lastUserAt = (messages as Message[]).map((m) => m.role).lastIndexOf("user");
    for (const [i, m] of (messages as Message[]).entries()) {
      eventsOf(m, tools); // tool names, for the results that follow
      const h = hashOf(m);
      const k = (copies.get(h) ?? 0) + 1;
      copies.set(h, k);
      if (k > (conv.seen.get(h) ?? 0)) {
        conv.seen.delete(h);
        conv.seen.set(h, k);
        if (known || i >= lastUserAt) fresh.push(m);
      }
    }
    while (conv.seen.size > MAX_SEEN) conv.seen.delete(conv.seen.keys().next().value!);
    // A request that ends with a user message already seen ("yes", "continue" again, from an agent that sends only
    // its latest turn or whose window slid past the first copy) is still a new turn unless it repeats the last
    // request's messages exactly (a retry): counting copies alone dropped it, and re-inserted the previous turn's
    // packets into it (audit A5).
    // System and developer messages left out, as from the conversation's key: one carrying today's date changes every
    // request, and a retry would then read as a new turn and lose its packets (the review).
    // With the history held by the provider the request is only the new input, so a short reply repeated on the
    // next turn would hash the same as a retry: the response it follows tells them apart (the review of D656).
    const all = createHash("sha256")
      .update(held === undefined ? "" : `held:${held}\n`)
      .update(
        (messages as Message[])
          .filter((m) => m.role !== "system" && m.role !== "developer")
          .map(hashOf)
          .join(","),
      )
      .digest("hex");
    const end = (messages as Message[]).at(-1)!;
    if (known && end.role === "user" && fresh.at(-1) !== end && conv.last !== undefined && conv.last !== all) {
      fresh.push(end);
    }
    conv.last = all;
    const lastUser = fresh.map((m) => m.role).lastIndexOf("user");
    if (lastUser >= 0) {
      conv.turn++;
      conv.packets = [];
    }
    const turn = conv.turn;
    const eden = new EdenClient({
      baseUrl: options.edenUrl,
      ...(options.edenApiKey ? { apiKey: options.edenApiKey } : {}),
      userId,
      sessionId,
      onError: report,
      // Shadow: Eden decides as it would, and learns nothing from packets the agent never sees (audit A5).
      ...(options.shadow ? { shadow: true } : {}),
      ...(options.waitMs !== undefined ? { defaultWaitMs: options.waitMs } : {}),
    });
    clients.set(req, eden);
    const keep = (got: Injection[]) => {
      // A newer turn started meanwhile (a concurrent request): this turn's packets are not carried into it.
      if (conv.turn !== turn) return;
      const ids = new Set(conv.packets.map((p) => p.id));
      for (const p of got) if (!ids.has(p.id)) conv.packets.push(p);
    };
    const work = (async () => {
      const tool = new Map(tools);
      for (const [i, m] of fresh.entries()) {
        for (const ev of eventsOf(m, tool)) {
          // Only the latest user message waits for its lookup; the others are reported without a wait.
          const waiting = ev.kind === "user_message" && i === lastUser;
          const { injection } = await eden.observe(ev, waiting ? {} : { waitMs: 0 });
          if (injection) keep([injection]);
        }
      }
      keep(await eden.pending());
    })().catch(report);
    // One deadline for all of Eden's work in this request: past it the request goes upstream with what is in hand,
    // and what lands later stays for the turn's next model call (D14: a slow Eden never holds the agent long).
    if (onSpeculate && lastUser >= 0 && held === undefined && !options.shadow) {
      // With no packet for this turn: earlier turns' packets in place (`keptInPlace` with none changes nothing).
      try {
        onSpeculate(
          keepPackets && conv.placed?.size
            ? keptInPlace(conv, messages as Message[], [], turn, options.maxKeptBytes ?? MAX_KEPT_BYTES)
            : null,
        );
      } catch (e) {
        report(e);
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = (options.waitMs ?? DEFAULT_WAIT_MS) + EDEN_SLACK_MS;
    await Promise.race([work, new Promise((r) => (timer = setTimeout(r, budget)))]);
    clearTimeout(timer);
    // A newer turn started while this request waited: the packets in hand are that turn's, not this one's (the
    // review: kept in place they would have been stored under this request's message for good).
    const packets = conv.turn === turn ? [...conv.packets] : [];
    // `keepPackets`: earlier turns' packets go back in place even when this turn has none.
    if (packets.length === 0 && !(keepPackets && conv.placed?.size && !options.shadow)) return null;
    if (options.shadow) {
      const itemIds = packets.flatMap((p) => p.citations.map((c) => c.itemId));
      try {
        options.onShadow?.({ userId, sessionId, packets: packets.length, itemIds });
      } catch {
        // A broken sink never breaks the agent's call.
      }
      return null;
    }
    if (held !== undefined) {
      // Each packet goes upstream once: re-inserted on the turn's later calls (tool outputs), it would be stored
      // again by the provider every time (the review of D656). Nothing is kept in place: the provider keeps it.
      const sent = (conv.sent ??= new Set());
      const fresh = packets.filter((p) => !sent.has(p.id));
      if (fresh.length === 0) return null;
      for (const p of fresh) sent.add(p.id);
      while (sent.size > MAX_SEEN) sent.delete(sent.values().next().value!);
      return withContext(messages as { role: string; content: unknown }[], fresh);
    }
    if (keepPackets) {
      return keptInPlace(conv, messages as Message[], packets, turn, options.maxKeptBytes ?? MAX_KEPT_BYTES);
    }
    return withContext(messages as { role: string; content: unknown }[], packets);
  };

  /**
   * `askTool` (D851): the request with `ask_context` added goes upstream; each answer that calls it is answered here
   * from Eden and the model called again with the round appended. The first answer that does not ask goes to the agent
   * byte for byte. Anything else falls back to the request as the agent sent it (`original`, no tool), so the agent
   * gets what it would have had with the trial off: an upstream error on a later round (the rewrite may be what the
   * provider refused), a round that cannot be read or rewritten, and an answer that still asks after
   * `MAX_ASK_ROUNDS` rounds. The agent is never handed a call to a tool it does not know (D14).
   */
  const askRounds = async (
    req: Request,
    path: string,
    raw: string,
    original: string,
    route: AskRouteName,
    eden: EdenClient,
  ): Promise<Response> => {
    const deadline = Date.now() + ASK_LOOP_MS;
    const fallback = (why: string) => {
      // The reason only (a round number, a status): never the request or an answer.
      report(new Error(`eden proxy: ask_context ${why}; the request went upstream without the tool`));
      return forward(req, path, original);
    };
    let current = raw;
    for (let round = 0; ; round++) {
      const res = await forward(req, path, current);
      if (!res.ok) {
        // Round 0 is the agent's request with the tool added, so a refusal of its shape may be the trial's doing (a
        // model with no tool support): the agent's own request goes instead. An auth, rate or server error is the
        // upstream's answer to any request and goes to the agent as it came.
        const own = round === 0 && (res.status >= 500 || [401, 403, 429].includes(res.status));
        return own ? res : fallback(`round ${round} answered ${res.status}`);
      }
      const streamed = (res.headers.get("content-type") ?? "").includes("text/event-stream");
      let bytes: ArrayBuffer;
      try {
        bytes = await res.arrayBuffer();
      } catch {
        // The answer broke off mid-read (a reset): the agent's own request instead (a caller gone aborts it: 499).
        return fallback(`round ${round} could not be read`);
      }
      const asked = readRound(route, new TextDecoder().decode(bytes), streamed);
      if (!asked) return new Response(bytes, { status: res.status, statusText: res.statusText, headers: res.headers });
      if (round === MAX_ASK_ROUNDS) return fallback(`still asking after ${MAX_ASK_ROUNDS} rounds`);
      try {
        // At most `MAX_ASKS_PER_ROUND` asks a round and one deadline for all of them; none once the caller has gone.
        const answers = await Promise.all(
          asked.asks.map(async (a, i) => {
            if (i >= MAX_ASKS_PER_ROUND) return NO_CONTEXT;
            if (!a.question) return "ask_context needs a question.";
            const left = deadline - Date.now();
            if (left <= 0 || req.signal.aborted) return NO_CONTEXT;
            return (await eden.ask(a.question, { timeoutMs: left }))?.answer ?? NO_CONTEXT;
          }),
        );
        const conv = conversationOf(route, JSON.parse(current) as Record<string, unknown>);
        const next = withMessages(current, [...conv.items, ...asked.append(answers)], conv.key);
        if (next === null) return fallback(`round ${round} could not be rewritten`);
        current = next;
      } catch (e) {
        report(e);
        return fallback(`round ${round} failed`);
      }
    }
  };

  const openAiError = (status: number, message: string) => Response.json({ error: { message } }, { status });
  /** An error in the shape the route's SDK parses: Anthropic's for `…/messages`, OpenAI's otherwise. */
  const errorFor = (anthropic: boolean) => (status: number, message: string) =>
    anthropic
      ? Response.json({ type: "error", error: { type: ANTHROPIC_ERRORS[status] ?? "api_error", message } }, { status })
      : openAiError(status, message);

  return async function handle(req: Request): Promise<Response> {
    // The proxy's own liveness, for a load balancer or a container check (D365): before the key checks, since it says
    // nothing about any user, and answered here rather than forwarded (the upstream has no such route).
    if ((req.method === "GET" || req.method === "HEAD") && new URL(req.url).pathname === "/healthz") {
      return Response.json({ ok: true });
    }
    const url = new URL(req.url);
    // Two routes carry a conversation: OpenAI's chat completions and Anthropic's Messages (D653). The rest (models,
    // embeddings, Anthropic's token counting and batches) are forwarded as they came.
    // Matched whole: another API's `…/threads/{id}/messages` is not this route and is forwarded as bytes.
    const anthropic = req.method === "POST" && /^(\/v1)?\/messages$/.test(url.pathname);
    const fail = errorFor(anthropic);
    // OpenAI's Responses API (D656): the conversation is the body's `input`.
    const responses = req.method === "POST" && /^(\/v1)?\/responses$/.test(url.pathname);
    // The proxy holds the tenant's Eden key: with `proxyKey` set, only callers who know it may name a user (D9).
    if (options.proxyKey !== undefined && !sameSecret(req.headers.get("x-eden-proxy-key"), options.proxyKey)) {
      return fail(401, "eden proxy: missing or wrong x-eden-proxy-key");
    }
    // With no key, whoever reaches the proxy names a user: a page on another site reaches 127.0.0.1 too (a blind
    // cross-site POST, or DNS rebinding to read the answer), so a browser request from another origin is refused.
    if (options.proxyKey === undefined && !keylessOriginAllowed(req.headers.get("origin"))) {
      return fail(403, "eden proxy: no key-less request from another site's page (set EDEN_PROXY_KEY)");
    }
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, "") + url.search;
    if (req.method !== "POST" || !(anthropic || responses || url.pathname.endsWith("/chat/completions"))) {
      try {
        return await forward(req, path, req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer());
      } catch (e) {
        report(e);
        return fail(502, "eden proxy: upstream unreachable");
      }
    }
    let raw: string;
    try {
      raw = await req.text();
    } catch {
      return fail(400, "eden proxy: the request body could not be read");
    }
    let sent = raw;
    let body: unknown = null;
    // `speculate` (F10): the request sent before Eden's wait, its held answer, and the way to abort it.
    let spec: { sent: string; res: Promise<Response>; abort: AbortController } | null = null;
    const speculating = (options.speculate ?? true) && !options.askTool && !options.shadow;
    const startSpec = (bodyText: string) => {
      // Not with a provider-stored completion (`store: true`): an aborted call could leave a stored copy there. Not
      // when the provider runs tools itself (`providerRunsTools`): the early call would run them, and the packet's
      // request again.
      if (!speculating || spec || req.signal.aborted) return;
      if ((body as { store?: unknown } | null)?.store === true || providerRunsTools(body)) return;
      const abort = new AbortController();
      req.signal.addEventListener("abort", () => abort.abort(), { once: true });
      const res = forward(req, path, bodyText, abort.signal);
      // A failed speculative call is replaced by the ordinary one below; never an unhandled rejection.
      res.catch(() => undefined);
      spec = { sent: bodyText, res, abort };
    };
    try {
      body = JSON.parse(raw);
    } catch {
      // Not JSON: the upstream answers it as it would (never logged here: the error could quote the body).
    }
    try {
      if (body && typeof body === "object" && !Array.isArray(body)) {
        let messages: unknown[] | null;
        if (anthropic) {
          // The same work on the conversation read as chat messages; the context then goes back in as a text block.
          const theirs = (body as { messages?: unknown }).messages;
          const view = Array.isArray(theirs) ? fromAnthropic(theirs) : null;
          const render = (placed: Message[] | null) => {
            const out = placed ? toAnthropic(theirs as unknown[], view!, placed) : null;
            return out
              ? (withMessages(raw, out, "messages") ?? JSON.stringify({ ...(body as object), messages: out }))
              : raw;
          };
          const placed =
            view &&
            (await withEden(req, { ...(body as object), messages: view.messages }, true, undefined, undefined, (p) =>
              startSpec(render(p)),
            ));
          messages = placed ? toAnthropic(theirs as unknown[], view!, placed) : null;
        } else if (responses) {
          const view = fromResponses((body as { input?: unknown }).input);
          // With the history held by the provider (`conversation`, `previous_response_id`) the input is only what is
          // new: `conversation` then names the session; with `previous_response_id` alone send `x-eden-session-id`.
          const conv = (body as { conversation?: unknown }).conversation;
          const named = typeof conv === "string" ? conv : (conv as { id?: unknown } | null)?.id;
          const previous = (body as { previous_response_id?: unknown }).previous_response_id;
          // What the input follows: the previous response when named (each turn names a new one), else the
          // conversation (one id for all its turns: there a repeated reply and a retry still look the same).
          const held =
            previous != null
              ? `response:${String(previous)}`
              : conv !== undefined
                ? `conversation:${typeof named === "string" ? named : JSON.stringify(conv)}`
                : undefined;
          const placed =
            view &&
            (await withEden(
              req,
              { ...(body as object), messages: view.messages },
              false,
              typeof named === "string" && named ? named : undefined,
              held,
            ));
          messages = placed ? toResponses(view!, placed) : null;
        } else
          messages = await withEden(req, body as Record<string, unknown>, false, undefined, undefined, (p) =>
            startSpec(
              p ? (withMessages(raw, p, "messages") ?? JSON.stringify({ ...(body as object), messages: p })) : raw,
            ),
          );
        const key = responses ? "input" : "messages";
        if (messages)
          sent = withMessages(raw, messages, key) ?? JSON.stringify({ ...(body as object), [key]: messages });
      }
    } catch (e) {
      // Anything Eden-side that threw: the request goes upstream as it came (D14).
      report(e);
    }
    // The agent hung up during Eden's wait: nobody reads the answer, so the model is not called (audit A11).
    if (req.signal.aborted) return fail(499, "eden proxy: the caller closed the request");
    // `askTool` (D851): only for a request whose user was identified, and never in shadow mode (nothing changes).
    const eden = options.askTool && !options.shadow ? clients.get(req) : undefined;
    const route: AskRouteName = anthropic ? "anthropic" : responses ? "responses" : "chat";
    let asking: string | null = null;
    // Not on a Responses request whose history the provider holds or does not store (`previous_response_id`,
    // `conversation`, `store: false`): a round would have to chain response ids, and re-sent items are refused there
    // (the review of D851). Such a request goes as it would without the option.
    const held =
      responses &&
      ["previous_response_id", "conversation"].some((k) => (body as Record<string, unknown> | null)?.[k] != null);
    const unstored = responses && (body as Record<string, unknown> | null)?.store === false;
    if (eden && !held && !unstored && body && typeof body === "object" && !Array.isArray(body)) {
      try {
        asking = withAskTool(sent, body as Record<string, unknown>, route);
      } catch (e) {
        report(e);
      }
    }
    const held_ = spec as { sent: string; res: Promise<Response>; abort: AbortController } | null;
    if (held_) {
      if (held_.sent === sent && !req.signal.aborted) {
        // Eden added nothing new for the turn: the answer already on its way is exactly the one the agent would get.
        // A rate limit or a server error on that early call is not passed on: the request goes again as it would have
        // gone without the option (the review: an early 429 must not become the agent's answer).
        try {
          const res = await held_.res;
          if (res.status !== 429 && res.status < 500) return res;
          held_.abort.abort();
        } catch (e) {
          if (req.signal.aborted) return fail(499, "eden proxy: the caller closed the request");
          report(e);
        }
      } else held_.abort.abort();
    }
    try {
      if (eden && asking !== null) return await askRounds(req, path, asking, sent, route, eden);
      return await forward(req, path, sent);
    } catch (e) {
      if (req.signal.aborted) return fail(499, "eden proxy: the caller closed the request");
      report(e);
      return fail(502, "eden proxy: upstream unreachable");
    }
  };
}

/** Compares a caller's secret in time independent of where it first differs (digests: equal lengths). */
function sameSecret(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** The text of a Responses content value: a string, or its `input_text`, `output_text` and `text` parts. */
function responsesText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      const part = p as { type?: unknown; text?: unknown } | null;
      const kind = part?.type;
      return kind === "input_text" || kind === "output_text" || kind === "text" ? part!.text : "";
    })
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join("\n");
}

/**
 * A Responses API `input` read as chat messages (D656), one per item, so the same code decides what is new and where
 * packets go: a message item is its role and text; a `function_call` is an assistant message with that call; a
 * `function_call_output` is a tool message. Any other item (reasoning, a reference, a built-in tool's call) is kept
 * in place as a message of no known role, which is neither reported nor a turn. A string input is one user message.
 * Null when `input` is neither.
 */
export function fromResponses(
  input: unknown,
): { messages: Message[]; at: Map<Message, number>; items: unknown[] } | null {
  const items = typeof input === "string" ? [{ role: "user", content: input }] : Array.isArray(input) ? input : null;
  if (items === null) return null;
  const messages: Message[] = [];
  const at = new Map<Message, number>();
  for (const [i, raw] of items.entries()) {
    const it = (raw ?? {}) as Record<string, unknown>;
    let m: Message;
    if (it.type === "function_call" || it.type === "custom_tool_call") {
      // A custom tool's `input` is free text where a function's `arguments` is JSON; both are the caller's tools.
      const args = it.type === "function_call" ? it.arguments : it.input;
      const call = { id: it.call_id, type: "function", function: { name: it.name, arguments: args } };
      m = { role: "assistant", content: "", tool_calls: [call] };
    } else if (it.type === "function_call_output" || it.type === "custom_tool_call_output") {
      m = { role: "tool", tool_call_id: it.call_id, content: responsesText(it.output) };
    } else if ((it.type === undefined || it.type === "message") && typeof it.role === "string") {
      m = { role: it.role, content: responsesText(it.content) };
    } else m = { role: "item", content: "" };
    messages.push(m);
    at.set(m, i);
  }
  return { messages, at, items };
}

/**
 * The Responses `input` with the context `withEden` placed (D656): each packet is a system message item where the
 * chat route puts its system message (the API takes system items inside `input`); every other item is the caller's
 * own object, in order.
 */
export function toResponses(
  view: { at: Map<Message, number>; items: readonly unknown[] },
  placed: readonly Message[],
): unknown[] {
  return placed.map((m) => {
    const i = view.at.get(m);
    return i === undefined ? { role: "system", content: m.content } : view.items[i];
  });
}

/** Anthropic's error types by status, for the errors the proxy itself answers on `…/messages`. */
const ANTHROPIC_ERRORS: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
};

/**
 * An Anthropic Messages conversation read as chat messages (D653), so the one implementation of what is new, what
 * is reported and where packets are kept serves both routes. Per Anthropic message, in order:
 *
 * - a user message's `tool_result` blocks become `tool` messages (their `tool_use_id` the call's id). A message with
 *   tool results is the agent's loop, not the user speaking: text beside them (a harness's reminder, a "continue")
 *   is not reported and starts no turn, or every tool call would wait on a lookup of the harness's words;
 * - any other user message is one `user` message of its text blocks;
 * - an assistant message's text blocks become its content and its `tool_use` blocks its `tool_calls`.
 *
 * Thinking, images and documents are left out, as `textOf` leaves non-text parts out. `at` maps each chat message to
 * the index of the Anthropic message it came from.
 */
export function fromAnthropic(messages: readonly unknown[]): { messages: Message[]; at: Map<Message, number> } {
  const out: Message[] = [];
  const at = new Map<Message, number>();
  const add = (m: Message, i: number) => {
    out.push(m);
    at.set(m, i);
  };
  for (const [i, raw] of messages.entries()) {
    const m = (raw ?? {}) as { role?: unknown; content?: unknown };
    const blocks = Array.isArray(m.content) ? (m.content as { type?: unknown }[]) : null;
    if (m.role === "assistant") {
      const calls = (blocks ?? [])
        .filter((b) => b?.type === "tool_use")
        .map((b) => {
          const use = b as { id?: unknown; name?: unknown; input?: unknown };
          return {
            id: use.id,
            type: "function",
            function: { name: use.name, arguments: JSON.stringify(use.input ?? {}) },
          };
        });
      add({ role: "assistant", content: textOf(m.content), ...(calls.length ? { tool_calls: calls } : {}) }, i);
      continue;
    }
    if (m.role !== "user") {
      add({ role: m.role, content: textOf(m.content) }, i);
      continue;
    }
    let results = 0;
    for (const b of blocks ?? []) {
      if (b?.type !== "tool_result") continue;
      const r = b as { tool_use_id?: unknown; content?: unknown };
      add({ role: "tool", tool_call_id: r.tool_use_id, content: textOf(r.content) }, i);
      results++;
    }
    // Anything without tool results is a user turn (an image alone too: a turn with no text).
    if (results === 0) add({ role: "user", content: textOf(m.content) }, i);
  }
  return { messages: out, at };
}

/**
 * The Anthropic messages with the context `withEden` placed (D653). A packet placed before a user turn becomes a
 * text block of that Anthropic message, ahead of its other blocks and after any leading tool results (the API wants
 * a user message's `tool_result` blocks first); a message whose content is a string becomes two blocks. The API has
 * no system role inside `messages`, and a text block keeps the request a prefix of the next as the system message
 * does for chat completions. Packets with no user turn after them (a request with none) go into the last message
 * when it is the user's; otherwise nothing is inserted (null): an assistant prefill is not followed by Eden's text.
 */
export function toAnthropic(
  original: readonly unknown[],
  view: { at: Map<Message, number> },
  placed: readonly Message[],
): unknown[] | null {
  const out = [...original];
  const insert = (i: number, text: string): boolean => {
    const m = out[i] as { content?: unknown };
    const block = { type: "text", text };
    // Content that is neither text nor blocks is the upstream's to refuse: replacing it would hide the caller's error.
    if (!m || (typeof m.content !== "string" && !Array.isArray(m.content))) return false;
    if (!Array.isArray(m.content)) {
      const own = typeof m.content === "string" && m.content.length > 0 ? [{ type: "text", text: m.content }] : [];
      out[i] = { ...m, content: [block, ...own] };
      return true;
    }
    const blocks = m.content as { type?: unknown }[];
    let k = 0;
    while (k < blocks.length && blocks[k]?.type === "tool_result") k++;
    out[i] = { ...m, content: [...blocks.slice(0, k), block, ...blocks.slice(k)] };
    return true;
  };
  let waiting: string[] = [];
  let inserted = false;
  for (const m of placed) {
    const i = view.at.get(m);
    if (i === undefined) {
      if (typeof m.content === "string" && m.content) waiting.push(m.content);
      continue;
    }
    if (waiting.length === 0 || m.role !== "user") continue;
    if (insert(i, waiting.join("\n\n"))) inserted = true;
    waiting = [];
  }
  if (waiting.length > 0) {
    const last = original.length - 1;
    if ((original[last] as { role?: unknown } | undefined)?.role !== "user") return inserted ? out : null;
    if (insert(last, waiting.join("\n\n"))) inserted = true;
  }
  return inserted ? out : null;
}

/**
 * `keepPackets` (D336, the default): the messages with each earlier user message preceded by the packet text placed
 * before it on an earlier request, and the latest by this turn's packets (`withContext`'s place and form), which are
 * kept for later requests. The latest message takes an earlier placement only within the turn that placed it: a new
 * turn whose words repeat an old one's ("continue" again, from an agent that sends only its latest message) gets none.
 * With no user message the packets go where `withContext` puts them, unkept. Null when nothing is inserted.
 */
function keptInPlace(
  conv: Conversation,
  messages: Message[],
  packets: Injection[],
  turn: number,
  maxBytes: number,
): Message[] | null {
  if (!messages.some((m) => m.role === "user")) {
    return packets.length ? withContext(messages as { role: string; content: unknown }[], packets) : null;
  }
  const placed = (conv.placed ??= new Map());
  const keys = userKeys(messages);
  const latest = keys.findLastIndex((k) => k !== null);
  const current = packets.length ? packets.map((p) => p.text).join("\n\n") : null;
  if (current !== null) {
    const key = keys[latest]!;
    const bytes = Buffer.byteLength(current);
    const old = placed.get(key);
    if (old) {
      placed.delete(key);
      conv.placedBytes = (conv.placedBytes ?? 0) - old.bytes;
    }
    // Over the budget, placements whose message this request no longer holds go first, then the oldest. A packet larger
    // than the whole budget is shown but neither kept nor allowed to evict the others (the review).
    const fits = bytes <= maxBytes;
    const live = new Set(keys.filter((k): k is string => k !== null));
    for (const pass of fits ? [false, true] : []) {
      for (const [k, v] of placed) {
        if ((conv.placedBytes ?? 0) + bytes <= maxBytes) break;
        if (!pass && live.has(k)) continue;
        placed.delete(k);
        conv.placedBytes = (conv.placedBytes ?? 0) - v.bytes;
      }
    }
    if ((conv.placedBytes ?? 0) + bytes <= maxBytes) {
      placed.set(key, { text: current, turn, bytes });
      conv.placedBytes = (conv.placedBytes ?? 0) + bytes;
    }
  }
  const out: Message[] = [];
  let inserted = false;
  for (const [i, m] of messages.entries()) {
    const key = keys[i];
    const kept = key ? placed.get(key) : undefined;
    const text = i === latest ? (current ?? (kept?.turn === turn ? kept.text : undefined)) : kept?.text;
    if (text) {
      out.push({ role: "system", content: text });
      inserted = true;
    }
    out.push(m);
  }
  return inserted ? out : null;
}
