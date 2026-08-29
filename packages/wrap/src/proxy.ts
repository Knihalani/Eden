import type { StretchProgram } from "@eden/ir";
import { compiledSchema, injectTools, steerToolCalls } from "./steer";
import { noteJitUsed, selectForRequest } from "./intent";
import { recordCompletion, tapSseUsage, withStreamUsage } from "./usage";
import { filterCanary, type WrapState } from "./wrap-tools";
import { killAfterWarningEnabled } from "./guard";
import { turnBoundary } from "./speculate";

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
  // A throwing program source is degraded to "nothing live": the request
  // proceeds unsteered rather than failing.
  try {
    return opts.getPrograms?.() ?? opts.state.programs.filter((p) => p.manifest);
  } catch {
    return [];
  }
}

function upstreamChat(opts: ProxyOpts, req: Request): { url: string; key: string; fn: typeof fetch; timeout: number } {
  const base = (opts.upstream || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  // Generous by default — completions and streams legitimately run minutes —
  // but bounded, so a hung upstream is an error the client can see rather than
  // a request that never returns.
  const env = Number(process.env.EDEN_UPSTREAM_TIMEOUT_MS);
  return {
    url: `${base}/chat/completions`,
    key:
      opts.upstreamKey ||
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
      process.env.OPENAI_API_KEY ||
      "",
    fn: opts.state.opts.fetch ?? fetch,
    timeout: Number.isFinite(env) && env > 0 ? Math.min(600_000, env) : 300_000,
  };
}

export async function handleChatCompletions(req: Request, opts: ProxyOpts): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: { message: "invalid json" } }, { status: 400 });
  }
  const live = filterCanary(programs(opts), opts.state.sessionId);
  // Think-time of this request: start a read-only stretch from the last turn
  // so tool latency overlaps generation. Fail-open; mutating never starts.
  safely(() => {
    const last = opts.state.run.events.at(-1);
    turnBoundary(opts.state, { lastTool: last?.name, lastArgs: last?.args, input: last?.args });
  }, undefined);
  // A tripped kill switch must never take the user's traffic down with it
  // (prime directive: Eden never blocks the agent). It only loses its privilege
  // to steer: requests pass straight through, untouched, while the condition
  // stays visible on the dashboard.
  const steerable =
    !killAfterWarningEnabled(opts.state.opts) || opts.state.run.firstWarningAt == null;
  const wantsStream = Boolean(body.stream);
  // Opt-in means the client sent a tools ARRAY — an empty array has opted into
  // function calling and is exactly who compiled tools serve (see injectTools).
  // A missing tools field has not.
  const clientOptedIn = Array.isArray(body.tools);
  const { url, key, fn, timeout } = upstreamChat(opts, req);
  const shouldSteer = steerable && live.length > 0 && clientOptedIn;
  if (wantsStream && !shouldSteer) {
    try {
      const upstreamRes = await fn(url, {
        method: "POST",
        headers: { authorization: key ? `Bearer ${key}` : "", "content-type": "application/json" },
        body: JSON.stringify(withStreamUsage(body)),
        signal: AbortSignal.timeout(timeout),
      });
      const src = upstreamRes.body;
      const headers = { "content-type": upstreamRes.headers.get("content-type") || "text/event-stream" };
      if (!src || !upstreamRes.ok) {
        return new Response(src, { status: upstreamRes.status, headers });
      }
      return new Response(tapSseUsage(src, opts.state.run), { status: upstreamRes.status, headers });
    } catch {
      return Response.json({ error: { message: "upstream unavailable", fail_open: true } }, { status: 502 });
    }
  }
  const injected = safely(
    () => (shouldSteer ? injectTools(body.tools, selectForRequest(live, body.messages as unknown[] | undefined, opts.state.jit)) : body.tools),
    body.tools,
  );
  const steeredBody = { ...body, stream: false, tools: injected };
  let upstreamRes: Response;
  try {
    upstreamRes = await fn(url, {
      method: "POST",
      headers: {
        authorization: key ? `Bearer ${key}` : "",
        "content-type": "application/json",
      },
      body: JSON.stringify(steeredBody),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    return Response.json({ error: { message: "upstream unavailable", fail_open: true } }, { status: 502 });
  }
  if (!upstreamRes.ok) {
    return new Response(upstreamRes.body, { status: upstreamRes.status, headers: { "content-type": "application/json" } });
  }
  // Read once as text so a malformed upstream body can be handed back verbatim
  // rather than turned into an Eden-shaped 500. Everything below — usage
  // recording, steering — is a bonus on top of a response that already
  // succeeded; none of it may fail the response.
  const text = await upstreamRes.text();
  let json: {
    choices?: Array<{ message?: { tool_calls?: unknown; content?: unknown } }>;
    usage?: unknown;
  };
  try {
    json = JSON.parse(text);
  } catch {
    return new Response(text, {
      status: upstreamRes.status,
      headers: { "content-type": upstreamRes.headers.get("content-type") || "application/json" },
    });
  }
  safely(() => recordCompletion(opts.state.run, json as Record<string, unknown>), undefined);
  // Steer only when this request was steerable — an unsteered passthrough
  // (tripped kill switch, no live programs, client sent no tools) must return
  // the model's own tool calls untouched.
  const choice = json.choices?.[0]?.message;
  if (shouldSteer && choice && Array.isArray(choice.tool_calls)) {
    safely(
      () => {
        choice.tool_calls = steerToolCalls(choice.tool_calls as never, live);
        const names = (choice.tool_calls as Array<{ function?: { name?: string }; name?: string }>).map(
          (c) => c.function?.name || c.name || "",
        );
        noteJitUsed(opts.state.jit, names);
      },
      undefined,
    );
  }
  if (wantsStream) {
    return new Response(safely(() => asStreamChunks(json as Record<string, unknown>), text), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...corsOrigin(req) },
    });
  }
  return safely(
    () => Response.json(json, { headers: corsOrigin(req) }),
    new Response(text, {
      status: upstreamRes.status,
      headers: { "content-type": upstreamRes.headers.get("content-type") || "application/json" },
    }),
  );
}

/**
 * Run an Eden-side computation, degrading to `fallback` on any throw. Same
 * contract as the wrap-tools helper of the same name: nothing Eden computes
 * about a request may fail the request.
 */
function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
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
    usage?: unknown;
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
    const finish: Record<string, unknown> = { ...base, choices: [{ index, delta: {}, finish_reason: c.finish_reason ?? "stop" }] };
    if (j.usage != null && i === choices.length - 1) finish.usage = j.usage;
    lines.push(`data: ${JSON.stringify(finish)}\n\n`);
  }
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

export function health(): Response {
  return Response.json({ ok: true, service: "eden-wrap" });
}

export { compiledSchema };
