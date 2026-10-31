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
 */

/** $ per token: input, output, and a cached input token (cache read). */
export type Price = readonly [input: number, output: number, cacheRead: number];

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

export interface PricedRequest {
  /** Input tokens, cached ones included (OpenRouter's `prompt_tokens`). */
  in: number;
  out: number;
  /** As billed (OpenRouter's own cost on the final chunk). */
  cost: number;
  /** Of `in`, the tokens read from the endpoint's prompt cache (`prompt_tokens_details.cached_tokens`), if recorded. */
  cached?: number;
}

/** What one request costs at one price. */
export function requestUsd(r: PricedRequest, [pi, po, pc]: Price): number {
  const cached = Math.min(r.cached ?? 0, r.in);
  return (r.in - cached) * pi + cached * pc + r.out * po;
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
