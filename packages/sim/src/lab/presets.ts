/**
 * The lab's named engine configurations (`--preset`, `--config NAME`), shared by funnel.ts, pi-ab.ts and hermes-ab.ts.
 * One product (D112): the engine's `DEFAULT_CONFIG` is the configuration, so the presets are only `default` and
 * `minus-<part>` (the default with one of `PARTS` taken out), made from @eden/engine here and never written by hand.
 * `minus-all` is the default with every part taken out (`CORE_CONFIG`, the no-feature core). A trial (D112's trials
 * table) is measured as `--set` over `default`, never as a preset of its own.
 *
 * A preset is an override over `DEFAULT_CONFIG`, as every tool merges it; read a setting's effective value with
 * `effective`, not from the override (`default` is `{}`, and its cards and reader are on).
 */
import { CORE_CONFIG, DEFAULT_CONFIG, PARTS, type EngineConfig, type Part } from "@eden/engine";

type Key = keyof EngineConfig;

export const PRESETS: Record<string, Record<string, unknown>> = { default: {} };
for (const part of Object.keys(PARTS) as Part[]) PRESETS[`minus-${part}`] = { ...PARTS[part] };
PRESETS["minus-all"] = Object.fromEntries(
  Object.entries(CORE_CONFIG).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(DEFAULT_CONFIG[k as Key])),
);

/** The configuration an override runs: `DEFAULT_CONFIG` with the override over it. */
export function effective(override: Record<string, unknown>): EngineConfig {
  return { ...DEFAULT_CONFIG, ...override } as EngineConfig;
}
