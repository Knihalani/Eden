import type { IslandCaller } from "@eden/ir";
import { IslandReply, type IslandUsage } from "@eden/ir";
import { parseCacheTokens, parseUsage } from "./usage";

export const PROVIDER_BATCH_CENTS = 0.5;

export function islandBatchEnabled(): boolean {
  return process.env.EDEN_ISLAND_BATCH !== "0";
}

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
  if (/api\.openai\.com/i.test(base)) return false;
  if (/api\.anthropic\.com/i.test(base)) return false;
  return true;
}

type IslandReq = Parameters<IslandCaller>[0];

type Pending = {
  req: IslandReq;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

function islandTimeoutMs(): number {
  const env = Number(process.env.EDEN_ISLAND_MS);
  return Number.isFinite(env) && env > 0 ? Math.min(600_000, env) : 30_000;
}

function syncArgs(req: IslandReq): IslandReq {
  const { wait: _wait, ...rest } = req;
  return rest;
}

export function withIslandBatch(base: IslandCaller, opts: IslandBatchOpts = {}): IslandCaller {
  const pending: Pending[] = [];
  let scheduled = false;

  const flush = (): void => {
    scheduled = false;
    const items = pending.splice(0);
    void settle(items);
  };

  const settle = async (items: Pending[]): Promise<void> => {
    if (items.length === 0) return;
    if (items.length === 1) {
      const only = items[0]!;
      try {
        only.resolve(await base(syncArgs(only.req)));
      } catch (err) {
        only.reject(err);
      }
      return;
    }
    if (!canUseProviderBatch(opts)) {
      await Promise.all(
        items.map(async (item) => {
          try {
            item.resolve(await base(syncArgs(item.req)));
          } catch (err) {
            item.reject(err);
          }
        }),
      );
      return;
    }
    try {
      const replies = await submitBatch(
        items.map((item) => item.req),
        opts,
      );
      await Promise.all(
        items.map(async (item, i) => {
          const reply = replies[i];
          if (reply) {
            item.resolve(reply);
            return;
          }
          try {
            item.resolve(await base(syncArgs(item.req)));
          } catch (err) {
            item.reject(err);
          }
        }),
      );
    } catch (err) {
      if (batchAborted(err, items)) {
        for (const item of items) item.reject(err);
        return;
      }
      await Promise.all(
        items.map(async (item) => {
          try {
            item.resolve(await base(syncArgs(item.req)));
          } catch (fallbackErr) {
            item.reject(fallbackErr);
          }
        }),
      );
    }
  };

  return (req) => {
    if (req.pinned === true) return Promise.reject(new Error("pinned island miss"));
    if (!islandBatchEnabled() || req.wait !== true) return base(syncArgs(req));
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
        if (ms <= 0) queueMicrotask(flush);
        else setTimeout(flush, ms);
      }
    });
  };
}

function batchAborted(err: unknown, items: Pending[]): boolean {
  if (items.some((item) => item.req.signal?.aborted)) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return err instanceof Error && /abort/i.test(err.message);
}

async function submitBatch(reqs: IslandReq[], opts: IslandBatchOpts): Promise<Array<IslandReply | undefined>> {
  const fn = opts.fetch ?? fetch;
  const key = opts.apiKey || process.env.OPENAI_API_KEY || "";
  const model = opts.model || "gpt-5.6-luna";
  const signals = reqs.map((r) => r.signal).filter((s): s is AbortSignal => Boolean(s));
  const timeout = AbortSignal.timeout(islandTimeoutMs());
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
  const first = completeReplies(json, reqs);
  if (first) return first;
  if (reqs.some((_, i) => parseBatchResult(json, String(i)))) {
    return reqs.map((_, i) => parseBatchResult(json, String(i)));
  }
  const id = batchId(json);
  if (!id) return reqs.map((_, i) => parseBatchResult(json, String(i)));
  return pollUntilComplete(fn, opts, id, reqs, signal, key);
}

function completeReplies(json: unknown, reqs: IslandReq[]): IslandReply[] | undefined {
  const rows = reqs.map((_, i) => parseBatchResult(json, String(i)));
  return rows.every((row) => row) ? (rows as IslandReply[]) : undefined;
}

function batchId(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const id = (json as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function pollDelayMs(): number {
  const env = Number(process.env.EDEN_ISLAND_BATCH_POLL_MS);
  return Number.isFinite(env) && env > 0 ? Math.min(2_000, env) : 20;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("island aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("island aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function parsePollBody(res: Response): Promise<unknown> {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const rows = trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return undefined;
        }
      })
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
    return { results: rows };
  }
}

async function pollUntilComplete(
  fn: typeof fetch,
  opts: IslandBatchOpts,
  id: string,
  reqs: IslandReq[],
  signal: AbortSignal,
  key: string,
): Promise<Array<IslandReply | undefined>> {
  const statusUrl = `${islandBatchUrl(opts.baseURL)}/${encodeURIComponent(id)}`;
  const resultsUrl = `${statusUrl}/results`;
  const headers = { authorization: key ? `Bearer ${key}` : "", "content-type": "application/json" };
  let empty = 0;
  while (!signal.aborted) {
    await sleep(pollDelayMs(), signal);
    for (const url of [statusUrl, resultsUrl]) {
      let res: Response;
      try {
        res = await fn(url, { method: "GET", headers, signal });
      } catch {
        return reqs.map(() => undefined);
      }
      if (!res.ok) {
        empty++;
        if (empty >= 2) return reqs.map(() => undefined);
        continue;
      }
      const json = await parsePollBody(res);
      const ready = completeReplies(json, reqs);
      if (ready) return ready;
    }
    empty++;
    if (empty >= 8) return reqs.map(() => undefined);
  }
  return reqs.map(() => undefined);
}

function parseBatchResult(json: unknown, customId: string): IslandReply | undefined {
  const row = findResultRow(json, customId);
  if (!row) return undefined;
  const text = resultText(row);
  if (text == null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const usageRaw = resultUsage(row);
  const u = parseUsage(usageRaw);
  const cache = parseCacheTokens(usageRaw);
  const usage: IslandUsage = {
    prompt_tokens: u?.prompt ?? 0,
    completion_tokens: u?.completion ?? 0,
    batched: true,
    ...(cache
      ? {
          cached_tokens: cache.cached,
          ...(cache.cacheWrite != null ? { cache_write_tokens: cache.cacheWrite } : {}),
          ...(cache.denom != null ? { cache_input_tokens: cache.denom } : {}),
        }
      : {}),
  };
  return new IslandReply(parsed, usage);
}

function findResultRow(json: unknown, customId: string): Record<string, unknown> | undefined {
  if (!json || typeof json !== "object") return undefined;
  const obj = json as Record<string, unknown>;
  const rows = collectResultRows(obj);
  for (const row of rows) {
    if (String(row.custom_id ?? "") === customId) return row;
  }
  if (rows.length === 1 && customId === "0") return rows[0];
  return undefined;
}

function collectResultRows(obj: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = obj.results ?? obj.requests;
  if (Array.isArray(raw)) {
    return raw.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object");
  }
  if (typeof raw === "string") {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object");
  }
  return [];
}

function resultText(row: Record<string, unknown>): string | undefined {
  if (typeof row.content === "string") return row.content;
  const result = row.result && typeof row.result === "object" ? (row.result as Record<string, unknown>) : row;
  if (result.type === "errored" || result.type === "canceled" || result.type === "expired") return undefined;
  const message =
    (result.message && typeof result.message === "object" ? (result.message as Record<string, unknown>) : undefined) ??
    (result.response && typeof result.response === "object" ? (result.response as Record<string, unknown>) : undefined) ??
    result;
  return messageText(message);
}

function messageText(message: Record<string, unknown>): string | undefined {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
    if (text) return text;
  }
  const choices = message.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const choice = choices[0] as Record<string, unknown>;
    const nested = choice.message && typeof choice.message === "object" ? (choice.message as Record<string, unknown>) : choice;
    if (typeof nested.content === "string") return nested.content;
  }
  return undefined;
}

function resultUsage(row: Record<string, unknown>): unknown {
  if (row.usage) return row.usage;
  const result = row.result && typeof row.result === "object" ? (row.result as Record<string, unknown>) : row;
  if (result.usage) return result.usage;
  const message = result.message && typeof result.message === "object" ? (result.message as Record<string, unknown>) : undefined;
  return message?.usage;
}
