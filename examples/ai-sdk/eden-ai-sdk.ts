/**
 * Eden in a Vercel AI SDK agent (D854): every integration obligation in docs/INTEGRATION.md from three calls.
 *
 *   const eden = new EdenClient({ apiKey, userId: edenId(user.id), sessionId: edenId(chat.id) });
 *   const session = edenSession(eden);                       // sends session_start at once
 *   const result = await generateText({
 *     model: session.wrap(model),                            // reports events, injects and keeps packets
 *     tools: { ...session.tools, ...session.guard({ send_email }) },   // ask_context; acting tools checked
 *     stopWhen: stepCountIs(5),
 *     messages,
 *   });
 *
 * - **Report every event.** Before each model call the middleware reports the prompt's new messages: the user's text
 *   (`user_message`, which waits for Eden's lookup, 3 s at most by the client's default), the assistant's text and
 *   tool calls, and the tool results. Each message once per session; on first sight only the latest user message on.
 * - **Inject before every model call, and keep packets in place (D336).** The observe's packet and anything queued
 *   (`pending`) go in as a text part at the start of the user message they answer (a packet landing between a turn's
 *   model calls, after the last message), on this call and every later one, so each request starts with the one
 *   before it (the provider's prompt cache) and the agent keeps items Eden will not send twice. The AI SDK hands the
 *   middleware the app's own messages each time, so the session holds the placements (by message text and copy).
 * - **`ask_context`** with Eden's own description (D70).
 * - **Check acting tools** (`guard`): each call goes to `eden.check` first; on a finding the tool does not run and
 *   the agent gets the finding as its result (`heldResult`); the same call again proceeds (D376, D420).
 * - **Send `session_start`** when the session is made (D755).
 * - **Fails open (D14).** The client never throws; anything else here that throws is caught and the model is
 *   called with the prompt as it came.
 *
 * Only `@eden/client` and `ai` are imported. Change notices from your sources' webhooks are outside the agent's
 * loop: forward them with `eden.sourceChanged(sourceId, { refs })` from the webhook handler.
 */
import { createHash } from "node:crypto";
import { ASK_CONTEXT_DESCRIPTION, heldResult, withSources, type EdenClient, type Injection } from "@eden/client";
import {
  jsonSchema,
  tool,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
  type ToolSet,
} from "ai";

type Prompt = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"]["prompt"];
type Message = Prompt[number];

export interface EdenSession {
  /** The model with Eden's middleware: report, inject, keep. */
  wrap: (model: LanguageModel) => LanguageModel;
  /** `ask_context`, answered by `eden.ask`. */
  tools: ToolSet;
  /** The given acting tools, each checked by `eden.check` before it runs. */
  guard: <T extends ToolSet>(tools: T) => T;
  /** The middleware alone, for `wrapLanguageModel` with other middleware. */
  middleware: LanguageModelMiddleware;
  /** The `session_start` observe, for callers that want to wait for it (it is sent either way). */
  started: Promise<void>;
}

/** The text of a message's text parts. */
function textOf(m: Message): string {
  if (typeof m.content === "string") return m.content;
  return (
    (m.content as { type: string; text?: string }[])
      // Empty text parts skipped: the SDK may leave one out of the next prompt, and the keys must still match.
      .filter((p) => p.type === "text" && typeof p.text === "string" && p.text !== "")
      .map((p) => p.text!)
      .join("\n")
  );
}

/** Packet text kept in place per session, as the proxy's `maxKeptBytes` (D336). */
const MAX_KEPT_BYTES = 64_000;
/** Messages remembered as reported per session; the oldest go first. */
const MAX_SEEN = 4_000;

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
/** A message's identity for "already reported": role, text, and its tool call or result ids. */
function keyOf(m: Message): string {
  const ids = Array.isArray(m.content)
    ? (m.content as { toolCallId?: string }[]).map((p) => p.toolCallId ?? "").join(",")
    : "";
  return hash(`${m.role}\u0000${textOf(m)}\u0000${ids}`);
}

/** A tool call's input as the model sent it (JSON text), parsed when it is JSON. */
function parsed(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

/** A tool result's output as text, for Eden's `tool_result` event. */
function outputText(output: unknown): string {
  const o = output as { type?: string; value?: unknown } | null;
  if (o && (o.type === "text" || o.type === "error-text") && typeof o.value === "string") return o.value;
  try {
    return JSON.stringify(o?.value ?? o) ?? "";
  } catch {
    return "";
  }
}

type EventInput = Parameters<EdenClient["observe"]>[0];

/** Eden events for one prompt message. */
function eventsOf(m: Message): EventInput[] {
  const text = textOf(m);
  if (m.role === "user") return text ? [{ kind: "user_message", text }] : [];
  const parts = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
  if (m.role === "assistant") {
    const out: EventInput[] = text ? [{ kind: "agent_message", text }] : [];
    for (const p of parts) {
      if (p.type === "tool-call" && typeof p.toolName === "string" && p.toolName !== "ask_context") {
        out.push({ kind: "tool_call", tool: p.toolName, input: p.input ?? {} });
      }
    }
    return out;
  }
  if (m.role === "tool") {
    return parts
      .filter((p) => p.type === "tool-result" && typeof p.toolName === "string" && p.toolName !== "ask_context")
      .map((p) => ({ kind: "tool_result", tool: p.toolName as string, output: outputText(p.output) }));
  }
  return [];
}

/**
 * Eden for one conversation (one `EdenClient`, whose `sessionId` is the conversation's). Make one per conversation and
 * keep it for the conversation's life: it remembers what was reported and where packets were placed.
 */
export function edenSession(eden: EdenClient): EdenSession {
  /** Messages already reported, by key and copy number. */
  const seen = new Map<string, number>();
  let firstCall = true;
  /**
   * Packet text kept in place (D336): a turn's packet in its user message (`before`, by that message's key and copy
   * number), and a packet that landed mid-turn after the message it followed (`after`).
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
    // Over the cap, as the proxy does: placements whose message has left the prompt first, then the oldest; never
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
   * The reports of each answer's own messages (`wrapGenerate`), sent in the background so the agent does not wait on
   * them; the next model call waits for them first, so Eden sees the conversation in order.
   */
  let reported: Promise<unknown> = started;
  /** Packets an answer's or tool call's observe handed out, placed on the next model call. */
  const queued: Injection[] = [];

  const middleware: LanguageModelMiddleware = {
    // A one-turn agent's reply never comes back in a later prompt: report the answer's text and tool calls now, and
    // mark the message as seen so the next turn's prompt does not report it again. (Streamed answers are reported
    // from the next prompt, as before.)
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      try {
        const content = result.content
          .filter((p) => p.type === "text" || p.type === "reasoning" || p.type === "tool-call")
          .map((p) => (p.type === "tool-call" ? { ...p, input: parsed(p.input) } : p));
        const answer = { role: "assistant", content } as Message;
        const k = keyOf(answer);
        const key = `${k}#${params.prompt.filter((m) => keyOf(m) === k).length + 1}`;
        if (!seen.has(key)) {
          seen.set(key, 1);
          const events = eventsOf(answer);
          reported = reported.then(async () => {
            for (const ev of events) {
              // Eden marks an observe's packet shown: it is placed on the next call, never dropped (D2113).
              const { injection } = await eden.observe(ev, { waitMs: 0 });
              if (injection) queued.push(injection);
            }
          });
        }
      } catch {
        // D14: reporting is best effort.
      }
      return result;
    },
    transformParams: async ({ params }) => {
      try {
        await reported.catch(() => undefined);
        const prompt = params.prompt;
        // Which messages are new, by content and copy (a repeated "yes" in a later turn is new).
        const copies = new Map<string, number>();
        const keys = prompt.map((m) => {
          const k = keyOf(m);
          const n = (copies.get(k) ?? 0) + 1;
          copies.set(k, n);
          return `${k}#${n}`;
        });
        const lastUser = prompt.map((m) => m.role).lastIndexOf("user");
        const fresh = prompt
          .map((m, i) => ({ m, i }))
          .filter(({ m, i }) => {
            if (m.role === "system") return false;
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
        got.push(...queued.splice(0), ...(await eden.pending()));
        if (got.length > 0 && lastUser >= 0) {
          const text = got.map((p) => p.text).join("\n\n");
          // A new turn's packet goes into its user message; one that lands between a turn's model calls goes after
          // the last message, so the earlier requests stay a prefix of this one (the provider's cache).
          const live = new Set(keys);
          if (turnFresh) keep(before, keys[lastUser]!, text, live);
          else keep(after, keys.at(-1)!, text, live);
        }
        if (before.size === 0 && after.size === 0) return params;
        const out: Message[] = [];
        for (const [i, m] of prompt.entries()) {
          const lead = m.role === "user" ? before.get(keys[i]!) : undefined;
          // As a text part of the user message, ahead of the user's own (some providers refuse a system message in
          // the middle of a prompt; the packet is Eden's data envelope either way, D11).
          out.push(lead ? ({ ...m, content: [{ type: "text", text: lead }, ...m.content] } as Message) : m);
          const tail = after.get(keys[i]!);
          if (tail && m.role !== "system") out.push({ role: "user", content: [{ type: "text", text: tail }] });
        }
        return { ...params, prompt: out };
      } catch {
        return params; // D14: the model is called with the prompt as it came.
      }
    },
  };

  const tools: ToolSet = {
    ask_context: tool({
      description: ASK_CONTEXT_DESCRIPTION,
      inputSchema: jsonSchema<{ question: string; item?: string }>({
        type: "object",
        properties: {
          question: { type: "string", description: "The question, in plain words." },
          item: {
            type: "string",
            description:
              "An item id from an earlier answer's Sources list ([item: ...]): return that item's parts in full.",
          },
        },
        required: ["question"],
      }),
      execute: async ({ question, item }) =>
        withSources(await eden.ask(question, typeof item === "string" ? { itemId: item } : {})) ??
        "No context available.",
    }),
  };

  const guard = <T extends ToolSet>(given: T): T => {
    const out: Record<string, unknown> = {};
    for (const [name, t] of Object.entries(given)) {
      const run = (t as { execute?: (input: unknown, options: unknown) => unknown }).execute;
      if (!run) {
        out[name] = t;
        continue;
      }
      out[name] = {
        ...t,
        execute: async (input: unknown, options: unknown) => {
          let held: string | null = null;
          try {
            const check = await eden.check(name, input);
            if (check.verdict === "finding" && check.finding) held = heldResult(name, check.finding);
          } catch {
            held = null; // D14: a check that fails runs the tool.
          }
          return held ?? run(input, options);
        },
      };
    }
    return out as T;
  };

  return {
    wrap: (model) =>
      wrapLanguageModel({ model: model as Parameters<typeof wrapLanguageModel>[0]["model"], middleware }),
    tools,
    guard,
    middleware,
    started,
  };
}
