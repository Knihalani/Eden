import { IslandReply, type IslandCaller } from "@eden/ir";
import { islandUsage } from "./usage";

export const PROVIDER_BATCH_CENTS = 0.5;

export type IslandBatchOpts = {
  fetch?: typeof fetch;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  coalesceMs?: number;
};

export function islandBatchUrl(baseURL?: string | null): string {
  const base = (baseURL || "https://api.openai.com/v1").replace(/\/$/, "");
  return `${base}/messages/batches`;
}

export function canUseProviderBatch(opts: IslandBatchOpts = {}): boolean {
  if (opts.fetch) return true;
  const base = (opts.baseURL || "").replace(/\/$/, "") || "https://api.openai.com/v1";
  return !/api\.openai\.com/i.test(base) && !/api\.anthropic\.com/i.test(base);
}

type IslandReq = Parameters<IslandCaller>[0];

type Pending = {
  req: IslandReq;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

export function withIslandBatch(base: IslandCaller, opts: IslandBatchOpts = {}): IslandCaller {
  const pending: Pending[] = [];
  let scheduled = false;

  const callBase = async (item: Pending): Promise<void> => { try { item.resolve(await base((({ wait: _wait, ...rest }) => rest)(item.req))); } catch (err) { item.reject(err); } };
  const settle = async (items: Pending[]): Promise<void> => {
    if (items.length === 0) return;
    if (items.length === 1 || !canUseProviderBatch(opts)) {
      await Promise.all(items.map(callBase));
      return;
    }
    try {
      const replies = await submitBatch(
        items.map((item) => item.req),
        opts,
      );
      await Promise.all(items.map((item, i) => replies[i] ? Promise.resolve(item.resolve(replies[i])) : callBase(item)));
    } catch (err) {
      if (items.some((item) => item.req.signal?.aborted) || (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message)))) {
        for (const item of items) item.reject(err);
        return;
      }
      await Promise.all(items.map(callBase));
    }
  };

  return (req) => {
    if (req.pinned === true) return Promise.reject(new Error("pinned island miss"));
    if (process.env.EDEN_ISLAND_BATCH === "0" || req.wait !== true) return base((({ wait: _wait, ...rest }) => rest)(req));
    if (req.signal?.aborted) return Promise.reject(new Error("island aborted"));
    return new Promise((resolve, reject) => {
      const item: Pending = { req, resolve, reject };
      pending.push(item);
      const onAbort = () => {
        const idx = pending.indexOf(item);
        if (idx >= 0) pending.splice(idx, 1);
        reject(req.signal?.reason ?? new Error("island aborted"));
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      if (!scheduled) {
        scheduled = true;
        const ms = opts.coalesceMs ?? 0;
        if (ms <= 0) queueMicrotask(() => { scheduled = false; const items = pending.splice(0); void settle(items); });
        else setTimeout(() => { scheduled = false; const items = pending.splice(0); void settle(items); }, ms);
      }
    });
  };
}

async function submitBatch(reqs: IslandReq[], opts: IslandBatchOpts): Promise<Array<IslandReply | undefined>> {
  const fn = opts.fetch ?? fetch;
  const key = opts.apiKey || process.env.OPENAI_API_KEY || "";
  const model = opts.model || "gpt-5.6-luna";
  const signals = reqs.map((r) => r.signal).filter((s): s is AbortSignal => Boolean(s));
  const env = Number(process.env.EDEN_ISLAND_MS);
  const timeout = AbortSignal.timeout(Number.isFinite(env) && env > 0 ? Math.min(600_000, env) : 30_000);
  const signal = signals.length > 0 ? AbortSignal.any([...signals, timeout]) : timeout;
  const res = await fn(islandBatchUrl(opts.baseURL), {
    method: "POST",
    headers: { authorization: key ? `Bearer ${key}` : "", "content-type": "application/json" },
    body: JSON.stringify({
      requests: reqs.map((r, i) => ({
        custom_id: String(i),
        params: {
          model,
          max_tokens: 1024,
          temperature: 0,
          stream: false,
          system: `${r.system}\nReturn JSON matching ${JSON.stringify(r.outputSchema)}.`,
          messages: [{ role: "user", content: JSON.stringify(r.input) }],
        },
      })),
    }),
    signal,
  });
  if (!res.ok) throw new Error(`island batch ${res.status}`);
  const json = (await res.json()) as unknown;
  const parsed = reqs.map((_, i) => parseBatchResult(json, String(i)));
  if (parsed.some((row) => row)) return parsed;
  const id = json && typeof json === "object" && typeof (json as { id?: unknown }).id === "string" && (json as { id: string }).id.length > 0 ? (json as { id: string }).id : undefined;
  if (!id) return parsed;
  const statusUrl = `${islandBatchUrl(opts.baseURL)}/${encodeURIComponent(id)}`;
  const resultsUrl = `${statusUrl}/results`;
  const headers = { authorization: key ? `Bearer ${key}` : "", "content-type": "application/json" };
  let empty = 0;
  while (!signal.aborted) {
    const pollEnv = Number(process.env.EDEN_ISLAND_BATCH_POLL_MS);
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason ?? new Error("island aborted"));
      const t = setTimeout(resolve, Number.isFinite(pollEnv) && pollEnv > 0 ? Math.min(2_000, pollEnv) : 20);
      signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason ?? new Error("island aborted")); }, { once: true });
    });
    for (const url of [statusUrl, resultsUrl]) {
      let pollRes: Response;
      try {
        pollRes = await fn(url, { method: "GET", headers, signal });
      } catch {
        return reqs.map(() => undefined);
      }
      if (!pollRes.ok) {
        empty++;
        if (empty >= 2) return reqs.map(() => undefined);
        continue;
      }
      const text = await pollRes.text();
      const trimmed = text.trim();
      let pollJson: unknown = {};
      if (trimmed) {
        try {
          pollJson = JSON.parse(trimmed) as unknown;
        } catch {
          pollJson = { results: trimmed };
        }
      }
      const ready = ((rows) => (rows.every((row) => row) ? (rows as IslandReply[]) : undefined))(reqs.map((_, i) => parseBatchResult(pollJson, String(i))));
      if (ready) return ready;
    }
    empty++;
    if (empty >= 8) return reqs.map(() => undefined);
  }
  return reqs.map(() => undefined);
}

function parseBatchResult(json: unknown, customId: string): IslandReply | undefined {
  if (!json || typeof json !== "object") return undefined;
  const obj = json as Record<string, unknown>;
  const raw = obj.results ?? obj.requests;
  const rows: Array<Record<string, unknown>> = Array.isArray(raw)
    ? raw.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
    : typeof raw === "string"
      ? raw.split("\n").map((line) => { const t = line.trim(); if (!t) return undefined; try { return JSON.parse(t) as unknown; } catch { return undefined; } }).filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
      : [];
  const row = rows.find((r) => String(r.custom_id ?? "") === customId) ?? (rows.length === 1 && customId === "0" ? rows[0] : undefined);
  if (!row) return undefined;
  let text: string | undefined;
  if (typeof row.content === "string") text = row.content;
  else {
    const from = row.result && typeof row.result === "object" ? (row.result as Record<string, unknown>) : row;
    if (from.type !== "errored" && from.type !== "canceled" && from.type !== "expired") {
      const message =
        (from.message && typeof from.message === "object" ? (from.message as Record<string, unknown>) : undefined) ??
        (from.response && typeof from.response === "object" ? (from.response as Record<string, unknown>) : undefined) ??
        from;
      const content = message.content;
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        const joined = content.map((part) => typeof part === "string" ? part : part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join("");
        if (joined) text = joined;
      }
      if (text == null) {
        const choices = message.choices;
        if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
          const choice = choices[0] as Record<string, unknown>;
          const nested = choice.message && typeof choice.message === "object" ? (choice.message as Record<string, unknown>) : choice;
          if (typeof nested.content === "string") text = nested.content;
        }
      }
    }
  }
  if (text == null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = row.result && typeof row.result === "object" ? (row.result as Record<string, unknown>) : row;
  const usageRaw = row.usage ?? result.usage ?? (result.message && typeof result.message === "object" ? (result.message as Record<string, unknown>).usage : undefined);
  return new IslandReply(parsed, islandUsage(usageRaw, true)!);
}
