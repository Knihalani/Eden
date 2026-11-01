/**
 * Free OpenRouter models for lab runs only (docs/research/edge-intent.md). Eden's production calls ask for providers
 * that collect no data and retain none (`data_collection: "deny"`, `zdr`, D12), and no free endpoint qualifies: a free
 * model is served by providers that may keep prompts. The worlds the lab sends are generated, so nothing in them is
 * user data; this override exists only here, as a `fetch` wrapper around the production client, which is unchanged.
 *
 * Free models are rate-limited per account (about 20 requests a minute, about 1,000 a day, shared by every run), so
 * every request is metered against a ledger file, no request starts once the run's cap is reached, and a 429 or a
 * provider error is retried with backoff.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { OpenRouterModel, type Model } from "@eden/llm";

/** The free models known to serve JSON at the time of writing (docs/research/edge-intent.md). */
export const FREE_MODELS = [
  "nvidia/nemotron-3.5-super-vl:free",
  "nvidia/nemotron-3.5-lightning:free",
  "cohere/north-mini-code:free",
  "dots-studio/dots-3-note-preview:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
] as const;

/** A `fetch` that lets OpenRouter route to endpoints that may retain data: lab only, never product code. */
export function retentionAllowed(inner: typeof fetch = fetch): typeof fetch {
  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.body && typeof init.body === "string") {
      const body = JSON.parse(init.body) as { provider?: Record<string, unknown> };
      body.provider = { ...body.provider, data_collection: "allow", zdr: false };
      init = { ...init, body: JSON.stringify(body) };
    }
    return inner(input, init);
  }) as typeof fetch;
  return wrapped;
}

/** Requests made so far against the ledger (every line is one request, whatever it returned). */
export function freeRequests(ledger: string): number {
  return existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0;
}

export class FreeCapReached extends Error {}

/**
 * A free model, metered: each request (a retry is a request) appends a line to `ledger` first, and none starts once
 * the ledger holds `cap` lines. A 429 or a 5xx is retried up to `retries` times, waiting 4 s, 8 s, 16 s… (capped at
 * 60 s); any other error, or the cap, is thrown.
 */
export function freeModel(options: {
  apiKey: string;
  model: string;
  ledger: string;
  cap: number;
  what: string;
  retries?: number;
  timeoutMs?: number;
}): Model {
  const inner = new OpenRouterModel({
    apiKey: options.apiKey,
    model: options.model,
    zdr: false,
    timeoutMs: options.timeoutMs ?? 120_000,
    fetch: retentionAllowed(),
  });
  return {
    id: inner.id,
    chat: async (req) => {
      for (let attempt = 0; ; attempt++) {
        if (freeRequests(options.ledger) >= options.cap) throw new FreeCapReached(`free request cap ${options.cap}`);
        appendFileSync(
          options.ledger,
          `${JSON.stringify({ at: new Date().toISOString(), what: options.what, model: options.model, attempt })}\n`,
        );
        try {
          return await inner.chat(req);
        } catch (e) {
          const msg = String(e);
          const transient = /openrouter (?:429|5\d\d)|timed? ?out|aborted|fetch failed|ECONNRESET/i.test(msg);
          if (!transient || attempt >= (options.retries ?? 4) || req.signal?.aborted) throw e;
          await Bun.sleep(Math.min(60_000, 4_000 * 2 ** attempt));
        }
      }
    },
  };
}
