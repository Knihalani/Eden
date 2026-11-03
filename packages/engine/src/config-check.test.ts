import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type EngineConfig } from "./config";
import { checkEngineConfig, NEEDS_DEP, PARENTS } from "./config-check";

const ALL_DEPS = { cards: true, reader: true };

describe("checkEngineConfig (audit 2026-11-03b, devloop-lab-accepts-typos-silently)", () => {
  test("an unknown key, a wrong type or an out-of-range number is refused, naming the key", () => {
    // The finding's typo: `fallbackAsk` for `fallbackAsks` ran the defaults silently.
    expect(() => checkEngineConfig({ fallbackAsk: true })).toThrow(/unknown key "fallbackAsk"/);
    expect(() => checkEngineConfig(JSON.parse('{"__proto__": {"probes": true}}'))).toThrow(/unknown key "__proto__"/);
    expect(() => checkEngineConfig({ probes: "yes" })).toThrow(/"probes" must be a boolean/);
    expect(() => checkEngineConfig({ askItemBytes: -1 })).toThrow(/"askItemBytes" must be a number ≥ 0/);
    expect(() => checkEngineConfig({ syncStaleChance: 2, sync: true })).toThrow(/"syncStaleChance" must be at most 1/);
    expect(() => checkEngineConfig({ maxItemsPerInjection: 1.5 })).toThrow(/whole number/);
    expect(() => checkEngineConfig({ probeWhen: "never" })).toThrow(/"probeWhen" must be one of always, actions/);
    expect(() => checkEngineConfig({ anticipate: true, anticipateOff: ["srve"] })).toThrow(/"anticipateOff" has/);
    expect(() =>
      checkEngineConfig(
        { askReader: true, readerPush: true, readerPushKinds: ["block"] },
        {
          deps: ALL_DEPS,
        },
      ),
    ).toThrow(/"readerPushKinds" has "block"/);
    expect(() => checkEngineConfig([])).toThrow(/must be a JSON object/);
    expect(() => checkEngineConfig({ x: 1 }, { where: "--set" })).toThrow(/^--set: unknown key "x"/);
  });

  test("a key needing an unwired dependency is refused off its default, accepted when the caller wires it", () => {
    expect(() => checkEngineConfig({ cards: true })).toThrow(/"cards" needs the partner's cards dependency/);
    expect(checkEngineConfig({ cards: false })).toEqual({ cards: false });
    expect(checkEngineConfig({ cards: true }, { deps: { cards: true } })).toEqual({ cards: true });
    expect(() => checkEngineConfig({ askReader: true }, { deps: { cards: true } })).toThrow(/reader dependency/);
  });

  test("a child flag whose parent is off is refused; under a parent that is on it is accepted", () => {
    // The finding: `syncPollBehind` alone runs byte-identical to the defaults.
    expect(() => checkEngineConfig({ syncPollBehind: true })).toThrow(
      /"syncPollBehind" acts only with "sync" and "syncOnDemand" on, and this configuration has "sync" off/,
    );
    expect(checkEngineConfig({ sync: true, syncPollBehind: true })).toEqual({ sync: true, syncPollBehind: true });
    // Several parents: off is refused whichever one is off.
    expect(() => checkEngineConfig({ sync: true, syncOnDemand: false, syncPollBehind: true })).toThrow(
      /has "syncOnDemand" off/,
    );
    expect(() => checkEngineConfig({ graphMerge: true })).toThrow(/"graphMerge" acts only with "graph" on/);
    // At its default a child is harmless whatever its parents say.
    expect(checkEngineConfig({ graphMerge: false, syncOnDemand: true })).toEqual({
      graphMerge: false,
      syncOnDemand: true,
    });
    // A numeric child too.
    expect(() => checkEngineConfig({ askReaderPool: 15 }, { deps: ALL_DEPS })).toThrow(/"askReaderPool" acts only/);
    const push = { cards: true, askReader: true, readerPush: true, sync: true, syncPollBehind: true };
    expect(checkEngineConfig({ ...push, readerPushBehind: true }, { deps: ALL_DEPS })).toMatchObject(push);
    expect(() =>
      checkEngineConfig({ ...push, syncPollBehind: false, readerPushBehind: true }, { deps: ALL_DEPS }),
    ).toThrow(/"readerPushBehind" acts only/);
    // `parents: false` (the server's file, merged over the defaults as it always was) skips it.
    expect(checkEngineConfig({ graphMerge: true }, { parents: false })).toEqual({ graphMerge: true });
  });

  test("every PARENTS and NEEDS_DEP entry names real settings; every parent is a flag", () => {
    for (const [key, parents] of Object.entries(PARENTS)) {
      expect(Object.hasOwn(DEFAULT_CONFIG, key)).toBe(true);
      for (const p of parents!) expect(typeof DEFAULT_CONFIG[p as keyof EngineConfig]).toBe("boolean");
      expect(parents).not.toContain(key);
    }
    for (const key of Object.keys(NEEDS_DEP)) expect(Object.hasOwn(DEFAULT_CONFIG, key)).toBe(true);
  });

  test("the defaults themselves pass, whole", () => {
    expect(checkEngineConfig({ ...DEFAULT_CONFIG })).toEqual({ ...DEFAULT_CONFIG });
  });
});
