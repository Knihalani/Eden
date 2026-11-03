import { describe, expect, test } from "bun:test";
import { CORE_CONFIG, DEFAULT_CONFIG } from "@eden/engine";
import { PRESETS } from "./presets";

describe("lab presets", () => {
  test("ALL3B and NEWB are ALL3 and NEW plus syncPollBehind, and leave ALL3 and NEW as they were", () => {
    expect(PRESETS.ALL3B).toEqual({ ...PRESETS.ALL3, syncPollBehind: true });
    expect(PRESETS.NEWB).toEqual({ ...PRESETS.NEW, syncPollBehind: true });
    expect(PRESETS.ALL3!.syncPollBehind).toBeUndefined();
    expect(PRESETS.NEW!.syncPollBehind).toBeUndefined();
    // The unified default (D111) turns it on; in the core the presets were measured against, the poll blocks.
    expect(DEFAULT_CONFIG.syncPollBehind).toBe(true);
    expect(CORE_CONFIG.syncPollBehind).toBe(false);
  });

  test("NEWBB, ALL3BG and NEWBG add one flag each to NEWB and ALL3B; the default has them, the core does not", () => {
    expect(PRESETS.NEWBB).toEqual({ ...PRESETS.NEWB, readerPushBehind: true });
    expect(PRESETS.ALL3BG).toEqual({ ...PRESETS.ALL3B, probeGraceMs: 0 });
    expect(PRESETS.NEWBG).toEqual({ ...PRESETS.NEWB, probeGraceMs: 0 });
    expect(PRESETS.NEWB!.readerPushBehind).toBeUndefined();
    expect(PRESETS.ALL3B!.probeGraceMs).toBeUndefined();
    expect(DEFAULT_CONFIG.readerPushBehind).toBe(true);
    expect(DEFAULT_CONFIG.probeGraceMs).toBe(0);
    expect(CORE_CONFIG.readerPushBehind).toBe(false);
    expect(CORE_CONFIG.probeGraceMs).toBe(100);
  });

  test("UNI over the core is the default (D111)", () => {
    expect({ ...CORE_CONFIG, ...PRESETS.UNI }).toEqual(DEFAULT_CONFIG);
  });

  test("every preset flag is a real config key", () => {
    for (const [name, preset] of Object.entries(PRESETS))
      for (const key of Object.keys(preset))
        expect(`${name}.${key} ${key in DEFAULT_CONFIG}`).toBe(`${name}.${key} true`);
  });
});
