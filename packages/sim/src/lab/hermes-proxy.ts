/**
 * Hermes' model endpoint in `hermes-ab.ts` (`/s/<stream>/v1/…`), on its own so it can be tested without a model.
 *
 * A chat completion goes upstream (OpenRouter) through the given `fetch` (the run's pacer: rate, cap, 429 backoff),
 * with the usage accounting and provider preferences added and `max_tokens` held to the agent's allowance. It is
 * reserved against the budget at its worst case before it is sent and settled exactly once at its reported cost: when
 * a JSON reply arrives, when a stream ends, fails or is cancelled (Hermes may stop reading a stream it has finished
 * with), or when the request fails. Its tokens, cost, first token and end go on the running task's timeline and
 * record; a failed request stays in the record with an `error` and does not count as a model call. A request outside
 * any task is an orphan. Anything else Hermes asks the endpoint (the model list) is forwarded without the key.
 *
 * The key is added to the upstream request's header only: never to the forwarded body, never to what Hermes gets
 * back (an upstream error that quotes it is redacted).
 */
import type { Timeline } from "./pi-timeline";

/** One model request as a task's record keeps it. */
export interface RequestRecord {
  startMs: number;
  firstTokenMs: number | null;
  endMs: number;
  in: number;
  out: number;
  cost: number;
  /** A failed request (network, HTTP status, broken stream): not a model call. */
  error?: string;
  /** Hermes stopped reading the stream before its end: still a model call, booked with what had arrived. */
  cancelled?: boolean;
}

/** The running task, as the proxy books onto it. */
export interface ProxyTask {
  tl: Timeline;
  record: { task: string; requests: RequestRecord[] };
  r: { modelCalls: number; promptTokens: number; completionTokens: number; costUsd: number };
}

/** The usage a chat completion reports: a JSON body, or the last SSE chunk carrying `usage`. */
export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
}

export interface ProxyOptions {
  key: string;
  /** Every chat completion goes through it (the pacer's fetch). */
  fetch: typeof fetch;
  /** For the endpoint's other routes (no key, not paced). Default: the global fetch. */
  publicFetch?: typeof fetch;
  /** Default https://openrouter.ai/api/v1. */
  upstream?: string;
  model: string;
  maxTokens: number;
  /** Added to every forwarded body (the run's provider preferences). */
  extraBody?: Record<string, unknown>;
  /** Reserves a worst case; throws when the budget cannot take it. */
  reserve(est: number): void;
  /** Gives back a reservation and books the real cost. */
  settle(est: number, cost: number): void;
  /** A request's worst-case dollars from its input characters and output tokens, at the list price. */
  price(inputChars: number, outputTokens: number): number;
  isCapError?(e: unknown): boolean;
  /** Each forwarded body, for checking prompts (`--dump`). */
  dump?(line: { task: string | null; body: unknown }): void;
  onOrphan?(): void;
  /** Upstream timeout, ms (default 120 s). */
  timeoutMs?: number;
}

const jsonError = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });

export function modelProxy(o: ProxyOptions) {
  const base = o.upstream ?? "https://openrouter.ai/api/v1";
  const redact = (text: string) => (o.key ? text.split(o.key).join("[redacted]") : text);
  return async (path: string, req: Request, running: () => ProxyTask | null): Promise<Response> => {
    const upstream = `${base}/${path}`;
    if (!(req.method === "POST" && path === "chat/completions")) {
      const res = await (o.publicFetch ?? fetch)(upstream, { method: req.method });
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") ?? "" },
      });
    }
    let body: Record<string, unknown>;
    try {
      const parsed = (await req.json()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return jsonError(400, "body must be an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return jsonError(400, "body must be JSON");
    }
    const t = running();
    if (!t) o.onOrphan?.();
    const asked = typeof body.max_tokens === "number" ? body.max_tokens : o.maxTokens;
    const sent: Record<string, unknown> = {
      ...body,
      model: o.model,
      max_tokens: Math.min(asked, o.maxTokens),
      usage: { include: true },
      ...o.extraBody,
    };
    delete sent.max_completion_tokens;
    o.dump?.({ task: t?.record.task ?? null, body: sent });
    const est = o.price(JSON.stringify(body.messages ?? "").length, o.maxTokens);
    try {
      o.reserve(est);
    } catch (e) {
      return jsonError(402, e instanceof Error ? e.message : "budget");
    }
    const at = performance.now();
    const turn = (t?.record.requests.length ?? 0) + 1;
    const span = t?.tl.begin("model.request", "model", "path", { turn });
    let first: number | null = null;
    let booked = false;
    /** Settles the reservation and books the request, once, whatever ends it. */
    const book = (usage: Usage | undefined, outcome: { error?: string; cancelled?: boolean } = {}) => {
      if (booked) return;
      booked = true;
      const inTok = usage?.prompt_tokens ?? 0;
      const outTok = usage?.completion_tokens ?? 0;
      const cost = usage?.cost ?? (usage ? o.price(inTok * 4, outTok) : 0);
      o.settle(est, cost);
      if (!t || span === undefined) return;
      const end = performance.now();
      if (!outcome.error) t.r.modelCalls++;
      t.r.promptTokens += inTok;
      t.r.completionTokens += outTok;
      t.r.costUsd += cost;
      t.tl.end(span, { in: inTok, out: outTok, cost, ...outcome });
      t.record.requests.push({
        startMs: t.tl.at(at),
        firstTokenMs: first === null ? null : Math.round(first - at),
        endMs: t.tl.at(end),
        in: inTok,
        out: outTok,
        cost,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.cancelled ? { cancelled: true } : {}),
      });
    };
    let res: Response;
    try {
      res = await o.fetch(upstream, {
        method: "POST",
        headers: { authorization: `Bearer ${o.key}`, "content-type": "application/json" },
        body: JSON.stringify(sent),
        signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
      });
    } catch (e) {
      book(undefined, { error: e instanceof Error ? e.name : "error" });
      return jsonError(503, o.isCapError?.(e) ? "request cap reached" : "upstream failed");
    }
    const type = res.headers.get("content-type") ?? "application/json";
    if (!res.ok || !res.body) {
      const text = redact(await res.text().catch(() => ""));
      book(undefined, { error: `http ${res.status}` });
      return new Response(text, { status: res.status, headers: { "content-type": type } });
    }
    if (!type.includes("text/event-stream")) {
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        book(undefined, { error: e instanceof Error ? e.name : "read error" });
        return jsonError(503, "upstream failed");
      }
      first = performance.now();
      let usage: Usage | undefined;
      try {
        usage = (JSON.parse(text) as { usage?: Usage }).usage;
      } catch {}
      book(usage);
      return new Response(text, { status: res.status, headers: { "content-type": type } });
    }
    // A stream: passed through as it arrives, read on the side for the first token and the final usage.
    let usage: Usage | undefined;
    let buffer = "";
    const decoder = new TextDecoder();
    const read = (chunk: Uint8Array) => {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:") || line === "data: [DONE]") continue;
        try {
          const c = JSON.parse(line.slice(5)) as {
            usage?: Usage;
            choices?: { delta?: { content?: string; tool_calls?: unknown[]; reasoning?: string } }[];
          };
          const d = c.choices?.[0]?.delta;
          if (first === null && d && (d.content || d.tool_calls?.length || d.reasoning)) {
            first = performance.now();
            t?.tl.point("model.first-token", { turn }, first);
          }
          if (c.usage) usage = c.usage;
        } catch {}
      }
    };
    const reader = res.body.getReader();
    const passed = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            book(usage);
            ctl.close();
            return;
          }
          read(value);
          ctl.enqueue(value);
        } catch (e) {
          book(usage, { error: e instanceof Error ? e.name : "stream error" });
          ctl.error(e);
        }
      },
      cancel(reason) {
        book(usage, { cancelled: true });
        return reader.cancel(reason);
      },
    });
    return new Response(passed, { status: res.status, headers: { "content-type": type } });
  };
}
