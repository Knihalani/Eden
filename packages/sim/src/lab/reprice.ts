/**
 * Agent cost re-priced at one fixed endpoint, beside the billed cost (econ-research's R3; its `normcost.py` and
 * `routes.py`, here for `pi-ab-report.ts`). OpenRouter spreads one model over many endpoints, up to 10x apart in price,
 * and the mix changed with the condition within one run (more cheap fp4 requests for the runs with fewer tool
 * definitions), so billed cost compares routing as much as conditions. Re-pricing every condition's tokens at the same
 * prices removes that; the inferred endpoint mix shows how much routing moved.
 */

/** $ per token, input and output. */
export type Price = readonly [input: number, output: number];

/**
 * Endpoint prices per model, from OpenRouter's endpoints API (`/api/v1/models/<id>/endpoints`), read 2026-10-31.
 * Prices move: an endpoint is inferred only within 3% of its listed price, the rest counts as unmatched.
 */
export const ENDPOINT_PRICES: Record<string, Record<string, Price>> = {
  "z-ai/glm-5.3-flash": {
    OpenInference: [1.72e-8, 3.55e-8],
    Relace: [1.63e-8, 1.479e-7],
    Morph: [4.2e-8, 3e-7],
    "Wafer-us": [4.4e-8, 2e-7],
    Wafer: [5.4e-8, 2e-7],
    Darkbloom: [6.5e-8, 1.8e-7],
    GMI: [7.5e-8, 2.5e-7],
    NearAI: [8e-8, 5e-7],
    Novita: [8.4e-8, 2.8e-7],
    StreamLake: [8.85e-8, 2.95e-7],
    InferenceNet: [1.08e-7, 3.5e-7],
    "Phala/DO": [1.125e-7, 3.75e-7],
    CoreWeave: [1.2e-7, 3.8e-7],
    "Z.AI list": [1.5e-7, 5e-7],
  },
};

/** The fixed prices a report re-prices at: the model maker's list price, and a cheap endpoint that is often used. */
export const FIXED_PRICES: Record<string, Price> = {
  "Z.AI list": [1.5e-7, 5e-7],
  "Wafer-us": [4.4e-8, 2e-7],
};

export interface PricedRequest {
  in: number;
  out: number;
  /** As billed (OpenRouter's own cost on the final chunk). */
  cost: number;
}

/** The endpoint whose prices give the billed cost within `tolerance`, or `unmatched`. */
export function inferEndpoint(model: string, input: number, output: number, cost: number, tolerance = 0.03): string {
  const table = ENDPOINT_PRICES[model];
  if (!table || !(cost > 0) || !(input > 0)) return "unmatched";
  let best = "unmatched";
  let err = Infinity;
  for (const [name, [pi, po]] of Object.entries(table)) {
    const e = Math.abs(input * pi + output * po - cost) / cost;
    if (e < err) [best, err] = [name, e];
  }
  return err < tolerance ? best : "unmatched";
}

/** What the requests would have cost at one price. */
export function repricedUsd(requests: readonly PricedRequest[], price: Price): number {
  return requests.reduce((n, r) => n + r.in * price[0] + r.out * price[1], 0);
}

/** Each inferred endpoint's share of the requests, largest first. */
export function endpointMix(model: string, requests: readonly PricedRequest[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of requests) {
    const e = inferEndpoint(model, r.in, r.out, r.cost);
    counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  return [...counts]
    .map(([e, n]): [string, number] => [e, n / requests.length])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
