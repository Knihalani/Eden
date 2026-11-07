import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type EngineConfig } from "./config";
import { checkEngineConfig, NEEDS_DEP, PARENTS } from "./config-check";
import { CORE_CONFIG, PARTS, type Part } from "./parts";

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
    // The default turns cards and the reader on (D112): at its default a key is accepted with no dependency (the part
    // is inert and the no-model path answers); a value off its default is what needs the dependency.
    expect(() => checkEngineConfig({ cardItems: 2 })).toThrow(/"cardItems" needs the partner's cards dependency/);
    expect(checkEngineConfig({ cards: true })).toEqual({ cards: true });
    expect(checkEngineConfig({ cards: true }, { deps: { cards: true } })).toEqual({ cards: true });
    expect(checkEngineConfig({ cardItems: 2 }, { deps: { cards: true } })).toEqual({ cardItems: 2 });
    expect(() => checkEngineConfig({ askReaderPool: 20 }, { deps: { cards: true } })).toThrow(/reader dependency/);
    // Taking a part out (its core value) needs no dependency either.
    expect(checkEngineConfig({ cards: false, askReader: false, askReaderPool: 30 })).toEqual({
      cards: false,
      askReader: false,
      askReaderPool: 30,
    });
  });

  test("a child flag whose parent is off is refused; under a parent that is on it is accepted", () => {
    // The finding: a child set with its parent off runs byte-identical to the parent off. The default turns most
    // parents and their flag children on (D112), so the children here are set off their default with a parent off.
    expect(() => checkEngineConfig({ sync: false, syncPollPageSize: 7 })).toThrow(
      /"syncPollPageSize" acts only with "sync" on, and this configuration has "sync" off/,
    );
    expect(checkEngineConfig({ sync: true, syncPollBehind: true })).toEqual({ sync: true, syncPollBehind: true });
    expect(checkEngineConfig({ syncPollPageSize: 7 })).toEqual({ syncPollPageSize: 7 });
    // Several parents: off is refused whichever one is off.
    expect(() => checkEngineConfig({ intent: false, intentHits: 3 }, { deps: ALL_DEPS })).toThrow(
      /"intentHits" acts only with "cards" and "intent" on, and this configuration has "intent" off/,
    );
    expect(() => checkEngineConfig({ cards: false, intentHits: 3 }, { deps: ALL_DEPS })).toThrow(/has "cards" off/);
    expect(() => checkEngineConfig({ cards: false, cardItems: 2 }, { deps: ALL_DEPS })).toThrow(
      /"cardItems" acts only with "cards" on/,
    );
    // At its core value (its part taken out) a child is harmless whatever its parents say.
    expect(checkEngineConfig({ cardsEconomy: false, syncOnDemand: true })).toEqual({
      cardsEconomy: false,
      syncOnDemand: true,
    });
    expect(checkEngineConfig({ cards: false, cardItems: DEFAULT_CONFIG.cardItems })).toEqual({
      cards: false,
      cardItems: DEFAULT_CONFIG.cardItems,
    });
    // A numeric child too; its core value (the part taken out) is accepted under the parent off.
    expect(() => checkEngineConfig({ askReader: false, askReaderPool: 20 }, { deps: ALL_DEPS })).toThrow(
      /"askReaderPool" acts only/,
    );
    expect(checkEngineConfig({ askReader: false, askReaderPool: 30 }, { deps: ALL_DEPS })).toEqual({
      askReader: false,
      askReaderPool: 30,
    });
    // A flag child turned on under its parent off is refused (the checks the old default's tests made).
    expect(() => checkEngineConfig({ sync: false, syncPollBehind: true })).toThrow(/"syncPollBehind" acts only/);
    expect(() => checkEngineConfig({ cards: false, cardsEconomy: true }, { deps: ALL_DEPS })).toThrow(
      /"cardsEconomy" acts only/,
    );
    expect(() => checkEngineConfig({ ...CORE_CONFIG, readerPushBehind: true }, { deps: ALL_DEPS })).toThrow(
      /"readerPushBehind" acts only/,
    );
    // Default minus any part, and the core itself, pass whole: the part's own values take it out.
    for (const part of Object.keys(PARTS) as Part[]) expect(() => checkEngineConfig(PARTS[part])).not.toThrow();
    expect(() => checkEngineConfig(CORE_CONFIG)).not.toThrow();
    const push = { cards: true, askReader: true, readerPush: true, sync: true, syncPollBehind: true };
    expect(checkEngineConfig({ ...push, readerPushBehind: true }, { deps: ALL_DEPS })).toMatchObject(push);
    expect(checkEngineConfig({ ...push, readerPushWaitMs: 5_000 }, { deps: ALL_DEPS })).toMatchObject(push);
    expect(() =>
      checkEngineConfig({ ...push, readerPush: false, readerPushWaitMs: 5_000 }, { deps: ALL_DEPS }),
    ).toThrow(/"readerPushWaitMs" acts only/);
    // `parents: false` (the server's file, merged over the defaults as it always was) skips it.
    expect(checkEngineConfig({ cards: false, cardItems: 2 }, { parents: false, deps: ALL_DEPS })).toEqual({
      cards: false,
      cardItems: 2,
    });
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
