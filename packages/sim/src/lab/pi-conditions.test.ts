import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@eden/engine";
import { pairedWith, parseCondition, parseConditions, parseVariants } from "./pi-conditions";

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
    expect(parseCondition("eden+askDedup", { config: ALL }).config).toEqual({ ...ALL, askDedup: true });
    const variants = parseVariants('{"ALL2":{"cardsEconomy":true}}');
    const c = parseCondition("eden~ALL2+readerReuse@w0", { config: ALL, variants });
    expect(c.config).toEqual({ ...ALL, cardsEconomy: true, readerReuse: true });
    expect(c.waitMs).toBe(0);
    expect(() => parseCondition("eden+bad-flag", { config: ALL })).toThrow(/bad flag/);
    // The run's own configuration object is never written through.
    expect(ALL).toEqual({ sync: true, cards: true, densePacket: true });
  });

  test("a variant or flag that names no engine setting throws, so a typo cannot run as the base", () => {
    const defaults = { sync: false, cards: false, densePacket: false, judgeTied: false };
    expect(parseCondition("eden+judgeTied", { config: ALL, defaults }).config.judgeTied).toBe(true);
    expect(() => parseCondition("eden+judgeTide", { config: ALL, defaults })).toThrow(/judgeTide/);
    const variants = { v: { densePacket: false, nope: 1 } };
    expect(() => parseCondition("eden~v", { config: ALL, variants, defaults })).toThrow(/nope/);
  });

  test("+flag only turns on a boolean setting: a number, string or list setting set to true would run broken", () => {
    const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
    expect(parseCondition("eden+judgeTied", { config: {}, defaults }).config.judgeTied).toBe(true);
    for (const f of ["judgeItemBytes", "readerPushKinds", "probeOff"]) {
      expect(() => parseCondition(`eden+${f}`, { config: {}, defaults })).toThrow(/not an on\/off flag/);
    }
  });

  test("a variant's settings must have the engine setting's type", () => {
    const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
    const ok = { V: { probes: true, judgeItemBytes: 400, readerPushKinds: ["blocks"], probeOff: ["gmail"] } };
    expect(parseCondition("eden~V", { config: {}, variants: ok, defaults }).config).toEqual(ok.V);
    const bad: [string, unknown][] = [
      ["probes", "yes"],
      ["judgeItemBytes", "400"],
      ["readerPushKinds", "blocks"],
      ["probeOff", "gmail"],
      ["probeOff", { a: 1 }],
      ["probes", null],
    ];
    for (const [k, v] of bad) {
      expect(() => parseCondition("eden~V", { config: {}, variants: { V: { [k]: v } }, defaults })).toThrow(
        new RegExp(`${k} must be`),
      );
    }
  });

  test("conditions that end up with one name throw, so their results and timelines cannot collide", () => {
    expect(parseConditions(["tools", "eden"], { config: {}, act: true }).map((c) => c.name)).toEqual([
      "tools-act",
      "eden-act",
    ]);
    expect(() => parseConditions(["eden", "eden-act"], { config: {}, act: true })).toThrow(/eden-act.*twice/);
    expect(() => parseConditions(["eden", "eden"], { config: {} })).toThrow(/twice/);
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

  test("-act-firewall turns the engine's action check on; beside tools, Eden runs only as the check", () => {
    const t = parseCondition("tools-act-firewall", { config: { probes: true }, act: true });
    expect(t).toMatchObject({ name: "tools-act-firewall", base: "tools", act: true, firewall: true });
    expect([t.useEden, t.withPartner, t.useTools]).toEqual([false, true, true]);
    expect(t.config).toEqual({ probes: true, actionCheck: true });
    const e = parseCondition("eden-act-firewall~v", { config: {}, act: true, variants: { v: { cards: true } } });
    expect([e.base, e.firewall, e.useEden, e.withPartner]).toEqual(["eden", true, true, true]);
    expect(e.config).toEqual({ cards: true, actionCheck: true });
    // Without the firewall tag, nothing turns the check on, and a firewall outside --act throws.
    const plain = parseCondition("eden-act", { config: {}, act: true });
    expect([plain.firewall, plain.config.actionCheck]).toEqual([false, undefined]);
    expect(() => parseCondition("tools-act-firewall", { config: {} })).toThrow(/--act/);
    expect(pairedWith("eden-act-firewall~v")).toBe("eden-act-firewall");
  });

  test("--variant-config must be an object of objects", () => {
    expect(parseVariants("{}")).toEqual({});
    expect(() => parseVariants('{"a":true}')).toThrow(/--variant-config/);
    expect(() => parseVariants("[1]")).toThrow(/--variant-config/);
  });

  test("a variant or flag condition pairs with the condition it modifies, in the report", () => {
    expect(pairedWith("eden~ALL2")).toBe("eden");
    expect(pairedWith("eden+askDedup")).toBe("eden");
    expect(pairedWith("eden-act~ALL2+readerReuse")).toBe("eden-act");
    expect(pairedWith("eden~ALL2@w0")).toBe("eden@w0");
    expect(pairedWith("both@w0")).toBe("both");
    expect(pairedWith("eden")).toBeNull();
  });

  test("both+ask: own tools, Eden's context and ask_context; +ask is the harness's, never an engine setting", () => {
    const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
    const c = parseCondition("both+ask", { config: ALL, defaults });
    expect([c.useTools, c.useEden, c.askTool, c.judge]).toEqual([true, true, true, false]);
    expect(c.config).toEqual(ALL);
    expect(c.base).toBe("both");
    // Stacks with an engine flag and a wait; the engine flag still goes to the config.
    const d = parseCondition("both+ask+judgeTied@w0", { config: ALL, defaults });
    expect([d.askTool, d.config.judgeTied, "ask" in d.config, d.waitMs]).toEqual([true, true, false, 0]);
    expect(parseCondition("both-judge+ask", { config: ALL }).askTool).toBe(true);
    // The plain arms keep their tool sets: both has no ask, eden has it, tools and none neither.
    expect(parseCondition("both", { config: ALL }).askTool).toBe(false);
    expect(parseCondition("eden", { config: ALL }).askTool).toBe(true);
    expect(parseCondition("tools", { config: ALL }).askTool).toBe(false);
    expect(parseCondition("none", { config: ALL }).askTool).toBe(false);
    // eden already asks, and tools has no Eden: +ask there would run another arm under a new name.
    for (const n of ["eden+ask", "tools+ask", "none+ask"]) {
      expect(() => parseCondition(n, { config: ALL })).toThrow(/\+ask/);
    }
    expect(pairedWith("both+ask")).toBe("both");
  });
  test("+nokey: the server with no model key (no card or reader role, the same default config), D291", () => {
    const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
    const c = parseCondition("eden+nokey", { config: ALL, defaults });
    expect([c.noKey, c.useEden, c.askTool, c.withPartner]).toEqual([true, true, true, true]);
    // A harness flag like +ask: the engine's settings are the condition's own, untouched.
    expect(c.config).toEqual(ALL);
    expect("nokey" in c.config).toBe(false);
    expect(parseCondition("both+ask+nokey", { config: ALL, defaults }).noKey).toBe(true);
    expect(parseCondition("eden", { config: ALL }).noKey).toBe(false);
    // Without Eden there is no key to take away: refused rather than run tools under another name.
    for (const n of ["tools+nokey", "none+nokey", "eden-judge+nokey"])
      expect(() => parseCondition(n, { config: ALL })).toThrow(/nokey/);
    expect(pairedWith("eden+nokey")).toBe("eden");
  });
  test("+ephemeral, +ephemeralBp: how earlier requests' packets are kept, a harness setting (D336)", () => {
    const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
    expect(parseCondition("eden", { config: ALL }).packets).toBe("kept");
    const e = parseCondition("eden+ephemeral", { config: ALL, defaults });
    expect([e.packets, e.config]).toEqual(["ephemeral", ALL]);
    expect(parseCondition("both+ask+ephemeralBp", { config: ALL, defaults }).packets).toBe("ephemeralBp");
    // Without Eden there are no packets; both flags at once would be two layouts.
    for (const n of ["tools+ephemeral", "none+ephemeralBp", "eden+ephemeral+ephemeralBp"])
      expect(() => parseCondition(n, { config: ALL })).toThrow(/ephemeral/);
    expect(pairedWith("eden+ephemeralBp")).toBe("eden");
  });
});
