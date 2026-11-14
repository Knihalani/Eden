/**
 * The model roles the shipped servers wire (D112): the card and intent calls in the background and the ask-time
 * reader on the request path, on one OpenRouter model with D12's routing (`provider.data_collection: "deny"`, ZDR).
 * Gated on OPENROUTER_API_KEY: without it every role is null, the partner gets no card enricher and no reader, and the
 * same default configuration runs its no-model path. No judge is wired: the measured default ran without one.
 *
 * EDEN_MODEL                     the roles' model, default `anthropic/claude-haiku-5.5` (the measured model, D98, D99).
 *                                An Anthropic model is sent no reasoning request (it does not think, D144); any other
 *                                is held to "low" effort, excluded (`OpenRouterModel`), since it may reason by default
 *                                and its reasoning counts against the reply cap (D45). Only Haiku 5.5 is measured.
 * EDEN_MODEL_ZDR=off             drops the ZDR routing requirement (data collection stays denied).
 * EDEN_MODEL_USD_PER_TENANT_DAY  one cap on a tenant's model spend per UTC day, shared by every role; default 25.
 * EDEN_MODEL_CACHE=off           turns off Anthropic `cache_control` breakpoints on the roles' stable prefix
 *                                (`anthropicCache`, on by default since D1790, which promoted D1196's trial without its
 *                                probe): the push check's and the card call's fixed instructions and the rule sheet are
 *                                read from the provider's cache at 0.1x (the sheet only for a user whose checks usually
 *                                reuse it within the hour, D1800). A route that refuses the fields falls back to
 *                                sending none (`OpenRouterModel.cacheLevel`), so the default cannot fail a call; one
 *                                that never serves a read stops getting them after 50 calls that should have read.
 *
 * The Anthropic provider is lab only (D97): nothing here constructs it.
 */
import { OpenRouterModel, type Model, type OpenRouterOptions } from "@eden/llm";

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
  /**
   * Removes the API key from text bound for a log (a provider's error message), when a key is set. A closure, so the
   * key is never a field anything could serialise or print.
   */
  scrub?: (text: string) => string;
}

/**
 * No model role: the default's no-model path (tests, and a server with no key). The tenant cap stays the default's,
 * since an embedding's own judge (`BuildOptions.model`) is charged against it too.
 */
export const NO_MODELS: ModelRoles = {
  reader: null,
  cards: null,
  cardsRetry: null,
  usdPerTenantDay: DEFAULT_USD_PER_TENANT_DAY,
};

/** How a role's model is made from its OpenRouter options: the real client, or a fake in tests (no network). */
export type MakeRoleModel = (options: OpenRouterOptions) => Model;

/**
 * The roles from the environment; all null without OPENROUTER_API_KEY. Throws on a malformed cap. The eval's `--live`
 * builds its reader from this very function (D128), so what it measures is what ships.
 */
export function modelRolesFromEnv(
  env: Record<string, string | undefined> = process.env,
  make: MakeRoleModel = (options) => new OpenRouterModel(options),
): ModelRoles {
  const usdPerTenantDay = tenantCap(env.EDEN_MODEL_USD_PER_TENANT_DAY);
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) return { ...NO_MODELS, usdPerTenantDay };
  const base = {
    apiKey,
    model: env.EDEN_MODEL || DEFAULT_ROLE_MODEL,
    baseUrl: env.OPENROUTER_BASE_URL,
    zdr: env.EDEN_MODEL_ZDR !== "off",
    // On by default (D1790); `OpenRouterModel` sends them to `anthropic/*` models only and falls back on a refusal.
    ...(cacheOn(env.EDEN_MODEL_CACHE) ? { anthropicCache: true } : {}),
  };
  return {
    reader: make({ ...base, sort: "throughput" }),
    cards: make({ ...base, sort: "price" }),
    cardsRetry: make(base),
    usdPerTenantDay,
    scrub: keyScrubber(apiKey),
  };
}

/**
 * Removes an API key from a provider's error text before it is logged: the key itself, its last 16 characters (a
 * provider may echo a masked key), and the base64 of the key and of `Bearer <key>` (an echoed header), each also when
 * split by whitespace or a line break. One regular expression built once per key; each pattern is a run of literal
 * characters with optional whitespace between them, so matching stays linear in the text.
 */
export function keyScrubber(key: string): (text: string) => string {
  if (!key) return (text) => text;
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/=+$/, "");
  // A base64 form also takes its padding, so no stray "=" is left beside the placeholder.
  const forms = new Map<string, string>([
    [key, ""],
    [key.slice(-16), ""],
  ]);
  for (const form of [b64(key), b64(`Bearer ${key}`)]) {
    forms.set(form, "(?:\\s*=){0,2}");
    forms.set(form.replace(/\+/g, "-").replace(/\//g, "_"), "(?:\\s*=){0,2}"); // base64url
  }
  const escape = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = [...forms]
    .filter(([f]) => f.length > 0)
    .sort(([a], [b]) => b.length - a.length)
    .map(([f, tail]) => [...f].map(escape).join("\\s*") + tail)
    .join("|");
  const re = new RegExp(pattern, "g");
  return (text) => text.replace(re, "[key]");
}

/** `EDEN_MODEL_CACHE`: `on` or unset (on, D1790), or `off`; any other value stops startup (a typo must not read as
 * either, D1196). */
function cacheOn(raw: string | undefined): boolean {
  if (raw === "off") return false;
  if (raw === undefined || raw === "" || raw === "on") return true;
  throw new Error(`EDEN_MODEL_CACHE must be on or off, got ${raw}`);
}

function tenantCap(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_USD_PER_TENANT_DAY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`EDEN_MODEL_USD_PER_TENANT_DAY must be a non-negative number of USD, got ${raw}`);
  }
  return n;
}
