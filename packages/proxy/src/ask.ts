/**
 * `ask_context` through the proxy (D851, trial `askTool`). D70 measured the SDK arm without the tool at −11.9
 * points of hidden facts raised, and the proxy offered none (weak point D3 of docs/research/weak-points-1111.md). With
 * the switch on, the proxy adds Eden's `ask_context` to the request's tools and answers the model's calls to it
 * itself: it asks Eden, appends the call and its answer to a copy of the conversation, and calls the model again,
 * until the model answers without asking. The agent sees one model call and never sees the tool or its rounds.
 *
 * One function per route reads a model answer (a JSON body, or a buffered event stream) into the calls it makes and
 * writes the next request: chat completions (`tool_calls` on the assistant message, `tool` results), Anthropic's
 * Messages (`tool_use` blocks, a user message of `tool_result` blocks; thinking blocks kept with their signatures, as
 * the API requires) and OpenAI's Responses (`function_call` items, `function_call_output` items).
 *
 * - **Fail open (D14).** Eden down or slow: the call's result says no context is available and the model goes on. An
 *   answer this file cannot read is handed to the agent as it came.
 * - **Bounded.** At most `MAX_ASK_ROUNDS` rounds a request, `MAX_ASKS_PER_ROUND` asks a round (the rest are told
 *   no context), and one deadline (`ASK_LOOP_MS`) for every ask of the request. An answer that still asks after the
 *   last round, a round the provider refuses (the first only for its shape: a 4xx but 401, 403, 429), or one this file
 *   cannot read or rewrite: the proxy sends the agent's
 *   own request (no tool) instead, so the agent is never handed a call to a tool it does not know and never an error
 *   the trial caused. The caller's `tool_choice` is never changed.
 * - **Not where the provider holds the history.** A Responses request with `previous_response_id` or `conversation`,
 *   or with `store: false`, is sent without the tool (re-sending stored or unstored items is refused there).
 * - **Streaming.** A streamed round is buffered whole before it is read: the model's first token reaches the agent
 *   only when that round ends. The final round's bytes are then sent exactly as the model sent them.
 * - Calls to the caller's own tools in a round that also asks are left out of the round (the model makes them again
 *   once it has the answer): each round must answer every call it carries.
 */
import { ASK_CONTEXT_DESCRIPTION } from "@eden/protocol";
import { withMessages } from "./with-messages";

export const ASK_TOOL_NAME = "ask_context";
/** Ask rounds a request at most; an answer that still asks then falls back to the agent's own request. */
export const MAX_ASK_ROUNDS = 3;
/** Asks answered in one round; any beyond are told no context (each ask can cost a reader call). */
export const MAX_ASKS_PER_ROUND = 4;
/** One deadline for every ask of one request (ms), so the asks add at most this before the agent's first byte. */
export const ASK_LOOP_MS = 8_000;
/** What the model is told when Eden could not answer: the round still completes and the agent goes on. */
export const NO_CONTEXT = "No context available.";

export type AskRouteName = "chat" | "anthropic" | "responses";

const QUESTION_SCHEMA = {
  type: "object",
  properties: { question: { type: "string", description: "The question, in plain words." } },
  required: ["question"],
} as const;

/** The tool's definition in each route's own shape, with Eden's own description (D70: keep it). */
export function askToolDefinition(route: AskRouteName): Record<string, unknown> {
  if (route === "anthropic") {
    return { name: ASK_TOOL_NAME, description: ASK_CONTEXT_DESCRIPTION, input_schema: QUESTION_SCHEMA };
  }
  if (route === "responses") {
    return { type: "function", name: ASK_TOOL_NAME, description: ASK_CONTEXT_DESCRIPTION, parameters: QUESTION_SCHEMA };
  }
  return {
    type: "function",
    function: { name: ASK_TOOL_NAME, description: ASK_CONTEXT_DESCRIPTION, parameters: QUESTION_SCHEMA },
  };
}

const toolName = (t: unknown): unknown => {
  const tool = t as { name?: unknown; function?: { name?: unknown } } | null;
  return tool?.function?.name ?? tool?.name;
};

/**
 * `raw` (the request body's text) with `ask_context` added to its tools, every other byte as it came; null when the
 * caller already has a tool of that name (an agent wired to Eden's MCP server: its calls are its own) or the tools
 * are not a list.
 */
export function withAskTool(raw: string, body: Record<string, unknown>, route: AskRouteName): string | null {
  const tools = body.tools;
  if (tools !== undefined && tools !== null && !Array.isArray(tools)) return null;
  const list = (tools ?? []) as unknown[];
  if (list.some((t) => toolName(t) === ASK_TOOL_NAME)) return null;
  return setKey(raw, "tools", [...list, askToolDefinition(route)]);
}

/** `raw` with a top-level key set (replaced where present, else added first), every other byte as it came. */
export function setKey(raw: string, key: string, value: unknown): string | null {
  const replaced = withMessages(raw, value, key);
  if (replaced !== null) return replaced;
  const open = raw.indexOf("{");
  if (open < 0) return null;
  const rest = raw.slice(open + 1).trimStart();
  const sep = rest.startsWith("}") ? "" : ",";
  return `${raw.slice(0, open + 1)}${JSON.stringify(key)}:${JSON.stringify(value)}${sep}${raw.slice(open + 1)}`;
}

/** One call to `ask_context` in a model answer: its id and the question (empty when the arguments had none). */
export interface AskCall {
  id: string;
  question: string;
}

/**
 * A model answer read for its asks: the calls to `ask_context`, and the conversation items to append (the answer's
 * own turn, with only the asks among its calls, then a result per ask) once the answers are in.
 */
export interface AskRound {
  asks: AskCall[];
  append: (answers: string[]) => unknown[];
}

const questionOf = (args: unknown): string => {
  let v = args;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return "";
    }
  }
  const q = (v as { question?: unknown } | null)?.question;
  return typeof q === "string" ? q.trim() : "";
};

/** The `data:` payloads of an event stream, parsed; lines that are not JSON (`[DONE]`) are skipped. */
function events(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const v: unknown = JSON.parse(data);
      if (v && typeof v === "object") out.push(v as Record<string, unknown>);
    } catch {
      // Not JSON: not an event this file reads.
    }
  }
  return out;
}

type ChatCall = { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };

/** Chat completions: the first choice's message, from a JSON answer or rebuilt from its stream's deltas. */
function chatMessage(text: string, streamed: boolean): { content: string | null; calls: ChatCall[] } | null {
  if (!streamed) {
    const m = (JSON.parse(text) as { choices?: { message?: { content?: unknown; tool_calls?: unknown } }[] })
      ?.choices?.[0]?.message;
    if (!m) return null;
    return {
      content: typeof m.content === "string" ? m.content : null,
      calls: Array.isArray(m.tool_calls) ? (m.tool_calls as ChatCall[]) : [],
    };
  }
  let content = "";
  const calls: { id: string; name: string; arguments: string }[] = [];
  for (const ev of events(text)) {
    const choice = (ev.choices as { index?: unknown; delta?: Record<string, unknown> }[] | undefined)?.[0];
    if (!choice || (choice.index !== undefined && choice.index !== 0)) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") content += delta.content;
    for (const d of Array.isArray(delta.tool_calls) ? (delta.tool_calls as Record<string, unknown>[]) : []) {
      const i = typeof d.index === "number" ? d.index : calls.length;
      const call = (calls[i] ??= { id: "", name: "", arguments: "" });
      const fn = (d.function ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof d.id === "string") call.id = d.id;
      if (typeof fn.name === "string") call.name += fn.name;
      if (typeof fn.arguments === "string") call.arguments += fn.arguments;
    }
  }
  return {
    content: content || null,
    calls: calls
      .filter(Boolean)
      .map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
  };
}

type Block = Record<string, unknown> & { type?: unknown };

/** Anthropic: the answer's content blocks, from a JSON answer or rebuilt from its stream's events. */
function anthropicBlocks(text: string, streamed: boolean): Block[] | null {
  if (!streamed) {
    const content = (JSON.parse(text) as { content?: unknown })?.content;
    return Array.isArray(content) ? (content as Block[]) : null;
  }
  const blocks: Block[] = [];
  const json: string[] = [];
  for (const ev of events(text)) {
    const i = ev.index as number;
    if (ev.type === "content_block_start" && typeof i === "number") {
      blocks[i] = { ...(ev.content_block as Block) };
      json[i] = "";
    } else if (ev.type === "content_block_delta" && typeof i === "number" && blocks[i]) {
      const d = (ev.delta ?? {}) as Record<string, unknown>;
      const b = blocks[i]!;
      if (d.type === "text_delta" && typeof d.text === "string") b.text = `${(b.text as string) ?? ""}${d.text}`;
      else if (d.type === "thinking_delta" && typeof d.thinking === "string") {
        b.thinking = `${(b.thinking as string) ?? ""}${d.thinking}`;
      } else if (d.type === "signature_delta" && typeof d.signature === "string") b.signature = d.signature;
      else if (d.type === "input_json_delta" && typeof d.partial_json === "string") json[i] += d.partial_json;
      else if (d.type === "citations_delta" && d.citation) {
        b.citations = [...(Array.isArray(b.citations) ? b.citations : []), d.citation];
      }
    } else if (
      ev.type === "content_block_stop" &&
      typeof i === "number" &&
      (blocks[i]?.type === "tool_use" || blocks[i]?.type === "server_tool_use") &&
      json[i]
    ) {
      try {
        blocks[i]!.input = JSON.parse(json[i]!);
      } catch {
        blocks[i]!.input = {};
      }
    }
  }
  // A text block's `citations` start as [] in a stream and fill by delta; an empty list is not sent back.
  return blocks.filter(Boolean).map((b) => {
    if (b.type === "text" && Array.isArray(b.citations) && b.citations.length === 0) {
      const { citations: _c, ...rest } = b;
      return rest;
    }
    return b;
  });
}

/** Responses: the answer's output items, from a JSON answer or the stream's `response.completed` event. */
function responsesOutput(text: string, streamed: boolean): Block[] | null {
  if (!streamed) {
    const output = (JSON.parse(text) as { output?: unknown })?.output;
    return Array.isArray(output) ? (output as Block[]) : null;
  }
  for (const ev of events(text)) {
    if (ev.type !== "response.completed") continue;
    const output = (ev.response as { output?: unknown } | undefined)?.output;
    return Array.isArray(output) ? (output as Block[]) : null;
  }
  return null;
}

/**
 * A model answer (its body's text) read for asks; null when it makes none or cannot be read, so it goes to the
 * agent as it came.
 */
export function readRound(route: AskRouteName, text: string, streamed: boolean): AskRound | null {
  try {
    if (route === "chat") {
      const m = chatMessage(text, streamed);
      const mine = (m?.calls ?? []).filter((c) => c?.function?.name === ASK_TOOL_NAME);
      if (!m || mine.length === 0) return null;
      const asks = mine.map((c) => ({ id: String(c.id ?? ""), question: questionOf(c.function?.arguments) }));
      return {
        asks,
        append: (answers) => [
          { role: "assistant", content: m.content, tool_calls: mine },
          ...asks.map((a, i) => ({ role: "tool", tool_call_id: a.id, content: answers[i] ?? NO_CONTEXT })),
        ],
      };
    }
    if (route === "anthropic") {
      const blocks = anthropicBlocks(text, streamed);
      const asks = (blocks ?? [])
        .filter((b) => b.type === "tool_use" && b.name === ASK_TOOL_NAME)
        .map((b) => ({ id: String(b.id ?? ""), question: questionOf(b.input) }));
      if (!blocks || asks.length === 0) return null;
      // The caller's own tool calls are left out (each kept call needs a result); thinking and text stay.
      const kept = blocks.filter((b) => b.type !== "tool_use" || b.name === ASK_TOOL_NAME);
      return {
        asks,
        append: (answers) => [
          { role: "assistant", content: kept },
          {
            role: "user",
            content: asks.map((a, i) => ({
              type: "tool_result",
              tool_use_id: a.id,
              content: answers[i] ?? NO_CONTEXT,
            })),
          },
        ],
      };
    }
    const output = responsesOutput(text, streamed);
    const asks = (output ?? [])
      .filter((o) => o.type === "function_call" && o.name === ASK_TOOL_NAME)
      .map((o) => ({ id: String(o.call_id ?? ""), question: questionOf(o.arguments) }));
    if (!output || asks.length === 0) return null;
    const kept = output.filter(
      (o) => (o.type !== "function_call" && o.type !== "custom_tool_call") || o.name === ASK_TOOL_NAME,
    );
    return {
      asks,
      append: (answers) => [
        ...kept,
        ...asks.map((a, i) => ({ type: "function_call_output", call_id: a.id, output: answers[i] ?? NO_CONTEXT })),
      ],
    };
  } catch {
    return null;
  }
}

/** The request's conversation (`messages`, or the Responses `input` as a list) and the key it sits under. */
export function conversationOf(route: AskRouteName, body: Record<string, unknown>): { key: string; items: unknown[] } {
  if (route !== "responses") return { key: "messages", items: Array.isArray(body.messages) ? body.messages : [] };
  const input = body.input;
  const items = typeof input === "string" ? [{ role: "user", content: input }] : Array.isArray(input) ? input : [];
  return { key: "input", items };
}
