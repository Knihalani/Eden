/**
 * Eden in a LangChain agent (createAgent middleware): every integration obligation in docs/INTEGRATION.md from one
 * middleware.
 *
 *   const eden = new EdenClient({ apiKey, userId: edenId(user.id), sessionId: edenId(chat.id) });
 *   const agent = createAgent({
 *     model,                                       // any chat model
 *     tools: [send_email, book_meeting],           // acting tools; each checked before it runs
 *     middleware: [edenMiddleware(eden)],          // report, inject, keep, ask_context, guard
 *   });
 *   const result = await agent.invoke({ messages: [new HumanMessage(question)] });
 *
 * - **Report every event.** Before each model call the middleware reports the request's new messages: the user's
 *   text (`user_message`, which waits for Eden's lookup, 3 s at most by the client's default), the assistant's text
 *   and tool calls, and the tool results. Each message once per conversation; on first sight only the latest user
 *   message on. The answer's own text and tool calls are reported right after the call, so a one-shot agent's reply
 *   reaches Eden too.
 * - **Inject before every model call, and keep packets in place (D336).** The observe's packet and anything queued
 *   (`pending`) go in as a text block at the start of the user message they answer (a packet landing between a
 *   turn's model calls goes after the last message as a new human message), on this call and every later one, so
 *   each request starts with the one before it (the provider's prompt cache) and the agent keeps items Eden will not
 *   send twice. LangChain hands the middleware the state's messages each call, so the session holds the placements
 *   (by message text and copy).
 * - **`ask_context`** with Eden's own description (D70), added by the middleware's `tools`.
 * - **Check acting tools** (`wrapToolCall`): each call goes to `eden.check` first; on a finding the tool does not
 *   run and the agent gets the finding as its tool result (`heldResult`); the same call again proceeds (D376, D420).
 *   `ask_context` is Eden's own and is never checked or reported as the agent's call.
 * - **Send `session_start`** when the middleware is made (D755).
 * - **Fails open (D14).** The client never throws; anything else here that throws is caught and the model or tool
 *   is called with the request as it came.
 *
 * Only `@eden/client` and `langchain` are imported. Change notices from your sources' webhooks are outside the
 * agent's loop: forward them with `eden.sourceChanged(sourceId, { refs })` from the webhook handler.
 */
import { createHash } from "node:crypto";
import { ASK_CONTEXT_DESCRIPTION, heldResult, type EdenClient, type Injection } from "@eden/client";
import { AIMessage, BaseMessage, HumanMessage, ToolMessage, createMiddleware, tool } from "langchain";

/** The text of a message's text blocks (`BaseMessage.text` joins them). */
function textOf(m: BaseMessage): string {
  return typeof m.text === "string" ? m.text : "";
}

/** Packet text kept in place per session, as the proxy's `maxKeptBytes` (D336). */
const MAX_KEPT_BYTES = 64_000;
/** Messages remembered as reported per session; the oldest go first. */
const MAX_SEEN = 4_000;

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** A message's identity for "already reported": type, text, and its tool call or result ids. */
function keyOf(m: BaseMessage): string {
  let ids = "";
  if (m instanceof AIMessage) ids = (m.tool_calls ?? []).map((c) => c.id ?? "").join(",");
  else if (m instanceof ToolMessage) ids = m.tool_call_id ?? "";
  return hash(`${m.getType()}\u0000${textOf(m)}\u0000${ids}`);
}

type EventInput = Parameters<EdenClient["observe"]>[0];

/** Eden events for one conversation message. `ask_context` is Eden's own and is not reported as the agent's. */
function eventsOf(m: BaseMessage): EventInput[] {
  const text = textOf(m);
  if (m instanceof HumanMessage) return text ? [{ kind: "user_message", text }] : [];
  if (m instanceof AIMessage) {
    const out: EventInput[] = text ? [{ kind: "agent_message", text }] : [];
    for (const c of m.tool_calls ?? []) {
      if (c.name && c.name !== "ask_context") out.push({ kind: "tool_call", tool: c.name, input: c.args ?? {} });
    }
    return out;
  }
  if (m instanceof ToolMessage) {
    return m.name && m.name !== "ask_context" && text ? [{ kind: "tool_result", tool: m.name, output: text }] : [];
  }
  return [];
}

/** A human message with `text` as its first content block. */
function withPacket(m: HumanMessage, text: string): HumanMessage {
  const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
  return new HumanMessage({
    content: [{ type: "text" as const, text }, ...blocks],
    id: m.id ?? undefined,
    name: m.name ?? undefined,
  });
}

/**
 * Eden for one conversation, as a `createAgent` middleware (one `EdenClient`, whose `sessionId` is the
 * conversation's). Keep it for the conversation's life: it remembers what was reported and where packets were
 * placed.
 */
export function edenMiddleware(eden: EdenClient) {
  /** Messages already reported, by key and copy number. */
  const seen = new Map<string, number>();
  let firstCall = true;
  /**
   * Packet text kept in place (D336): a turn's packet in its user message (`before`, by that message's key and copy
   * number), and a packet that landed mid-turn after the message it followed (`after`, appended as a human message).
   */
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  /** UTF-8 bytes held in `before` and `after`; past `MAX_KEPT_BYTES` the oldest placements go (the proxy's cap). */
  let keptBytes = 0;
  const keep = (map: Map<string, string>, key: string, text: string, live: ReadonlySet<string>) => {
    const old = map.get(key);
    if (old !== undefined) keptBytes -= Buffer.byteLength(old);
    map.delete(key);
    map.set(key, text);
    keptBytes += Buffer.byteLength(text);
    // Over the cap, as the proxy does: placements whose message has left the state first, then the oldest; never
    // the one just placed (this turn's packet keeps each call of the turn a prefix of the next).
    for (const onlyGone of [true, false]) {
      for (const m of [before, after]) {
        for (const [k, v] of m) {
          if (keptBytes <= MAX_KEPT_BYTES) return;
          if ((m === map && k === key) || (onlyGone && live.has(k))) continue;
          m.delete(k);
          keptBytes -= Buffer.byteLength(v);
        }
      }
    }
  };

  // D14: never rejects, even for a client that throws.
  const started = Promise.resolve()
    .then(() => eden.observe({ kind: "session_start" }))
    .then(
      () => undefined,
      () => undefined,
    );

  /**
   * The reports of each answer's own messages, sent in the background so the agent does not wait on them; the next
   * model call waits for them first, so Eden sees the conversation in order.
   */
  let reported: Promise<unknown> = started;

  const reportAnswer = (result: unknown) => {
    try {
      const out: BaseMessage[] = [];
      if (result instanceof BaseMessage) out.push(result);
      // A Command's messages (an end the middleware or tool chose) are the answer Eden should see too, as is a
      // result that carries its messages in a plain `messages` array (e.g. a structured-output turn's).
      for (const list of [
        (result as { messages?: unknown } | null)?.messages,
        (result as { update?: { messages?: unknown } } | null)?.update?.messages,
      ]) {
        if (Array.isArray(list)) out.push(...list.filter((m) => m instanceof BaseMessage));
      }
      for (const m of out) {
        const k = keyOf(m);
        if (seen.has(`${k}#1`)) continue;
        seen.set(`${k}#1`, 1);
        const events = eventsOf(m);
        reported = reported.then(async () => {
          for (const ev of events) await eden.observe(ev, { waitMs: 0 });
        });
      }
    } catch {
      // D14: reporting is best effort.
    }
  };

  const askContext = tool(
    async (input: { question: string }) => (await eden.ask(input.question))?.answer ?? "No context available.",
    {
      name: "ask_context",
      description: ASK_CONTEXT_DESCRIPTION,
      schema: {
        type: "object",
        properties: { question: { type: "string", description: "The question, in plain words." } },
        required: ["question"],
      },
    },
  );

  return createMiddleware({
    name: "EdenMiddleware",
    tools: [askContext],
    wrapModelCall: async (request, handler) => {
      let out = request.messages;
      try {
        await reported.catch(() => undefined);
        const prompt = request.messages;
        // Which messages are new, by content and copy (a repeated "yes" in a later turn is new).
        const copies = new Map<string, number>();
        const keys = prompt.map((m) => {
          const k = keyOf(m);
          const n = (copies.get(k) ?? 0) + 1;
          copies.set(k, n);
          return `${k}#${n}`;
        });
        const lastUser = prompt.map((m) => m.getType()).lastIndexOf("human");
        const fresh = prompt
          .map((m, i) => ({ m, i }))
          .filter(({ m, i }) => {
            if (m.getType() === "system") return false;
            const k = keys[i]!;
            if (seen.has(k)) return false;
            seen.set(k, 1);
            if (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value!);
            // First sight of a conversation (a restart): only the latest user message on, no replay of a history.
            return !firstCall || i >= lastUser;
          });
        firstCall = false;
        const got: Injection[] = [];
        let turnFresh = false;
        for (const { m, i } of fresh) {
          for (const ev of eventsOf(m)) {
            // Only the latest user message waits for its lookup (the client's default wait); others do not.
            const waits = ev.kind === "user_message" && i === lastUser;
            if (waits) turnFresh = true;
            const { injection } = await eden.observe(ev, waits ? {} : { waitMs: 0 });
            if (injection) got.push(injection);
          }
        }
        got.push(...(await eden.pending()));
        if (got.length > 0 && lastUser >= 0) {
          const text = got.map((p) => p.text).join("\n\n");
          // A new turn's packet goes into its user message; one that lands between a turn's model calls goes after
          // the last message, so the earlier requests stay a prefix of this one (the provider's cache).
          const live = new Set(keys);
          if (turnFresh) keep(before, keys[lastUser]!, text, live);
          else keep(after, keys.at(-1)!, text, live);
        }
        if (before.size > 0 || after.size > 0) {
          out = [];
          for (const [i, m] of prompt.entries()) {
            const lead = m instanceof HumanMessage ? before.get(keys[i]!) : undefined;
            out.push(lead ? withPacket(m, lead) : m);
            const tail = after.get(keys[i]!);
            if (tail && m.getType() !== "system") out.push(new HumanMessage({ content: tail }));
          }
        }
      } catch {
        // D14: reporting and injecting are best effort; the model is called with the prompt as it came.
      }
      const result = await handler({ ...request, messages: out });
      reportAnswer(result);
      return result;
    },
    wrapToolCall: async (request, handler) => {
      const name = request.toolCall.name ?? "tool";
      if (name === "ask_context") return handler(request); // Eden's own tool is not an acting call.
      let held: string | null = null;
      try {
        const check = await eden.check(name, request.toolCall.args ?? {});
        if (check.verdict === "finding" && check.finding) held = heldResult(name, check.finding);
      } catch {
        held = null; // D14: a check that fails runs the tool.
      }
      if (held === null) {
        const res = await handler(request);
        // A `returnDirect` tool's result never reaches a later model call, so report it here; the seen key keeps a
        // normal call's result from being reported twice when it turns up in the next request's messages.
        reportAnswer(res);
        return res;
      }
      const message = new ToolMessage({
        content: held,
        tool_call_id: request.toolCall.id ?? "",
        name,
        status: "success",
      });
      reportAnswer(message);
      return message;
    },
  });
}
