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
 * SDK. Eden's `ask_context` is not added: give the agent the MCP tool for that (docs/INTEGRATION.md).
 */
import { createHash } from "node:crypto";
import { DEFAULT_WAIT_MS, EdenClient, edenId, withContext } from "@eden/client";
import type { Injection } from "@eden/protocol";

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

/** A message's identity for "already reported": role, text, tool call ids and calls. */
function hashOf(m: Message): string {
  const calls = Array.isArray(m.tool_calls) ? JSON.stringify(m.tool_calls) : "";
  const id = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
  return createHash("sha256")
    .update(`${String(m.role)}\u0000${textOf(m.content)}\u0000${id}\u0000${calls}`)
    .digest("hex");
}

type EventInput = Parameters<EdenClient["observe"]>[0];

/** Eden events for one message; `tools` maps a tool call id to its tool's name, for the results that follow. */
export function eventsOf(m: Message, tools: Map<string, string>): EventInput[] {
  const text = textOf(m.content);
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
      out.push({ kind: "tool_call", tool: fn.name, input: input ?? {} });
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
  const report = (e: unknown) => {
    try {
      options.onError?.(e);
    } catch {
      // A broken logger never breaks the agent's call.
    }
  };

  const forward = (req: Request, path: string, body: string | ArrayBuffer | null): Promise<Response> => {
    const headers = new Headers(req.headers);
    // Headers the client's own Connection header names are for this hop only, like the fixed list.
    for (const h of (req.headers.get("connection") ?? "").split(",")) if (h.trim()) headers.delete(h.trim());
    for (const h of HOP_BY_HOP) headers.delete(h);
    for (const h of [...headers.keys()]) if (h.startsWith("x-eden-")) headers.delete(h);
    return doFetch(`${upstream}${path}`, { method: req.method, headers, body }).then((res) => {
      const out = new Headers(res.headers);
      for (const h of DROP_FROM_UPSTREAM) out.delete(h);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
    });
  };

  /** The request's messages with Eden's context in place, or null when Eden has nothing or cannot be used. */
  const withEden = async (req: Request, body: Record<string, unknown>): Promise<Message[] | null> => {
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const rawUser = req.headers.get("x-eden-user-id") ?? (typeof body.user === "string" ? body.user : "");
    if (!rawUser) return null;
    const userId = edenId(rawUser);
    // The conversation: the caller's id, else its first message that is not a system prompt (a system prompt may
    // carry today's date and change every request), stable as the conversation grows.
    const rawSession = req.headers.get("x-eden-session-id");
    const first = (messages as Message[]).find((m) => m.role !== "system" && m.role !== "developer");
    const opening = first ? `${String(first.role)}:${textOf(first.content)}` : "";
    const sessionId = rawSession
      ? edenId(rawSession)
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
    const all = createHash("sha256")
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
    if (keepPackets) {
      return keptInPlace(conv, messages as Message[], packets, turn, options.maxKeptBytes ?? MAX_KEPT_BYTES);
    }
    return withContext(messages as { role: string; content: unknown }[], packets);
  };

  const openAiError = (status: number, message: string) => Response.json({ error: { message } }, { status });

  return async function handle(req: Request): Promise<Response> {
    // The proxy holds the tenant's Eden key: with `proxyKey` set, only callers who know it may name a user (D9).
    if (options.proxyKey !== undefined && req.headers.get("x-eden-proxy-key") !== options.proxyKey) {
      return openAiError(401, "eden proxy: missing or wrong x-eden-proxy-key");
    }
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, "") + url.search;
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      try {
        return await forward(req, path, req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer());
      } catch (e) {
        report(e);
        return openAiError(502, "eden proxy: upstream unreachable");
      }
    }
    let raw: string;
    try {
      raw = await req.text();
    } catch {
      return openAiError(400, "eden proxy: the request body could not be read");
    }
    let sent = raw;
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      // Not JSON: the upstream answers it as it would (never logged here: the error could quote the body).
    }
    try {
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const messages = await withEden(req, body as Record<string, unknown>);
        if (messages) sent = withMessages(raw, messages) ?? JSON.stringify({ ...(body as object), messages });
      }
    } catch (e) {
      // Anything Eden-side that threw: the request goes upstream as it came (D14).
      report(e);
    }
    try {
      return await forward(req, path, sent);
    } catch (e) {
      report(e);
      return openAiError(502, "eden proxy: upstream unreachable");
    }
  };
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
    // Over the budget, placements whose message this request no longer holds go first, then the oldest.
    const live = new Set(keys.filter((k): k is string => k !== null));
    for (const pass of [false, true]) {
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

/**
 * `raw` (a JSON object's text) with its top-level `messages` value replaced, every other byte as it came: parsing and
 * re-serialising the whole body changed fields the proxy never touches (an integer past 2^53, such as a 64-bit
 * `seed`, lost its digits; audit A5). The last `messages` key wins, as in `JSON.parse`. Null when there is none.
 */
export function withMessages(raw: string, messages: unknown): string | null {
  let depth = 0;
  let at: [number, number] | null = null;
  let i = 0;
  const skipString = (k: number): number => {
    for (k++; k < raw.length; k++) {
      if (raw[k] === "\\") k++;
      else if (raw[k] === '"') return k + 1;
    }
    return k;
  };
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '"') {
      const end = skipString(i);
      if (depth === 1 && raw.slice(i, end) === '"messages"') {
        let k = end;
        while (/\s/.test(raw[k] ?? "")) k++;
        if (raw[k] === ":") {
          k++;
          while (/\s/.test(raw[k] ?? "")) k++;
          const start = k;
          // The value: a string, or a run up to the next comma or brace at this depth.
          let d = 0;
          while (k < raw.length) {
            const v = raw[k]!;
            if (v === '"') {
              k = skipString(k);
              continue;
            }
            if (v === "[" || v === "{") d++;
            else if (v === "]" || v === "}") {
              if (d === 0) break;
              d--;
            } else if (v === "," && d === 0) break;
            k++;
          }
          let stop = k;
          while (stop > start && /\s/.test(raw[stop - 1]!)) stop--;
          at = [start, stop];
          i = k;
          continue;
        }
      }
      i = end;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  return at ? raw.slice(0, at[0]) + JSON.stringify(messages) + raw.slice(at[1]) : null;
}
