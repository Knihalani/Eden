/**
 * The model roles the shipped servers wire (D112): the card and intent calls in the background and the ask-time
 * reader on the request path, on one OpenRouter model with D12's routing (`provider.data_collection: "deny"`, ZDR).
 * Gated on OPENROUTER_API_KEY or EDEN_MODEL_BASE_URL: with neither, every role is null, the partner gets no card
 * enricher and no reader, and the same default configuration runs its no-model path. No judge is wired: the
 * measured default ran without one.
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
 * A local (or any plain OpenAI-compatible) endpoint serves the roles instead of OpenRouter (D2109):
 * EDEN_MODEL_BASE_URL            the endpoint's base URL with its version path — Ollama
 *                                `http://localhost:11434/v1`, LM Studio `http://localhost:1234/v1`, vLLM,
 *                                llama.cpp, or the front a custom app's agent already calls. Turns the roles
 *                                on without a key: a loopback endpoint bills nothing (`LocalModel` reports
 *                                costUsd 0 unless the server says otherwise), so the tenant cap never trips.
 *                                Needs `EDEN_MODEL` to name the model the endpoint serves; set with
 *                                OPENROUTER_API_KEY, startup stops — which provider is ambiguous.
 * EDEN_MODEL_API_KEY             the endpoint's bearer, only when it wants one (llama.cpp `--api-key`,
 *                                vLLM's); Ollama and LM Studio need none, and none is sent.
 * EDEN_MODEL_TIMEOUT_MS          the roles' own call deadline on that endpoint, default 120,000: local
 *                                inference on a small box is far slower than a hosted route.
 *
 * The Anthropic provider is lab only (D97): nothing here constructs it.
 */
import {
  LocalModel,
  OpenRouterModel,
  RateHold,
  type LocalModelOptions,
  type Model,
  type OpenRouterOptions,
} from "@eden/llm";

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
/** The same for an OpenAI-compatible local endpoint (EDEN_MODEL_BASE_URL, D2109). */
export type MakeLocalModel = (options: LocalModelOptions) => Model;

/**
 * Whether an EDEN_MODEL_BASE_URL names this machine: a loopback endpoint (Ollama, LM Studio, a local
 * front) bills nothing, so a dev server may run the roles on it without EDEN_ALLOW_MODEL_ROLES=1 (D858's
 * guard is about spend, D2109). A malformed URL is not loopback: `modelRolesFromEnv` rejects it outright.
 */
export function loopbackModelBase(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = url.hostname;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host === "::1" ||
    host.startsWith("127.")
  );
}

/**
 * The roles from the environment; all null without OPENROUTER_API_KEY or EDEN_MODEL_BASE_URL. Throws on a
 * malformed cap, and on an ambiguous or incomplete local-endpoint configuration. The eval's `--live`
 * builds its reader from this very function (D128), so what it measures is what ships.
 */
export function modelRolesFromEnv(
  env: Record<string, string | undefined> = process.env,
  make: MakeRoleModel = (options) => new OpenRouterModel(options),
  makeLocal: MakeLocalModel = (options) => new LocalModel(options),
): ModelRoles {
  const usdPerTenantDay = tenantCap(env.EDEN_MODEL_USD_PER_TENANT_DAY);
  const baseUrl = env.EDEN_MODEL_BASE_URL;
  if (baseUrl !== undefined && baseUrl !== "") {
    if (env.OPENROUTER_API_KEY) {
      throw new Error("set EDEN_MODEL_BASE_URL or OPENROUTER_API_KEY, not both");
    }
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      // The value stays out of the error: a base URL can carry credentials (`…://user:key@host`) and
      // startup errors go to the server log, where a key must never land (D2109).
      throw new Error("EDEN_MODEL_BASE_URL must be a URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`EDEN_MODEL_BASE_URL must be http or https, got ${parsed.protocol}`);
    }
    const model = env.EDEN_MODEL;
    if (!model) {
      throw new Error("EDEN_MODEL_BASE_URL needs EDEN_MODEL to name the model the endpoint serves");
    }
    const free = loopbackModelBase(baseUrl);
    // One hold for every role, as on OpenRouter: a local server can answer 429 too.
    const options: LocalModelOptions = {
      baseUrl,
      model,
      apiKey: env.EDEN_MODEL_API_KEY,
      timeoutMs: modelTimeout(env.EDEN_MODEL_TIMEOUT_MS),
      rateHold: new RateHold(),
      freeCalls: free,
    };
    return {
      reader: makeLocal(options),
      cards: makeLocal(options),
      cardsRetry: makeLocal(options),
      // A loopback endpoint bills nothing, so an unset tenant spend cap is lifted for it: a 0 there
      // would refuse free calls (the per-session and per-user estimates stay, tiny and unsettled at
      // $0 — D2109). A configured cap keeps binding: a loopback gateway can front a paid provider.
      usdPerTenantDay:
        free && env.EDEN_MODEL_USD_PER_TENANT_DAY === undefined ? Number.POSITIVE_INFINITY : usdPerTenantDay,
      scrub: keyScrubber(env.EDEN_MODEL_API_KEY ?? ""),
    };
  }
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) return { ...NO_MODELS, usdPerTenantDay };
  // One hold for every role (D2046, S1-P9): the account's rate limit is shared, so a 429 on one role holds them
  // all, and a call made while held fails fast without sending.
  const rateHold = new RateHold();
  const base = {
    apiKey,
    model: env.EDEN_MODEL || DEFAULT_ROLE_MODEL,
    baseUrl: env.OPENROUTER_BASE_URL,
    zdr: env.EDEN_MODEL_ZDR !== "off",
    rateHold,
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

/** `EDEN_MODEL_TIMEOUT_MS`: unset keeps `LocalModel`'s default; a bad value stops startup. */
function modelTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`EDEN_MODEL_TIMEOUT_MS must be milliseconds, got ${raw}`);
  return n;
}

function tenantCap(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_USD_PER_TENANT_DAY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`EDEN_MODEL_USD_PER_TENANT_DAY must be a non-negative number of USD, got ${raw}`);
  }
  return n;
}
