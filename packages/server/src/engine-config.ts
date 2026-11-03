/**
 * EDEN_ENGINE_CONFIG (D101): the path of a JSON file of `EngineConfig` keys, merged over the production defaults for
 * the whole process. Unset, the engine runs on `DEFAULT_CONFIG` exactly (D12). It is how a deployment runs a measured
 * configuration (ALL3, D80; NEW, D98) without writing code; the lab's presets stay in `@eden/sim` and are not read
 * here, so the file names its flags itself.
 *
 * Every key is checked at startup against `DEFAULT_CONFIG`: an unknown key (a typo, a flag from another version) or a
 * value of the wrong type stops the server with a message naming it, rather than running silently on the default.
 * Keys that turn on model calls (`cards`, `intent`, `judge*`, `askReader`, `readerPush`, `bridgeQuery`, ...) still
 * go through the partner's `Budget` with bounded input; docs/COST-MODEL.md has what each costs.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, type EngineConfig } from "@eden/engine";

/** String-valued keys and the values each accepts; every other key's type is its default's. */
const CHOICES: Partial<Record<keyof EngineConfig, readonly string[]>> = { probeWhen: ["always", "actions"] };

/** The engine settings EDEN_ENGINE_CONFIG names, validated; `{}` when it is unset or empty. Throws on a bad file. */
export function engineConfig(env: Record<string, string | undefined> = process.env): Partial<EngineConfig> {
  const path = env.EDEN_ENGINE_CONFIG;
  if (path === undefined || path === "") return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`EDEN_ENGINE_CONFIG: cannot read ${path} (${(error as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`EDEN_ENGINE_CONFIG: ${path} is not JSON (${(error as Error).message})`);
  }
  return parseEngineConfig(parsed, `EDEN_ENGINE_CONFIG (${path})`);
}

/** `value` as engine settings: a JSON object of known keys, each of its default's type. Throws naming the key. */
export function parseEngineConfig(value: unknown, where = "engine config"): Partial<EngineConfig> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be a JSON object of engine settings`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, given] of Object.entries(value)) {
    // `Object.hasOwn`, not `in`: "__proto__" and "constructor" are not settings.
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`${where}: unknown key "${key}"`);
    const fallback = DEFAULT_CONFIG[key as keyof EngineConfig];
    const choices = CHOICES[key as keyof EngineConfig];
    if (choices) {
      if (typeof given !== "string" || !choices.includes(given)) {
        throw new Error(`${where}: "${key}" must be one of ${choices.join(", ")}`);
      }
    } else if (Array.isArray(fallback)) {
      if (!Array.isArray(given) || !given.every((entry) => typeof entry === "string")) {
        throw new Error(`${where}: "${key}" must be an array of strings`);
      }
    } else if (typeof fallback === "number") {
      // Every numeric setting is a count, a size, a time or a score, none negative.
      if (typeof given !== "number" || !Number.isFinite(given) || given < 0) {
        throw new Error(`${where}: "${key}" must be a number ≥ 0`);
      }
    } else if (typeof given !== typeof fallback) {
      throw new Error(`${where}: "${key}" must be a ${typeof fallback}`);
    }
    out[key] = given;
  }
  return out as Partial<EngineConfig>;
}
