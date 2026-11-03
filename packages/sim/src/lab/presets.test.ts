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

  test("NEWBB, ALL3BG and NEWBG add one flag each to NEWB and ALL3B; production defaults are unchanged", () => {
    expect(PRESETS.NEWBB).toEqual({ ...PRESETS.NEWB, readerPushBehind: true });
    expect(PRESETS.ALL3BG).toEqual({ ...PRESETS.ALL3B, probeGraceMs: 0 });
    expect(PRESETS.NEWBG).toEqual({ ...PRESETS.NEWB, probeGraceMs: 0 });
    expect(PRESETS.NEWB!.readerPushBehind).toBeUndefined();
    expect(PRESETS.ALL3B!.probeGraceMs).toBeUndefined();
    expect(DEFAULT_CONFIG.readerPushBehind).toBe(false);
    expect(DEFAULT_CONFIG.probeGraceMs).toBe(100);
  });

  test("every preset flag is a real config key", () => {
    for (const [name, preset] of Object.entries(PRESETS))
      for (const key of Object.keys(preset))
        expect(`${name}.${key} ${key in DEFAULT_CONFIG}`).toBe(`${name}.${key} true`);
  });
});
