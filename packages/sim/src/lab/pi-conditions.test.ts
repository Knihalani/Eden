import { describe, expect, test } from "bun:test";
import { pairedWith, parseCondition, parseVariants } from "./pi-conditions";

const ALL = { sync: true, cards: true, densePacket: true };

describe("pi-ab conditions", () => {
  test("the plain conditions keep their meaning and the run's configuration", () => {
    const tools = parseCondition("tools", { config: ALL });
    expect([tools.useTools, tools.useEden, tools.judge, tools.act]).toEqual([true, false, false, false]);
    const eden = parseCondition("eden", { config: ALL });
    expect([eden.useTools, eden.useEden, eden.judge]).toEqual([false, true, false]);
    expect(eden.config).toEqual(ALL);
    expect(eden.waitMs).toBe(3_000);
    expect(parseCondition("both-judge", { config: ALL })).toMatchObject({ useTools: true, useEden: true, judge: true });
    expect(parseCondition("none", { config: ALL })).toMatchObject({ useTools: false, useEden: false });
  });

  test("a named variant adds its settings over --config, and an unknown name throws", () => {
    const variants = parseVariants('{"ALL2":{"syncPollBehind":true,"densePacket":false}}');
    const c = parseCondition("eden~ALL2", { config: ALL, variants });
    expect(c.base).toBe("eden");
    expect(c.config).toEqual({ ...ALL, syncPollBehind: true, densePacket: false });
    expect(() => parseCondition("eden~nope", { config: ALL, variants })).toThrow(/no --variant-config entry "nope"/);
  });

  test("+flag is shorthand for a variant that turns one flag on, and stacks on a named variant", () => {
    expect(parseCondition("eden+packetVerdicts", { config: ALL }).config).toEqual({ ...ALL, packetVerdicts: true });
    const variants = parseVariants('{"ALL2":{"cardsEconomy":true}}');
    const c = parseCondition("eden~ALL2+judgeBehind@w0", { config: ALL, variants });
    expect(c.config).toEqual({ ...ALL, cardsEconomy: true, judgeBehind: true });
    expect(c.waitMs).toBe(0);
    expect(() => parseCondition("eden+bad-flag", { config: ALL })).toThrow(/bad flag/);
    // The run's own configuration object is never written through.
    expect(ALL).toEqual({ sync: true, cards: true, densePacket: true });
  });

  test("a variant or flag that names no engine setting throws, so a typo cannot run as the base", () => {
    const known = new Set(["sync", "cards", "densePacket", "judgeTied"]);
    expect(parseCondition("eden+judgeTied", { config: ALL, known }).config.judgeTied).toBe(true);
    expect(() => parseCondition("eden+judgeTide", { config: ALL, known })).toThrow(/judgeTide/);
    const variants = { v: { densePacket: false, nope: 1 } };
    expect(() => parseCondition("eden~v", { config: ALL, variants, known })).toThrow(/nope/);
  });

  test("a wait suffix is checked", () => {
    expect(parseCondition("both@w500", { config: {} }).waitMs).toBe(500);
    expect(() => parseCondition("both@wx", { config: {} })).toThrow(/bad wait/);
  });

  test("unknown bases throw instead of silently running Eden", () => {
    expect(() => parseCondition("eden-1t", { config: {} })).toThrow(/unknown condition/);
    expect(() => parseCondition("", { config: {} })).toThrow(/unknown condition/);
  });

  test("--act is a mode: every condition gets the action tools, and -act outside the mode throws", () => {
    const c = parseCondition("tools", { config: {}, act: true });
    expect([c.name, c.base, c.act, c.useTools]).toEqual(["tools-act", "tools", true, true]);
    expect(parseCondition("eden-act~v@w0", { config: {}, act: true, variants: { v: { x: 1 } } })).toMatchObject({
      name: "eden-act~v@w0",
      base: "eden",
      act: true,
      config: { x: 1 },
    });
    expect(parseCondition("eden~v", { config: {}, act: true, variants: { v: {} } }).name).toBe("eden-act~v");
    expect(() => parseCondition("eden-act", { config: {} })).toThrow(/--act/);
  });

  test("the firewall conditions need the engine's action check, which this harness does not have yet", () => {
    expect(() => parseCondition("tools-act-firewall", { config: {}, act: true })).toThrow(/actionCheck/);
  });

  test("--variant-config must be an object of objects", () => {
    expect(parseVariants("{}")).toEqual({});
    expect(() => parseVariants('{"a":true}')).toThrow(/--variant-config/);
    expect(() => parseVariants("[1]")).toThrow(/--variant-config/);
  });

  test("a variant or flag condition pairs with the condition it modifies, in the report", () => {
    expect(pairedWith("eden~ALL2")).toBe("eden");
    expect(pairedWith("eden+packetVerdicts")).toBe("eden");
    expect(pairedWith("eden-act~ALL2+judgeBehind")).toBe("eden-act");
    expect(pairedWith("eden~ALL2@w0")).toBe("eden@w0");
    expect(pairedWith("both@w0")).toBe("both");
    expect(pairedWith("eden")).toBeNull();
  });
});
