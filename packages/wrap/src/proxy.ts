import type { StretchProgram } from "@eden/ir";
import { compiledSchema, extractInput, injectTools, steerToolCalls } from "./steer";
import { noteJitUsed, selectForRequest } from "./intent";
import { recordCompletion, tapSseUsage, withStreamUsage } from "./usage";
import { filterCanary } from "./canary";
import { killAfterWarningEnabled } from "./guard";
import type { WrapState } from "./wrap-tools";
import { processMemory } from "../../../src/index";
import { injectBodyThenObserveTools, stripUpstreamPlaceFields, withOpenFileHeaders } from "./tool-observe";

export type ProxyOpts = {
  state: WrapState;
  upstream?: string;
  upstreamKey?: string;
  getPrograms?: () => StretchProgram[];
  play?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
};

function corsOrigin(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
    return { "access-control-allow-origin": origin, vary: "origin", "access-control-expose-headers": "content-type" };
  }
  return {};
}

function programs(opts: ProxyOpts): StretchProgram[] {
  try {
    return opts.getPrograms?.() ?? opts.state.programs.filter((p) => p.manifest);
  } catch {
    return [];
  }
}

export function isWrapAuthToken(key: string): boolean {
  const t = key.trim();
  if (!t) return false;
  if (t === "eden_dev" || t.startsWith("eden_")) return true;
  const env = (process.env.EDEN_API_KEY || "").trim();
  return env.length > 0 && t === env;
}

export function resolveUpstreamKey(opts: Pick<ProxyOpts, "upstreamKey">, req: Request): string {
  const headerKey =
    req.headers.get("x-openai-api-key")?.trim() ||
    req.headers.get("openai-api-key")?.trim() ||
    "";
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  const configured = (opts.upstreamKey || process.env.OPENAI_API_KEY || "").trim();
  for (const k of [headerKey, configured, bearer]) {
    if (k && !isWrapAuthToken(k)) return k;
  }
  return "";
}

function upstreamChat(opts: ProxyOpts, req: Request): { url: string; key: string; fn: typeof fetch; timeout: number } {
  const base = (opts.upstream || process.env.OPENAI_API_BASE || "https://api.openai.com/v1").replace(/\/$/, "");
  const env = Number(process.env.EDEN_UPSTREAM_TIMEOUT_MS);
  return {
    url: `${base}/chat/completions`,
    key: resolveUpstreamKey(opts, req),
    fn: opts.state.opts.fetch ?? fetch,
    timeout: Number.isFinite(env) && env > 0 ? Math.min(600_000, env) : 300_000,
  };
}

function isNvidiaUrl(url: string): boolean {
  return /nvidia\.com/i.test(url);
}

function upstreamHeaders(url: string, key: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: key ? `Bearer ${key}` : "",
    "content-type": "application/json",
  };
  if (isNvidiaUrl(url)) headers["NVCF-POLL-SECONDS"] = process.env.NVCF_POLL_SECONDS || "20";
  return headers;
}

function nimTuneBody(url: string, body: Record<string, unknown>): Record<string, unknown> {
  if (!isNvidiaUrl(url)) return body;
  const model = String(body.model || "");
  if (!/deepseek-v4-flash/i.test(model)) return body;
  const next: Record<string, unknown> = { ...body };
  const effort = String(next.reasoning_effort || "").toLowerCase();
  if (effort !== "none" && effort !== "high" && effort !== "max") next.reasoning_effort = "none";
  const prev =
    next.chat_template_kwargs && typeof next.chat_template_kwargs === "object"
      ? { ...(next.chat_template_kwargs as Record<string, unknown>) }
      : {};
  if (next.reasoning_effort === "none") {
    prev.thinking = false;
    prev.reasoning_effort = "none";
  }
  next.chat_template_kwargs = prev;
  return next;
}

export function noModelKey(): Response {
  return Response.json({
    id: "eden-failopen",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "eden",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "set OPENAI_API_KEY so wrap can reach the model. An Eden key (eden_dev or eden_…) is wrap auth, not OpenAI.",
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    fail_open: true,
  });
}

function messageText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((m) => {
      if (!m || typeof m !== "object") return "";
      const c = (m as { content?: unknown }).content;
      return typeof c === "string" ? c : "";
    })
    .join("\n");
}

export function argsFromMessages(program: StretchProgram, messages: unknown): Record<string, unknown> {
  const text = messageText(messages);
  const raw: Record<string, unknown> = {};
  const ticket = text.match(/\bT-\d+\b/i);
  if (ticket) raw.id = ticket[0];
  const gh = text.match(/\/(?:issues|pulls|pull)\/(\d+)/i);
  if (gh) {
    raw.issue = gh[1];
    if (!raw.id) raw.id = gh[1];
  }
  return extractInput(program, raw);
}

function compiledAnswer(facts: unknown): Response {
  return Response.json({
    id: "eden-compiled",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "eden",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: typeof facts === "string" ? facts : JSON.stringify(facts) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

export async function handleChatCompletions(req: Request, opts: ProxyOpts): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...corsOrigin(req), "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type, authorization", "access-control-max-age": "86400" } });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: { message: "invalid json" } }, { status: 400 });
  }
  try {
    const header = [req.headers.get("x-eden-open-files"), req.headers.get("x-open-files")].filter(Boolean).join(",");
    body = withOpenFileHeaders(body, header);
  } catch {
    /* header parse fail-open: inject the parsed JSON as-is */
  }
  const live = filterCanary(programs(opts), opts.state.sessionId);
  safely(() => {
    const last = opts.state.run.events.at(-1);
    turnBoundary(opts.state, { lastTool: last?.name, lastArgs: last?.args, input: last?.args });
  }, undefined);
  const steerable =
    !killAfterWarningEnabled(opts.state.opts) || opts.state.run.firstWarningAt == null;
  const wantsStream = Boolean(body.stream);
  const clientOptedIn = Array.isArray(body.tools);
  const msgs = body.messages as unknown[] | undefined;
  const blocked = isWrapAuthToken(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "") && !resolveUpstreamKey(opts, req);
  const picked = steerable
    ? safely(
        () => selectForRequest(live, msgs, blocked ? undefined : opts.state.jit),
        [] as StretchProgram[],
      )
    : [];
  if (blocked) {
    const hit = picked[0];
    if (hit && opts.play) {
      try {
        const facts = await opts.play(hit.name, argsFromMessages(hit, body.messages));
        if (facts !== undefined && facts !== null) return compiledAnswer(facts);
      } catch {
      }
    }
    return noModelKey();
  }
  const { url, key, fn, timeout } = upstreamChat(opts, req);
  const shouldSteer = steerable && live.length > 0 && clientOptedIn;
  if (wantsStream && !shouldSteer) {
    try {
      const upstreamRes = await fn(url, {
        method: "POST",
        headers: upstreamHeaders(url, key),
        body: JSON.stringify(withStreamUsage(nimTuneBody(url, stripUpstreamPlaceFields(injectBodyThenObserveTools(processMemory(), body))))),
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
  const steeredBody = nimTuneBody(
    url,
    stripUpstreamPlaceFields(injectBodyThenObserveTools(processMemory(), { ...body, stream: false, tools: injected })),
  );
  let upstreamRes: Response;
  try {
    upstreamRes = await fn(url, {
      method: "POST",
      headers: upstreamHeaders(url, key),
      body: JSON.stringify(steeredBody),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    return Response.json({ error: { message: "upstream unavailable", fail_open: true } }, { status: 502 });
  }
  if (!upstreamRes.ok) {
    return new Response(upstreamRes.body, { status: upstreamRes.status, headers: { "content-type": "application/json" } });
  }
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

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

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
