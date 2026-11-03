/**
 * The model roles the shipped servers wire (D111): the card and intent calls in the background and the ask-time
 * reader on the request path, on one OpenRouter model with D12's routing (`provider.data_collection: "deny"`, ZDR).
 * Gated on OPENROUTER_API_KEY: without it every role is null, the partner gets no card enricher and no reader, and the
 * same default configuration runs its no-model path. No judge is wired: the measured default ran without one.
 *
 * EDEN_MODEL                     the roles' model, default `anthropic/claude-haiku-5.5` (the measured model, D98, D99).
 * EDEN_MODEL_ZDR=off             drops the ZDR routing requirement (data collection stays denied).
 * EDEN_MODEL_USD_PER_TENANT_DAY  one cap on a tenant's model spend per UTC day, shared by every role; default 25.
 *
 * The Anthropic provider is lab only (D97): nothing here constructs it.
 */
import { OpenRouterModel, type Model } from "@eden/llm";

/** The measured model (Haiku 5.5, D98, D99), through OpenRouter. */
export const DEFAULT_ROLE_MODEL = "anthropic/claude-haiku-5.5";
/** A tenant's daily model spend across roles, in USD, when EDEN_MODEL_USD_PER_TENANT_DAY is unset. */
export const DEFAULT_USD_PER_TENANT_DAY = 25;

export interface ModelRoles {
  /** The ask-time reader's model (D95), routed for throughput: the reader is on the request path. */
  reader: Model | null;
  /** The card and intent model (D59, D87), routed for price: no user waits on it (D66). */
  cards: Model | null;
  /** The card model with default routing, for a batch the price-routed endpoint cut off (D66's retry). */
  cardsRetry: Model | null;
  /** One cap on each tenant's spend per UTC day, across roles. */
  usdPerTenantDay: number;
}

/** No model at all: the default's no-model path (tests, and a server with no key). */
export const NO_MODELS: ModelRoles = { reader: null, cards: null, cardsRetry: null, usdPerTenantDay: 0 };

/** The roles from the environment; all null without OPENROUTER_API_KEY. Throws on a malformed cap. */
export function modelRolesFromEnv(env: Record<string, string | undefined> = process.env): ModelRoles {
  const usdPerTenantDay = tenantCap(env.EDEN_MODEL_USD_PER_TENANT_DAY);
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) return { ...NO_MODELS, usdPerTenantDay };
  const base = {
    apiKey,
    model: env.EDEN_MODEL || DEFAULT_ROLE_MODEL,
    baseUrl: env.OPENROUTER_BASE_URL,
    zdr: env.EDEN_MODEL_ZDR !== "off",
  };
  return {
    reader: new OpenRouterModel({ ...base, sort: "throughput" }),
    cards: new OpenRouterModel({ ...base, sort: "price" }),
    cardsRetry: new OpenRouterModel(base),
    usdPerTenantDay,
  };
}

function tenantCap(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_USD_PER_TENANT_DAY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`EDEN_MODEL_USD_PER_TENANT_DAY must be a non-negative number of USD, got ${raw}`);
  }
  return n;
}
