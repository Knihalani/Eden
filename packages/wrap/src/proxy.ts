import type { StretchProgram } from "@eden/ir";
import { compiledSchema, injectTools, steerToolCalls } from "./steer";
import type { WrapState } from "./wrap-tools";

export type ProxyOpts = {
  state: WrapState;
  upstream?: string;
  upstreamKey?: string;
  getPrograms?: () => StretchProgram[];
};

function corsOrigin(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    return { "access-control-allow-origin": origin, vary: "origin" };
  }
  return {};
}

function programs(opts: ProxyOpts): StretchProgram[] {
  return opts.getPrograms?.() ?? opts.state.programs.filter((p) => p.manifest);
}

export async function handleChatCompletions(req: Request, opts: ProxyOpts): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: { message: "invalid json" } }, { status: 400 });
  }
  const live = programs(opts);
  const wantsStream = Boolean(body.stream);
  const clientTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (wantsStream && (!live.length || !clientTools)) {
    const upstream = opts.upstream || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const key =
      opts.upstreamKey ||
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
      process.env.OPENAI_API_KEY ||
      "";
    const fn = opts.state.opts.fetch ?? fetch;
    try {
      const upstreamRes = await fn(`${upstream.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: key ? `Bearer ${key}` : "", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return new Response(upstreamRes.body, { status: upstreamRes.status, headers: { "content-type": upstreamRes.headers.get("content-type") || "text/event-stream" } });
    } catch {
      return Response.json({ error: { message: "upstream unavailable", fail_open: true } }, { status: 502 });
    }
  }
  const steeredBody = { ...body, stream: false, tools: injectTools(body.tools, live) };
  const upstream = opts.upstream || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const key =
    opts.upstreamKey ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    process.env.OPENAI_API_KEY ||
    "";
  const url = `${upstream.replace(/\/$/, "")}/chat/completions`;
  const fn = opts.state.opts.fetch ?? fetch;
  let upstreamRes: Response;
  try {
    upstreamRes = await fn(url, {
      method: "POST",
      headers: {
        authorization: key ? `Bearer ${key}` : "",
        "content-type": "application/json",
      },
      body: JSON.stringify(steeredBody),
    });
  } catch {
    return Response.json({ error: { message: "upstream unavailable", fail_open: true } }, { status: 502 });
  }
  if (!upstreamRes.ok) {
    return new Response(upstreamRes.body, { status: upstreamRes.status, headers: { "content-type": "application/json" } });
  }
  const json = (await upstreamRes.json()) as {
    choices?: Array<{ message?: { tool_calls?: unknown; content?: unknown } }>;
  };
  const choice = json.choices?.[0]?.message;
  if (choice && Array.isArray(choice.tool_calls)) {
    choice.tool_calls = steerToolCalls(choice.tool_calls as never, live);
  }
  if (wantsStream) {
    return new Response(asStreamChunks(json), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...corsOrigin(req) },
    });
  }
  return Response.json(json, { headers: corsOrigin(req) });
}

/**
 * Re-frame a completed, non-streaming response as the SSE a streaming client
 * expects.
 *
 * When the client asks for a stream *and* sends tools, the request is forced
 * non-streaming upstream so the tool calls can be steered before the client
 * sees them. What came back was the `chat.completion` object wrapped in one
 * `data:` line — but a streaming client reads `choices[].delta`, not
 * `choices[].message`, so `delta` was undefined and content and tool calls
 * both arrived empty. Any OpenAI-SDK client doing `stream: true` with a tool
 * list got nothing at all.
 *
 * The shape below is what a real stream ends with: one chunk carrying the
 * content and tool calls as a delta, one carrying the finish reason, then
 * [DONE].
 */
function asStreamChunks(json: Record<string, unknown>): string {
  const j = json as {
    id?: string;
    created?: number;
    model?: string;
    choices?: Array<{ index?: number; message?: Record<string, unknown>; finish_reason?: string }>;
  };
  const base = {
    id: j.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: j.created ?? Math.floor(Date.now() / 1000),
    model: j.model ?? "",
  };
  const lines: string[] = [];
  const choices = j.choices?.length ? j.choices : [{ index: 0, message: {}, finish_reason: "stop" }];
  for (const [i, c] of choices.entries()) {
    const index = c.index ?? i;
    const { role, content, tool_calls, ...rest } = (c.message ?? {}) as Record<string, unknown>;
    const delta: Record<string, unknown> = { role: role ?? "assistant", ...rest };
    if (content !== undefined && content !== null) delta.content = content;
    if (Array.isArray(tool_calls)) {
      // Streamed tool calls carry an index; a non-streaming response does not.
      delta.tool_calls = tool_calls.map((t, k) => ({ index: k, ...(t as Record<string, unknown>) }));
    }
    lines.push(`data: ${JSON.stringify({ ...base, choices: [{ index, delta, finish_reason: null }] })}\n\n`);
    lines.push(
      `data: ${JSON.stringify({ ...base, choices: [{ index, delta: {}, finish_reason: c.finish_reason ?? "stop" }] })}\n\n`,
    );
  }
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

export function health(): Response {
  return Response.json({ ok: true, service: "eden-wrap" });
}

export { compiledSchema };
