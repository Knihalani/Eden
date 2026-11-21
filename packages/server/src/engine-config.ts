/**
 * EDEN_ENGINE_CONFIG (D103): the path of a JSON file of `EngineConfig` keys, merged over the default for the whole
 * process. Unset, the engine runs on `DEFAULT_CONFIG` exactly, the unified default (D112). The usual use is "default
 * minus a part" (@eden/engine's `PARTS`), or a measured trial; the lab's presets stay in `@eden/sim` and are not read
 * here, so the file names its settings itself.
 *
 * Every key is checked at startup against `DEFAULT_CONFIG`: a value of the wrong type, a number outside the key's
 * range (`RANGES`) or a list entry the engine does not know stops the server with a message naming it, rather than
 * running silently on the default. An unknown key (a typo, or a flag a file written for another version names —
 * removed, renamed or not yet shipped) is named on stderr and skipped instead (D5 of weak-points-1111.md): an
 * upgrade must not stop the server over a key it no longer has, nor a rollback over one it has not gained. The
 * strict check is kept in `parseEngineConfig`, which the lab's CLIs run. The
 * servers wire both model-role dependencies (cards and the reader, build.ts) whenever OPENROUTER_API_KEY is set, so
 * no card or reader key is refused for want of a dependency: without a key those parts are inert by design and the
 * default runs its no-model path (D112), whatever the file says. Sync is accepted: static sources list nothing, and
 * per-user MCP sources with a list tool (D108) are synced (engine-config.test.ts, `sync over per-user sources`).
 */
import { readFileSync } from "node:fs";
import { checkEngineConfig, DEFAULT_CONFIG, type EngineConfig } from "@eden/engine";
import { sanitizeForStore } from "@eden/redact";

// The checks themselves (keys, types, `RANGES`, list entries, `NEEDS_DEP`) live in @eden/engine's config-check.ts,
// shared with the lab's CLIs.

/** The engine settings EDEN_ENGINE_CONFIG names, validated; `{}` when it is unset or empty. Throws on a bad file. */
export function engineConfig(env: Record<string, string | undefined> = process.env): Partial<EngineConfig> {
  const path = env.EDEN_ENGINE_CONFIG;
  if (path === undefined || path === "") return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`EDEN_ENGINE_CONFIG: cannot read ${sanitizeForStore(path)} (${(error as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`EDEN_ENGINE_CONFIG: ${sanitizeForStore(path)} is not JSON (${(error as Error).message})`);
  }
  // D5: a key the running version does not have is warned about and skipped, not fatal — the file may have been
  // written for another version. `Object.hasOwn`, not `in`: "__proto__" and "constructor" are not settings.
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const kept: Record<string, unknown> = {};
    for (const [key, given] of Object.entries(parsed)) {
      if (Object.hasOwn(DEFAULT_CONFIG, key)) kept[key] = given;
      // Logged, so the path and key pass sanitizeForStore; whitespace collapses so a key cannot forge a log line.
      else
        console.error(
          `eden: EDEN_ENGINE_CONFIG (${sanitizeForStore(path)}) has unknown key ` +
            `"${sanitizeForStore(key).replace(/\s+/g, " ")}", ignored`,
        );
    }
    parsed = kept;
  }
  return parseEngineConfig(parsed, `EDEN_ENGINE_CONFIG (${sanitizeForStore(path)})`);
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
    // Wired whenever a model key is set (build.ts, models.ts); without one they are inert by design (D112).
    deps: { cards: true, reader: true, checker: true },
    parents: false,
  });
}
