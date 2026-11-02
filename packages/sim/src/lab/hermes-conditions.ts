/**
 * The conditions of `hermes-ab.ts`: Hermes Agent alone, and the same Hermes with Eden integrated as a tenant would.
 *
 *   hermes                                   Hermes with a read-only search tool per sim source, over MCP
 *   hermes+eden[~variant][+flag ...][@w<ms>] the same tools, plus Eden: its `ask_context` MCP server and the Eden
 *                                            plugin (packets before the turn and after tool results)
 *
 * The suffixes are pi-conditions.ts's: `~variant` takes `--variant-config`'s settings over `--config`, `+flag` turns
 * one engine flag on, `@w<ms>` is how long the first observe waits for Eden's slow path (default 3000). The report
 * pairs every `hermes+eden…` condition with `hermes` (`pairedWith` strips from the first `+` or `~`).
 */
import { parseCondition, type Condition, type ConditionOptions } from "./pi-conditions";

export interface HermesCondition extends Condition {
  /** Eden integrated: the plugin's packets and the `ask_context` MCP server. */
  eden: boolean;
}

const EDEN = /^hermes\+eden(?=$|[~+@])/;

export function parseHermesCondition(name: string, options: ConditionOptions): HermesCondition {
  if (options.act) throw new Error("hermes-ab has no --act mode");
  if (name === "hermes") return { ...parseCondition("tools", options), name, eden: false };
  if (!EDEN.test(name)) {
    throw new Error(`unknown condition "${name}" (hermes, or hermes+eden[~variant][+flag][@w<ms>])`);
  }
  // `both` is pi-conditions' tools-plus-Eden base: the rest of the name (variant, flags, wait) parses as there.
  const c = parseCondition(`both${name.slice("hermes+eden".length)}`, options);
  if (c.judge) throw new Error(`condition ${name}: the judge is not a hermes-ab condition`);
  return { ...c, name, eden: true };
}

/** Every `--conditions` name, parsed; a name given twice throws (results and timelines are keyed by it). */
export function parseHermesConditions(names: readonly string[], options: ConditionOptions): HermesCondition[] {
  const out = names.map((n) => parseHermesCondition(n, options));
  const seen = new Set<string>();
  for (const c of out) {
    if (seen.has(c.name)) throw new Error(`condition ${c.name} is given twice`);
    seen.add(c.name);
  }
  return out;
}
