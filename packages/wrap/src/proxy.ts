import type { StretchProgram } from "@eden/ir";
import { redact } from "@eden/ir";
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
  const rec = redact({
    model: body.model,
    messages: body.messages,
    tool_choice: body.tool_choice,
    response: choice,
  });
  void rec;
  if (wantsStream) {
    const payload = `data: ${JSON.stringify(json)}\n\ndata: [DONE]\n\n`;
    return new Response(payload, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...corsOrigin(req) },
    });
  }
  return Response.json(json, { headers: corsOrigin(req) });
}

export function health(): Response {
  return Response.json({ ok: true, service: "eden-wrap" });
}

export { compiledSchema };
