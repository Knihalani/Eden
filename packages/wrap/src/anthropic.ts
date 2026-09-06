import type { StretchProgram } from "@eden/ir";
import { redact } from "@eden/ir";
import { compiledSchema, steerToolCalls } from "./steer";
import { noteJitUsed, selectForRequest } from "./intent";
import { filterCanary } from "./canary";
import { killAfterWarningEnabled } from "./guard";
import type { WrapState } from "./wrap-tools";
import { withKnowFactsAnthropic } from "./know-inject";
import { processMemory } from "../../../src/index";

export interface AnthropicProxyOpts {
  state: WrapState;
  getPrograms?: () => StretchProgram[];
  fetch?: typeof fetch;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  cache_control?: { type: "ephemeral" };
  content?: string;
  is_error?: boolean;
}

interface AnthropicRequest {
  model?: string;
  max_tokens?: number;
  system?: string | Array<{ type: string; text?: string; cache_control?: { type: "ephemeral" } }>;
  messages?: Array<{ role: string; content: string | AnthropicContentBlock[] }>;
  tools?: Array<{ name: string; description?: string; input_schema?: object; cache_control?: { type: "ephemeral" } }>;
  stream?: boolean;
}

const VOLATILE_TEXT = /(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2})|(?:available skills)|(?:skill(?:s)?\s+(?:list|index|listing))/i;

export function isVolatilePrefixText(text: string): boolean {
  return VOLATILE_TEXT.test(text);
}

type SystemBlock = { type: string; text?: string; cache_control?: { type: "ephemeral" } };

export function applyCacheGuard(body: { system?: string | SystemBlock[] }): void {
  if (!Array.isArray(body.system) || body.system.length < 2) return;
  const stable: SystemBlock[] = [];
  const volatile: SystemBlock[] = [];
  for (const b of body.system) {
    const copy = { ...b };
    delete copy.cache_control;
    if (isVolatilePrefixText(copy.text ?? "")) volatile.push(copy);
    else stable.push(copy);
  }
  if (!volatile.length || !stable.length) return;
  body.system = [...stable, ...volatile];
}

function lastStableSystemIndex(blocks: SystemBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (!isVolatilePrefixText(blocks[i]!.text ?? "")) return i;
  }
  return blocks.length - 1;
}

export function applyCacheBreakpoints(body: AnthropicRequest): void {
  if (process.env.EDEN_PROMPT_CACHE === "0") return;
  if (process.env.EDEN_CACHE_GUARD === "1") applyCacheGuard(body);
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const last = body.tools[body.tools.length - 1]!;
    last.cache_control = { type: "ephemeral" };
  }
  if (typeof body.system === "string") {
    body.system = [{ type: "text", text: body.system, cache_control: { type: "ephemeral" } }];
  } else if (Array.isArray(body.system) && body.system.length > 0) {
    const idx = lastStableSystemIndex(body.system);
    const last = body.system[idx]!;
    last.cache_control = { type: "ephemeral" };
  }
  const msgs = body.messages;
  if (Array.isArray(msgs) && msgs.length > 0) {
    const lastMsg = msgs[msgs.length - 1]!;
    if (typeof lastMsg.content === "string") {
      lastMsg.content = [{ type: "text", text: lastMsg.content, cache_control: { type: "ephemeral" } }];
    } else if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
      const lastBlock = lastMsg.content[lastMsg.content.length - 1]!;
      (lastBlock as { cache_control?: { type: "ephemeral" } }).cache_control = { type: "ephemeral" };
    }
  }
}

type AnthropicMessage = {
  id?: string;
  type?: string;
  role?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
};

function upstreamTimeoutMs(): number {
  const env = Number(process.env.EDEN_UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? Math.min(600_000, env) : 300_000;
}

function anthropicToolDef(program: StretchProgram) {
  const openai = compiledSchema(program);
  const fn = "function" in openai ? openai.function : undefined;
  return {
    name: fn?.name ?? program.name,
    description: fn?.description ?? "",
    input_schema: fn?.parameters ?? program.inputSchema,
    allowed_callers: openai.allowed_callers,
    defer_loading: openai.defer_loading,
  };
}

function injectAnthropicTools(
  existing: AnthropicRequest["tools"],
  programs: StretchProgram[],
): AnthropicRequest["tools"] {
  const live = programs.filter((p) => p.manifest);
  if (!live.length) return existing;
  const extra = live.map(anthropicToolDef);
  const names = new Set(extra.map((t) => t.name));
  return [...extra, ...(existing ?? []).filter((t) => !names.has(t.name))];
}

export function steerAnthropicToolUses(
  content: AnthropicContentBlock[],
  programs: StretchProgram[],
): AnthropicContentBlock[] {
  const openaiCalls = content
    .filter((b) => b.type === "tool_use" && b.name)
    .map((b) => ({
      id: b.id,
      function: { name: b.name!, arguments: JSON.stringify(b.input ?? {}) },
    }));
  if (!openaiCalls.length) return content;

  const steered = steerToolCalls(openaiCalls, programs);
  const survivingIds = new Set(steered.map((c) => c.id).filter((id): id is string => typeof id === "string"));
  const byId = new Map(
    steered
      .filter((c) => typeof c.id === "string" && c.function)
      .map((c) => [c.id as string, c]),
  );
  return content.flatMap((block) => {
    if (block.type !== "tool_use") return [block];
    if (!block.id || !survivingIds.has(block.id)) return []; // absorbed by the compiled run
    const replacement = byId.get(block.id);
    if (!replacement?.function) return [block];
    try {
      return [
        {
          ...block,
          name: replacement.function.name,
          input: JSON.parse(replacement.function.arguments),
        },
      ];
    } catch {
      return [block];
    }
  });
}

function recordAnthropicCompletion(run: WrapState["run"], msg: AnthropicMessage): void {
  run.llmCalls += 1;
  const u = msg.usage;
  if (u && (typeof u.input_tokens === "number" || typeof u.output_tokens === "number")) {
    run.measured = true;
    run.prompt_tokens += u.input_tokens ?? 0;
    run.completion_tokens += u.output_tokens ?? 0;
  }
  const texts = (msg.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text);
  if (texts.length) run.output = redact(texts.join("\n"));
}

export function anthropicMessageToSse(msg: AnthropicMessage): string {
  const indexByBlock = new Map<AnthropicContentBlock, number>();
  let out = "";
  const sse = (event: string, data: unknown): void => {
    out += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  };
  const inputTokens = msg.usage?.input_tokens ?? 0;
  sse("message_start", {
    type: "message_start",
    message: {
      id: msg.id ?? `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: msg.model ?? "",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  blocks.forEach((block, i) => {
    indexByBlock.set(block, i);
    if (block.type === "text") {
      sse("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: block.text ?? "" } });
      sse("content_block_stop", { type: "content_block_stop", index: i });
      return;
    }
    if (block.type === "tool_use") {
      sse("content_block_start", {
        type: "content_block_start",
        index: i,
        content_block: { type: "tool_use", id: block.id ?? "", name: block.name ?? "", input: {} },
      });
      sse("content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
      });
      sse("content_block_stop", { type: "content_block_stop", index: i });
      return;
    }
    sse("content_block_start", { type: "content_block_start", index: i, content_block: block });
    sse("content_block_stop", { type: "content_block_stop", index: i });
  });
  sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: msg.stop_reason ?? "end_turn", stop_sequence: null },
    usage: { output_tokens: msg.usage?.output_tokens ?? 0 },
  });
  sse("message_stop", { type: "message_stop" });
  return out;
}

export async function handleAnthropicMessages(req: Request, opts: AnthropicProxyOpts): Promise<Response> {
  let body: AnthropicRequest;
  try {
    body = (await req.json()) as AnthropicRequest;
  } catch {
    return Response.json(
      { type: "error", error: { type: "invalid_request_error", message: "invalid json" } },
      { status: 400 },
    );
  }

  const live = filterCanary(opts.getPrograms?.() ?? opts.state.programs.filter((p) => p.manifest), opts.state.sessionId);
  const steerable = !killAfterWarningEnabled(opts.state.opts) || opts.state.run.firstWarningAt == null;
  const shouldSteer = steerable && live.length > 0 && Array.isArray(body.tools);
  if (shouldSteer) body.tools = injectAnthropicTools(body.tools, selectForRequest(live, body.messages as unknown[] | undefined, opts.state.jit));

  const wantsStream = Boolean(body.stream);
  if (shouldSteer && wantsStream) body.stream = false; // re-framed below after steering

  applyCacheBreakpoints(body);
  processMemory().observe((body.messages as unknown[]) || []);
  body = withKnowFactsAnthropic(body) as AnthropicRequest;

  const fn = opts.fetch ?? fetch;
  const anthropicKey = req.headers.get("x-api-key") || process.env.ANTHROPIC_API_KEY || "";
  const anthropicBase = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  const version = req.headers.get("anthropic-version") || "2023-06-01";
  let upstreamRes: Response | undefined;
  try {
    upstreamRes = await fn(`${anthropicBase}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": version,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(upstreamTimeoutMs()),
    });
  } catch {
    upstreamRes = undefined;
  }

  if (!upstreamRes) {
    return Response.json(
      { type: "error", error: { type: "api_error", message: "upstream unavailable" } },
      { status: 502 },
    );
  }
  const text = await upstreamRes.text();
  if (!upstreamRes.ok) {
    return new Response(text, {
      status: upstreamRes.status,
      headers: { "content-type": upstreamRes.headers.get("content-type") || "application/json", ...corsHeaders(req) },
    });
  }
  let msg: AnthropicMessage;
  try {
    msg = JSON.parse(text) as AnthropicMessage;
  } catch {
    return new Response(text, {
      status: upstreamRes.status,
      headers: { "content-type": upstreamRes.headers.get("content-type") || "application/json", ...corsHeaders(req) },
    });
  }

  recordAnthropicCompletion(opts.state.run, msg);
  // Steer tool_use blocks against live programs — only when this request was
  // actually steerable; an unsteered passthrough must return the model's own
  // tool choices untouched.
  if (shouldSteer && msg.stop_reason === "tool_use" && Array.isArray(msg.content)) {
    try {
      msg.content = steerAnthropicToolUses(msg.content, live);
      noteJitUsed(
        opts.state.jit,
        msg.content.filter((b) => b.type === "tool_use" && b.name).map((b) => b.name!),
      );
    } catch {
      /* steering is a bonus; the model's own tool_use blocks still go back */
    }
  }

  if (wantsStream) {
    return new Response(anthropicMessageToSse(msg), {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        ...corsHeaders(req),
      },
    });
  }
  return Response.json(msg, { status: upstreamRes.status, headers: corsHeaders(req) });
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    return { "access-control-allow-origin": origin, vary: "origin" };
  }
  return {};
}
