import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@eden/engine";
import { PRESETS } from "./presets";

describe("lab presets", () => {
  test("ALL3B and NEWB are ALL3 and NEW plus syncPollBehind, and leave ALL3 and NEW as they were", () => {
    expect(PRESETS.ALL3B).toEqual({ ...PRESETS.ALL3, syncPollBehind: true });
    expect(PRESETS.NEWB).toEqual({ ...PRESETS.NEW, syncPollBehind: true });
    expect(PRESETS.ALL3!.syncPollBehind).toBeUndefined();
    expect(PRESETS.NEW!.syncPollBehind).toBeUndefined();
    // Production defaults are unchanged: the poll still blocks unless a preset opts out.
    expect(DEFAULT_CONFIG.syncPollBehind).toBe(false);
  });

  test("every preset flag is a real config key", () => {
    for (const [name, preset] of Object.entries(PRESETS))
      for (const key of Object.keys(preset))
        expect(`${name}.${key} ${key in DEFAULT_CONFIG}`).toBe(`${name}.${key} true`);
  });
});
