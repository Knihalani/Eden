import type { Usage } from "./types";

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cachedInput?: number;
}

/**
 * Prices the partner budgets with. They are estimates for budgeting, not billing: OpenRouter reports the real cost
 * per call, and `OpenRouterModel` prefers that when present. Override with EDEN_MODEL_PRICE="<input>,<output>"
 * (USD per million).
 *
 * glm-5.3-flash has 38 OpenRouter endpoints, from $0.0513/M input (Relace) to $0.15/M (Z.AI and most US hosts),
 * per the OpenRouter endpoints API on 2026-10-27 (docs/COST-MODEL.md). Budget with the Z.AI list price: routing
 * decides which endpoint serves a call, so the conservative price keeps budgets safe.
 */
export const PRICES: Record<string, Price> = {
  "z-ai/glm-5.3-flash": { input: 0.15, output: 0.5, cachedInput: 0.03 },
};

export function priceFor(model: string, env = process.env): Price {
  const override = env.EDEN_MODEL_PRICE?.split(",").map(Number);
  if (override?.length === 2 && override.every((n) => Number.isFinite(n) && n >= 0)) {
    return { input: override[0]!, output: override[1]! };
  }
  return PRICES[model] ?? { input: 1, output: 4 }; // Unknown model: price it high so budgets stay conservative.
}

export function costOf(usage: Usage, price: Price): number {
  const uncached = usage.inputTokens - usage.cachedInputTokens;
  const cached = usage.cachedInputTokens * (price.cachedInput ?? price.input);
  return (uncached * price.input + cached + usage.outputTokens * price.output) / 1_000_000;
}
