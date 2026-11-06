/**
 * Agent cost re-priced at one fixed endpoint, beside the billed cost (econ-research's R3; its `normcost.py` and
 * `routes.py`, here for `pi-ab-report.ts`). OpenRouter spreads one model over many endpoints, up to 10x apart in price,
 * and the mix changed with the condition within one run (more cheap fp4 requests for the runs with fewer tool
 * definitions), so billed cost compares routing as much as conditions. Re-pricing every condition's tokens at the same
 * prices removes that; the inferred endpoint mix shows how much routing moved.
 *
 * Every endpoint caches prompts implicitly and bills a cached input token at its cache-read price, far below its
 * input price. A request that records its cached tokens (`cached`, pi-ab since the econ lab review) is priced so; one
 * that does not (older timelines) is priced as if nothing were cached, so a cache hit is unmatched and its re-priced
 * cost overstates what the fixed endpoint would have billed.
 *
 * Anthropic bills a prompt-cache write too (1.25x input at the 5-minute TTL), so a price may carry a cache-write
 * price; a request that records its written tokens (`cacheWrite`, pi-ab's Anthropic agent) is priced so. A cache-
 * neutral price (`cacheNeutral`) bills cached and written tokens as plain input: two arms of a pair that race for one
 * prompt cache (pi-ab runs its conditions concurrently with the same system prompt) then cost what their tokens
 * cost, not who wrote the cache first (D171).
 */

/** $ per token: input, output, a cached input token (cache read) and, if billed apart, a cache-write token. */
export type Price = readonly [input: number, output: number, cacheRead: number, cacheWrite?: number];

/**
 * Endpoint prices per model, from OpenRouter's endpoints API (`/api/v1/models/<id>/endpoints`), read 2026-10-31.
 * Endpoints with the same three prices share one entry (`Z.AI list` is the maker's price, which about twenty
 * endpoints charge). Prices move: an endpoint is inferred only within 3% of its listed price, the rest is unmatched.
 */
export const ENDPOINT_PRICES: Record<string, Record<string, Price>> = {
  "z-ai/glm-5.3-flash": {
    OpenInference: [1.72e-8, 3.55e-8, 1.57e-8],
    Relace: [1.63e-8, 1.479e-7, 1.63e-8],
    Morph: [4.2e-8, 3e-7, 1.8e-8],
    "Wafer-us": [4.4e-8, 2e-7, 4.3e-8],
    Wafer: [5.4e-8, 2e-7, 5.3e-8],
    Darkbloom: [6.5e-8, 1.8e-7, 1.2e-8],
    GMI: [7.5e-8, 2.5e-7, 1.5e-8],
    NearAI: [8e-8, 5e-7, 1.2e-8],
    Novita: [8.4e-8, 2.8e-7, 1.68e-8],
    StreamLake: [8.85e-8, 2.95e-7, 1.77e-8],
    InferenceNet: [1.08e-7, 3.5e-7, 3.2e-8],
    Phala: [1.125e-7, 3.75e-7, 2.25e-8],
    DigitalOcean: [1.125e-7, 3.75e-7, 3e-8],
    Reka: [1.2e-7, 3e-7, 3e-8],
    CoreWeave: [1.2e-7, 3.8e-7, 2e-8],
    Makora: [1.4e-7, 4.7e-7, 2.4e-8],
    "Z.AI list": [1.5e-7, 5e-7, 3e-8],
    Inceptron: [1.9e-7, 6e-7, 6e-8],
    "Fireworks-us/Sail-us": [2.25e-7, 7.5e-7, 4.5e-8],
    "Sail fp4": [3.5e-7, 1.25e-6, 4.5e-8],
  },
};

/** The fixed prices a report re-prices at: the model maker's list price, and a cheap endpoint that is often used. */
export const FIXED_PRICES: Record<string, Price> = {
  "Z.AI list": [1.5e-7, 5e-7, 3e-8],
  "Wafer-us": [4.4e-8, 2e-7, 4.3e-8],
};

/**
 * A model's own list price, for a model billed at one price (Anthropic direct) or for a report's cache-neutral cost.
 * claude-haiku-5-5: an exact least-squares fit over the 404 agent requests of D159's Pi pair (pi-41, pi-42: zero
 * residual; each task's requests sum to its billed `costUsd`), and `ANTHROPIC_PRICES` in @eden/llm. Prompts above
 * 100k tokens bill 5x there; an agent request is far below that.
 */
export const MODEL_PRICES: Record<string, Price> = {
  "claude-haiku-5-5": [1e-7, 5e-7, 1e-8, 1.25e-7],
  "z-ai/glm-5.3-flash": [1.5e-7, 5e-7, 3e-8],
};

/** The price with cached and cache-write tokens billed as plain input: what the tokens cost with no cache at all. */
export function cacheNeutral([pi, po]: Price): Price {
  return [pi, po, pi, pi];
}

export interface PricedRequest {
  /** Input tokens, cached ones included (OpenRouter's `prompt_tokens`). */
  in: number;
  out: number;
  /** As billed (OpenRouter's own cost on the final chunk). */
  cost: number;
  /** Of `in`, the tokens read from the endpoint's prompt cache (`prompt_tokens_details.cached_tokens`), if recorded. */
  cached?: number;
  /** Of `in`, the tokens written to the prompt cache (Anthropic's `cache_creation_input_tokens`), if recorded. */
  cacheWrite?: number;
}

/** What one request costs at one price; written tokens at the input price when the price has no cache-write price. */
export function requestUsd(r: PricedRequest, [pi, po, pc, pw]: Price): number {
  const cached = Math.min(Math.max(0, r.cached ?? 0), r.in);
  const written = Math.min(Math.max(0, r.cacheWrite ?? 0), r.in - cached);
  return (r.in - cached - written) * pi + cached * pc + written * (pw ?? pi) + r.out * po;
}

/**
 * The endpoint whose prices give the billed cost within `tolerance`; `ambiguous` when two endpoints both do and price
 * the request differently (Reka and CoreWeave share an input price, so an input-heavy request fits both: the nearer
 * one is not evidence), the endpoints' names joined when they price it the same; else `unmatched`.
 */
export function inferEndpoint(
  model: string,
  input: number,
  output: number,
  cost: number,
  options: { cached?: number; tolerance?: number } = {},
): string {
  const table = ENDPOINT_PRICES[model];
  const tolerance = options.tolerance ?? 0.03;
  if (!table || !(cost > 0) || !(input > 0)) return "unmatched";
  const fits = Object.entries(table)
    .map(([name, price]) => ({
      name,
      usd: requestUsd({ in: input, out: output, cost, cached: options.cached }, price),
    }))
    .filter((x) => Math.abs(x.usd - cost) / cost < tolerance);
  if (!fits.length) return "unmatched";
  const lo = Math.min(...fits.map((x) => x.usd));
  const hi = Math.max(...fits.map((x) => x.usd));
  // Within 0.1% the endpoints are the same price for this request: no bill can tell them apart.
  return hi <= lo * 1.001 ? fits.map((x) => x.name).join("/") : "ambiguous";
}

/** What the requests would have cost at one price. */
export function repricedUsd(requests: readonly PricedRequest[], price: Price): number {
  return requests.reduce((n, r) => n + requestUsd(r, price), 0);
}

/** Each inferred endpoint's share of the requests, largest first. */
export function endpointMix(model: string, requests: readonly PricedRequest[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of requests) {
    const e = inferEndpoint(model, r.in, r.out, r.cost, { cached: r.cached });
    counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  return [...counts]
    .map(([e, n]): [string, number] => [e, n / requests.length])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
