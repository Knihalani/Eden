import { describe, expect, test } from "bun:test";
import { checkEngineConfig, CORE_CONFIG, DEFAULT_CONFIG, PARTS } from "@eden/engine";
import { effective, PRESETS } from "./presets";

describe("lab presets (D112: only the default and the default minus a part)", () => {
  test("default is the engine's default; minus-<part> takes exactly that part out; minus-all is the core", () => {
    expect(effective(PRESETS.default!)).toEqual(DEFAULT_CONFIG);
    for (const [part, off] of Object.entries(PARTS)) expect(PRESETS[`minus-${part}`]).toEqual(off);
    expect(effective(PRESETS["minus-all"]!)).toEqual(CORE_CONFIG);
    expect(Object.keys(PRESETS).sort()).toEqual(
      ["default", "minus-all", ...Object.keys(PARTS).map((p) => `minus-${p}`)].sort(),
    );
  });

  test("every preset passes the lab's own check, parents included", () => {
    for (const preset of Object.values(PRESETS)) expect(() => checkEngineConfig(preset)).not.toThrow();
  });

  test("effective reads the default under an override: the default's reader is on, minus-reader's off", () => {
    expect(effective({}).askReader).toBe(true);
    expect(effective(PRESETS["minus-reader"]!).askReader).toBe(false);
    expect(effective(PRESETS["minus-cards"]!).intent).toBe(false);
  });
});
