/**
 * The lab's access to OpenRouter, for paid and free models alike (docs/research/edge-freelab.md). LAB ONLY: nothing
 * in packages/server or packages/engine imports it, and the product's own calls keep `data_collection: "deny"` and
 * ZDR (D12).
 *
 * Every lab runner that calls OpenRouter takes the same flags:
 *
 * - `--allow-logging`: the run may use endpoints that log prompts and are not zero-retention. Free models need it
 *   (`<model>:free`), and a run naming one without it stops before any call. Sim data only: never real user data.
 * - `--rpm N`: a client-side limit of N requests started per minute, over every call of the process (agent, Eden's
 *   judge and card maker, grader). Default 18 when a model is free (the account's free limit is about 20 a minute,
 *   shared), else none.
 * - `--max-requests N`: the run sends at most N HTTP requests, retries included; past it every call refuses with
 *   `RequestCapReached` and the run ends with what it has (partial results, said so in its output). Default: none.
 *
 * 429 and 5xx answers are retried with jittered backoff, honouring Retry-After (`Pacer` in @eden/llm).
 */
import { AnthropicModel, Pacer, priceFor, OpenRouterModel, type Model, type OpenRouterOptions } from "@eden/llm";
import { SpendLedger } from "./spend";
import { createModels, createProvider, envApiKeyAuth, type Model as PiModel } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const FREE_RPM = 18;

export interface LabAccess {
  allowLogging: boolean;
  pacer: Pacer;
  /** The pacer's fetch: every OpenRouter request of the run goes through it. */
  fetch: typeof fetch;
  /** True when any of the run's models is a free one. */
  free: boolean;
  /** The hard spend cap for Anthropic calls (`--spend-ledger`, `--spend-cap`); required when a model is `claude-*`. */
  ledger: SpendLedger | null;
}

/** Models served by Anthropic's Messages API directly (`AnthropicModel`), not OpenRouter. */
export const isAnthropic = (model: string) => model.startsWith("claude-");

/**
 * The key a model's provider needs, or a clear error naming the variable. An Anthropic key is read from
 * `HAIKU_API_KEY` first: cloud sessions whose model provider the host manages may not pass a user-set
 * `ANTHROPIC_API_KEY` through to the session, so the lab accepts a name with no reserved prefix.
 */
export function keyFor(model: string, env = process.env): string {
  const names = isAnthropic(model) ? ["HAIKU_API_KEY", "ANTHROPIC_API_KEY"] : ["OPENROUTER_API_KEY"];
  const key = names.map((n) => env[n]).find(Boolean);
  if (!key) throw new Error(`${model} needs ${names.join(" or ")}`);
  return key;
}

export const isFree = (model: string) => model.endsWith(":free");

/** Reads the flags above from a runner's arguments; `models` are every model id the run may call. */
export function labAccess(args: string[], models: string[], pacing: { now?: () => number } = {}): LabAccess {
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const allowLogging = args.includes("--allow-logging");
  const free = models.some(isFree);
  if (free && !allowLogging) {
    const named = models.filter(isFree).join(", ");
    throw new Error(`${named}: free endpoints log prompts and are not ZDR; pass --allow-logging (lab only, sim data)`);
  }
  const count = (name: string, fallback: number) => {
    const raw = opt(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a whole number ≥ 0, not ${raw}`);
    return n;
  };
  const pacer = new Pacer({
    perMinute: count("rpm", free ? FREE_RPM : 0),
    maxRequests: count("max-requests", 0),
    ...pacing,
  });
  // Anthropic calls are capped in dollars, across every process of a campaign, by one ledger file (spend.ts).
  let ledger: SpendLedger | null = null;
  if (models.some(isAnthropic)) {
    const path = opt("spend-ledger");
    const cap = Number(opt("spend-cap"));
    if (!path || !Number.isFinite(cap) || cap <= 0) {
      throw new Error("a claude-* model needs --spend-ledger FILE and --spend-cap USD (the hard spend cap)");
    }
    const headroom = Number(opt("spend-headroom") ?? 0.5);
    ledger = new SpendLedger(path, cap, opt("run-label") ?? "run", headroom);
  }
  return { allowLogging, pacer, fetch: pacer.fetch, free, ledger };
}

/**
 * A model for one of the run's roles (Eden's judge, the card maker, ...) that goes through the run's pacer. A
 * `claude-*` id is Anthropic's API, metered against the run's spend ledger under `role`; anything else is OpenRouter
 * with the run's logging choice.
 */
export function labModel(access: LabAccess, options: OpenRouterOptions, role = "eden"): Model {
  if (isAnthropic(options.model)) {
    if (!access.ledger) throw new Error(`${options.model}: no spend ledger (pass it among labAccess's models)`);
    return new AnthropicModel({
      apiKey: keyFor(options.model),
      model: options.model,
      fetch: access.fetch,
      timeoutMs: options.timeoutMs ?? 60_000,
      meter: access.ledger.meter(role),
    });
  }
  return new OpenRouterModel({
    ...options,
    fetch: access.fetch,
    ...(access.allowLogging ? { allowLogging: true } : {}),
  });
}

/**
 * A Pi model definition for any OpenRouter id, free ones included: pi-ai's generated catalog does not list every
 * OpenRouter model (and no `:free` variant), so the lab defines its own and registers it on its own provider. Cost is
 * the lab's price (`priceFor`: $0 for a free model), used only as pi-ai's estimate; runs book OpenRouter's reported
 * cost.
 */
export function piModelFor(id: string, maxTokens: number): PiModel<"openai-completions"> {
  const p = priceFor(id);
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "openrouter-lab",
    baseUrl: "https://openrouter.ai/api/v1",
    // No reasoning parameter is sent, as agent-ab sends none: the model's default applies to both harnesses.
    reasoning: false,
    input: ["text"],
    cost: { input: p.input, output: p.output, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens,
    compat: {
      // Eden's packet goes in as a system message before the user turn, where agent-ab puts it (withContext's place).
      supportsMidConvoSystemMessages: true,
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
    },
  };
}

/** pi-ai's model registry with the lab's OpenRouter provider and these models on it (key: OPENROUTER_API_KEY). */
export function piRegistry(models: PiModel<"openai-completions">[]) {
  const registry = createModels();
  registry.setProvider(
    createProvider({
      id: "openrouter-lab",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      auth: { apiKey: envApiKeyAuth("OpenRouter", ["OPENROUTER_API_KEY"]) },
      models,
      api: openAICompletionsApi(),
    }),
  );
  return registry;
}

/** The provider preferences a lab request adds to its body: none by default (the account's settings apply). */
export const providerPrefs = (access: LabAccess) =>
  access.allowLogging ? { provider: { data_collection: "allow", zdr: false } } : {};

/** An error that is the pacer's cap, however a library wrapped it. */
export function isCapError(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && depth < 5; depth++) {
    const capped = x instanceof Error && (x.name === "RequestCapReached" || x.name === "SpendCapReached");
    if (capped || (x instanceof Error && /request cap of \d+ reached|spend cap \$[\d.]+ reached/.test(x.message))) {
      return true;
    }
    x = (x as { cause?: unknown }).cause;
  }
  return false;
}
