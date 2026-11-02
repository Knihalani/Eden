/**
 * Hermes speaks OpenAI chat completions; a `claude-*` agent model is Anthropic's Messages API. This module translates
 * one to the other for the Hermes proxy (hermes-proxy.ts). LAB ONLY.
 *
 * Request: leading system messages become the top-level system prompt and later ones (Eden's packets, if a harness
 * sends them as system messages) a second system block; user and tool turns become user turns (tool results as
 * `tool_result` blocks, consecutive ones merged); assistant tool calls become `tool_use` blocks. Prompt caching: one
 * 5-minute breakpoint on the last tool (Hermes' long tool list), one on the leading system prompt, and one on the
 * last message, so every later step of a task reads the whole earlier conversation from the cache. Thinking is off
 * (as on the OpenRouter agent, which sends no reasoning) and no sampling parameter is sent (Haiku 5.5 rejects them).
 *
 * Response: a Messages stream is turned into chat-completion chunks as it arrives (text deltas, tool-call deltas, the
 * finish reason, then a final chunk with `usage` including cached tokens); a JSON reply into a chat completion.
 */

type Json = Record<string, unknown>;

interface OpenAIMessage {
  role: string;
  content?: unknown;
  tool_calls?: { id: string; type?: string; function: { name: string; arguments?: string } }[];
  tool_call_id?: string;
}

type Block = Json & { type: string };
interface AnthropicMessage {
  role: "user" | "assistant";
  content: Block[];
}

const EPHEMERAL = { type: "ephemeral" } as const;

/** The text of an OpenAI message content: a string or an array of parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as Json).text === "string" ? (p as Json).text : ""))
      .join("");
  }
  return "";
}

function parseArgs(raw: string | undefined): Json {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : { value: v };
  } catch {
    // A truncated or malformed call is passed on as text, so the model sees what it sent.
    return { raw };
  }
}

/** The Messages API body for an OpenAI chat-completion body. */
export function toAnthropicBody(body: Json, model: string, maxTokens: number, stream: boolean): Json {
  const messages = (Array.isArray(body.messages) ? body.messages : []) as OpenAIMessage[];
  const leading: string[] = [];
  const later: string[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (!blocks.length) return;
    const prev = out.at(-1);
    if (prev && prev.role === role) prev.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      (out.length ? later : leading).push(textOf(m.content));
    } else if (m.role === "user") {
      const text = textOf(m.content);
      push("user", text ? [{ type: "text", text }] : []);
    } else if (m.role === "assistant") {
      const blocks: Block[] = [];
      const text = textOf(m.content);
      if (text.trim()) blocks.push({ type: "text", text });
      for (const c of m.tool_calls ?? []) {
        blocks.push({ type: "tool_use", id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) });
      }
      push("assistant", blocks);
    } else if (m.role === "tool") {
      push("user", [
        { type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: textOf(m.content) || "(empty)" },
      ]);
    }
  }
  if (out[0]?.role !== "user") out.unshift({ role: "user", content: [{ type: "text", text: "(begin)" }] });
  // The conversation so far is cached at its last block: the next step reads it back.
  const lastBlock = out.at(-1)?.content.at(-1);
  if (lastBlock) lastBlock.cache_control = EPHEMERAL;

  const system: Block[] = [];
  if (leading.length) system.push({ type: "text", text: leading.join("\n\n"), cache_control: EPHEMERAL });
  if (later.length) system.push({ type: "text", text: later.join("\n\n") });

  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .map((t) => (t as { function?: { name: string; description?: string; parameters?: Json } }).function)
    .filter((f): f is { name: string; description?: string; parameters?: Json } => !!f?.name)
    .map((f) => ({
      name: f.name,
      description: f.description ?? "",
      input_schema: f.parameters ?? { type: "object", properties: {} },
    })) as Json[];
  if (tools.length) tools.at(-1)!.cache_control = EPHEMERAL;

  const choice = body.tool_choice;
  const toolChoice =
    choice === "none"
      ? { type: "none" }
      : choice === "required"
        ? { type: "any" }
        : tools.length
          ? { type: "auto" }
          : null;

  const asked = typeof body.max_tokens === "number" ? body.max_tokens : maxTokens;
  return {
    model,
    max_tokens: Math.min(asked, maxTokens),
    ...(system.length ? { system } : {}),
    messages: out,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice && tools.length ? { tool_choice: toolChoice } : {}),
    thinking: { type: "disabled" },
    ...(stream ? { stream: true } : {}),
  };
}

/** Anthropic usage, as the proxy books it. */
export interface AnthropicUsageCounts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

const FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  refusal: "content_filter",
};

/** The OpenAI usage object for Anthropic usage: prompt tokens are the whole prompt, cached ones detailed. */
export function openAIUsage(u: AnthropicUsageCounts) {
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.output,
    total_tokens: prompt + u.output,
    prompt_tokens_details: { cached_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite },
  };
}

/** A chat completion for a Messages JSON reply. */
export function fromAnthropicJson(reply: Json, model: string): { completion: Json; usage: AnthropicUsageCounts } {
  const usage = usageFrom((reply.usage ?? {}) as Json);
  const content = (Array.isArray(reply.content) ? reply.content : []) as Block[];
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("");
  const calls = content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: String(b.id),
      type: "function",
      function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
    }));
  const completion = {
    id: String(reply.id ?? "msg"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) },
        finish_reason: FINISH[String(reply.stop_reason)] ?? "stop",
      },
    ],
    usage: openAIUsage(usage),
  };
  return { completion, usage };
}

function usageFrom(u: Json): AnthropicUsageCounts {
  return {
    input: Number(u.input_tokens ?? 0),
    cacheRead: Number(u.cache_read_input_tokens ?? 0),
    cacheWrite: Number(u.cache_creation_input_tokens ?? 0),
    output: Number(u.output_tokens ?? 0),
  };
}

/**
 * Turns a Messages event stream into chat-completion chunks. `push(event)` returns the SSE text to send for it
 * (possibly empty); `usage` is the latest reported; `firstToken` is set by the first content event.
 */
export class StreamTranslator {
  usage: AnthropicUsageCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  stopReason: string | null = null;
  firstContent = false;
  private id = "msg";
  private created = Math.floor(Date.now() / 1000);
  /** Anthropic block index → OpenAI tool-call index. */
  private toolIndex = new Map<number, number>();
  private sentRole = false;

  constructor(private readonly model: string) {}

  private chunk(delta: Json, finish: string | null = null, extra: Json = {}): string {
    if (!this.sentRole) {
      delta = { role: "assistant", ...delta };
      this.sentRole = true;
    }
    const c = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    };
    return `data: ${JSON.stringify(c)}\n\n`;
  }

  push(event: Json): string {
    switch (event.type) {
      case "message_start": {
        const m = (event.message ?? {}) as Json;
        this.id = String(m.id ?? this.id);
        this.usage = usageFrom((m.usage ?? {}) as Json);
        return "";
      }
      case "content_block_start": {
        const b = (event.content_block ?? {}) as Block;
        if (b.type !== "tool_use") return "";
        this.firstContent = true;
        const index = this.toolIndex.size;
        this.toolIndex.set(Number(event.index), index);
        return this.chunk({
          tool_calls: [
            { index, id: String(b.id), type: "function", function: { name: String(b.name), arguments: "" } },
          ],
        });
      }
      case "content_block_delta": {
        const d = (event.delta ?? {}) as Json;
        if (d.type === "text_delta" && d.text) {
          this.firstContent = true;
          return this.chunk({ content: String(d.text) });
        }
        if (d.type === "input_json_delta" && typeof d.partial_json === "string" && d.partial_json) {
          const index = this.toolIndex.get(Number(event.index)) ?? 0;
          return this.chunk({ tool_calls: [{ index, function: { arguments: d.partial_json } }] });
        }
        return "";
      }
      case "message_delta": {
        const d = (event.delta ?? {}) as Json;
        const u = (event.usage ?? {}) as Json;
        if (d.stop_reason) this.stopReason = String(d.stop_reason);
        if (u.output_tokens != null) this.usage.output = Number(u.output_tokens);
        if (u.input_tokens != null) this.usage.input = Number(u.input_tokens);
        if (u.cache_read_input_tokens != null) this.usage.cacheRead = Number(u.cache_read_input_tokens);
        if (u.cache_creation_input_tokens != null) this.usage.cacheWrite = Number(u.cache_creation_input_tokens);
        return "";
      }
      case "message_stop":
        return (
          this.chunk({}, FINISH[this.stopReason ?? ""] ?? "stop") +
          `data: ${JSON.stringify({
            id: this.id,
            object: "chat.completion.chunk",
            created: this.created,
            model: this.model,
            choices: [],
            usage: openAIUsage(this.usage),
          })}\n\n` +
          "data: [DONE]\n\n"
        );
      case "error": {
        const err = (event.error ?? {}) as Json;
        throw new Error(`anthropic stream error ${String(err.type ?? "")}`);
      }
      default:
        return "";
    }
  }
}
