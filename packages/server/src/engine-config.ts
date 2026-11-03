/**
 * EDEN_ENGINE_CONFIG (D103): the path of a JSON file of `EngineConfig` keys, merged over the default for the whole
 * process. Unset, the engine runs on `DEFAULT_CONFIG` exactly, the unified default (D111). The usual use is "default
 * minus a part" (@eden/engine's `PARTS`), or a measured trial; the lab's presets stay in `@eden/sim` and are not read
 * here, so the file names its settings itself.
 *
 * Every key is checked at startup against `DEFAULT_CONFIG`: an unknown key (a typo, a flag from another version) or a
 * value of the wrong type stops the server with a message naming it, rather than running silently on the default.
 * So does a number outside the key's range (`RANGES`) or an `anticipateOff` part the engine does not have. The
 * servers wire both model-role dependencies (cards and the reader, build.ts) whenever OPENROUTER_API_KEY is set, so
 * no card or reader key is refused for want of a dependency: without a key those parts are inert by design and the
 * default runs its no-model path (D111), whatever the file says. Sync is accepted: static sources list nothing, and
 * per-user MCP sources with a list tool (D108) are synced (engine-config.test.ts, `sync over per-user sources`).
 */
import { readFileSync } from "node:fs";
import { ANTICIPATE_PARTS, checkEngineConfig, type EngineConfig } from "@eden/engine";

// The checks themselves (keys, types, `RANGES`, `anticipateOff` parts, `NEEDS_DEP`) live in @eden/engine's
// config-check.ts, shared with the lab's CLIs; re-exported for engine-config.test.ts.
export { ANTICIPATE_PARTS };

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

/**
 * `value` as engine settings: a JSON object of known keys, each of its default's type. Throws naming the key. The
 * parent-flag check is left off:
 * a file is merged over the defaults, and refusing a child whose parent is off would refuse settings the server has
 * accepted so far (D104); the lab's CLIs run it.
 */
export function parseEngineConfig(value: unknown, where = "engine config"): Partial<EngineConfig> {
  return checkEngineConfig(value, {
    where,
    // Wired whenever a model key is set (build.ts, models.ts); without one they are inert by design (D111).
    deps: { cards: true, reader: true },
    parents: false,
  });
}
