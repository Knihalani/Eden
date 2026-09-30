import { redact, type StretchProgram } from "@eden/ir";
import { compiledSchema, steerToolCalls } from "./steer";
import { noteJitUsed, selectForRequest } from "./intent";
import { filterCanary } from "./canary";
import { killAfterWarningEnabled } from "./guard";
import type { WrapState } from "./wrap-tools";
import { withKnowFactsAnthropic } from "./know-inject";
import { stripUpstreamPlaceFields, withOpenFileHeaders } from "./tool-observe";
import { corsOrigin } from "./proxy";

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

type SystemBlock = { type: string; text?: string; cache_control?: { type: "ephemeral" } };

export function applyCacheBreakpoints(body: AnthropicRequest): void {
  if (process.env.EDEN_PROMPT_CACHE === "0") return;
  if (process.env.EDEN_CACHE_GUARD === "1" && Array.isArray(body.system) && body.system.length >= 2) {
    const stable: SystemBlock[] = [];
    const volatile: SystemBlock[] = [];
    for (const b of body.system) {
      const copy = { ...b };
      delete copy.cache_control;
      if (VOLATILE_TEXT.test(copy.text ?? "")) volatile.push(copy);
      else stable.push(copy);
    }
    if (volatile.length && stable.length) body.system = [...stable, ...volatile];
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const last = body.tools[body.tools.length - 1]!;
    last.cache_control = { type: "ephemeral" };
  }
  if (typeof body.system === "string") {
    body.system = [{ type: "text", text: body.system, cache_control: { type: "ephemeral" } }];
  } else if (Array.isArray(body.system) && body.system.length > 0) {
    const found = body.system.findLastIndex((b) => !VOLATILE_TEXT.test(b.text ?? ""));
    const last = body.system[found >= 0 ? found : body.system.length - 1]!;
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

export function anthropicMessageToSse(msg: AnthropicMessage): string {
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
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...corsOrigin(req), "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type, authorization, anthropic-version, x-api-key", "access-control-max-age": "86400" } });
  let body: AnthropicRequest;
  try {
    body = (await req.json()) as AnthropicRequest;
  } catch {
    return Response.json(
      { type: "error", error: { type: "invalid_request_error", message: "invalid json" } },
      { status: 400 },
    );
  }
  try {
    const header = [req.headers.get("x-eden-open-files"), req.headers.get("x-open-files")].filter(Boolean).join(",");
    body = withOpenFileHeaders(body as unknown as Record<string, unknown>, header) as unknown as AnthropicRequest;
  } catch {}

  const live = filterCanary(opts.getPrograms?.() ?? opts.state.programs.filter((p) => p.manifest), opts.state.sessionId);
  const steerable = !killAfterWarningEnabled(opts.state.opts) || opts.state.run.firstWarningAt == null;
  const shouldSteer = steerable && live.length > 0 && Array.isArray(body.tools);
  if (shouldSteer) {
    const extra = selectForRequest(live, body.messages as unknown[] | undefined, opts.state.jit)
      .filter((p) => p.manifest)
      .map((program) => {
        const openai = compiledSchema(program);
        return {
          name: program.name,
          description: program.description ?? "",
          input_schema: program.inputSchema,
          allowed_callers: openai.allowed_callers,
          defer_loading: openai.defer_loading,
        };
      });
    if (extra.length) {
      const names = new Set(extra.map((t) => t.name));
      body.tools = [...extra, ...(body.tools ?? []).filter((t) => !names.has(t.name))];
    }
  }

  const wantsStream = Boolean(body.stream);
  if (shouldSteer && wantsStream) body.stream = false; // re-framed below after steering

  applyCacheBreakpoints(body);
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
      body: JSON.stringify(stripUpstreamPlaceFields(body as unknown as Record<string, unknown>)),
      signal: AbortSignal.timeout((() => { const env = Number(process.env.EDEN_UPSTREAM_TIMEOUT_MS); return Number.isFinite(env) && env > 0 ? Math.min(600_000, env) : 300_000; })()),
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
  const passthrough = () =>
    new Response(text, {
      status: upstreamRes.status,
      headers: { "content-type": upstreamRes.headers.get("content-type") || "application/json", ...corsOrigin(req) },
    });
  if (!upstreamRes.ok) return passthrough();
  let msg: AnthropicMessage;
  try {
    msg = JSON.parse(text) as AnthropicMessage;
  } catch {
    return passthrough();
  }

  const run = opts.state.run;
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
  if (shouldSteer && msg.stop_reason === "tool_use" && Array.isArray(msg.content)) {
    try {
      msg.content = steerAnthropicToolUses(msg.content, live);
      noteJitUsed(
        opts.state.jit,
        msg.content.filter((b) => b.type === "tool_use" && b.name).map((b) => b.name!),
      );
    } catch {
    }
  }

  if (wantsStream) {
    return new Response(anthropicMessageToSse(msg), {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        ...corsOrigin(req),
      },
    });
  }
  return Response.json(msg, { status: upstreamRes.status, headers: corsOrigin(req) });
}
