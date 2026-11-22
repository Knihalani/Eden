import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@eden/engine";
import { parseHermesCondition, parseHermesConditions } from "./hermes-conditions";
import { pairedWith, parseVariants } from "./pi-conditions";

const ALL = { sync: true, cards: true };
const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;

describe("hermes-ab conditions", () => {
  test("+checkedFacts aliases the answer-form engine trial and stacks", () => {
    const c = parseHermesCondition("hermes+eden+checkedFacts+pushCheckedWhy+packetCoversLine", {
      config: ALL,
      defaults,
    });
    expect(c.config).toEqual({ ...ALL, pushCheckedFacts: true, pushCheckedWhy: true, packetCoversLine: true });
    expect(pairedWith(c.name)).toBe("hermes");
    expect(DEFAULT_CONFIG.pushCheckedFacts).toBe(false);
  });
  test("+edenGuide is opt-in system guidance, not engine configuration", () => {
    const options = { config: ALL, defaults };
    const off = parseHermesCondition("hermes+eden", options);
    const on = parseHermesCondition("hermes+eden+edenGuide", options);
    expect(off.edenGuide).toBe(false);
    expect(on.edenGuide).toBe(true);
    expect(on.config).toEqual(off.config);
    expect(on.askTool).toBe(off.askTool);
    const stacked = parseHermesCondition(
      "hermes+eden+pushCheckedWhy+packetCoversLine+pushUnsureAskNudge+edenGuide",
      options,
    );
    expect(stacked.edenGuide).toBe(true);
    expect(stacked.config).toEqual({ ...ALL, pushCheckedWhy: true, packetCoversLine: true, pushUnsureAskNudge: true });
    expect(Object.hasOwn(DEFAULT_CONFIG, "edenGuide")).toBe(false);
    expect(pairedWith(on.name)).toBe("hermes");
    expect(() => parseHermesCondition("hermes+edenGuide", options)).toThrow(/unknown condition/);
    expect(() => parseHermesCondition("hermes+eden+edenGuides", options)).toThrow(/no engine setting/);
  });

  test("+packetCoversLine enables only the framing trial and stacks with +pushCheckedWhy", () => {
    const options = { config: ALL, defaults };
    expect(DEFAULT_CONFIG.packetCoversLine).toBe(false);
    expect(parseHermesCondition("hermes+eden+packetCoversLine", options).config).toEqual({
      ...ALL,
      packetCoversLine: true,
    });
    const combo = parseHermesCondition("hermes+eden+pushCheckedWhy+packetCoversLine", options);
    expect(combo.config).toEqual({ ...ALL, pushCheckedWhy: true, packetCoversLine: true });
    expect(combo.eden).toBe(true);
    expect(pairedWith(combo.name)).toBe("hermes");
    expect(() => parseHermesCondition("hermes+eden+packetCoversLines", options)).toThrow(/no engine setting/);
  });

  test("+pushUnsureAskNudge enables only the unchecked ask-nudge trial", () => {
    expect(DEFAULT_CONFIG.pushUnsureAskNudge).toBe(false);
    expect(parseHermesCondition("hermes+eden+pushUnsureAskNudge", { config: ALL, defaults }).config).toEqual({
      ...ALL,
      pushUnsureAskNudge: true,
    });
    expect(() => parseHermesCondition("hermes+eden+pushUnsureAskNudges", { config: ALL, defaults })).toThrow(
      /no engine setting/,
    );
  });
  test("+pushCheckedWhy enables only the checked packet trial", () => {
    const c = parseHermesCondition("hermes+eden+pushCheckedWhy", { config: ALL, defaults });
    expect(c.config).toEqual({ ...ALL, pushCheckedWhy: true });
    expect(DEFAULT_CONFIG.pushCheckedWhy).toBe(false);
  });
  test("hermes is the source tools alone; hermes+eden adds Eden over the same tools", () => {
    const h = parseHermesCondition("hermes", { config: ALL });
    expect([h.name, h.useTools, h.withPartner, h.eden]).toEqual(["hermes", true, false, false]);
    const e = parseHermesCondition("hermes+eden", { config: ALL });
    expect([e.name, e.useTools, e.withPartner, e.useEden, e.eden, e.judge]).toEqual([
      "hermes+eden",
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(e.config).toEqual(ALL);
    expect(e.waitMs).toBe(3_000);
  });

  test("hermes-eden is Eden in place of the source tools, Pi's eden arm (A16)", () => {
    const c = parseHermesCondition("hermes-eden", { config: ALL });
    expect([c.name, c.useTools, c.withPartner, c.useEden, c.askTool, c.eden]).toEqual([
      "hermes-eden",
      false,
      true,
      true,
      true,
      true,
    ]);
    expect(parseHermesCondition("hermes-eden@w0", { config: ALL }).waitMs).toBe(0);
    expect(() => parseHermesCondition("hermes-edenx", { config: ALL })).toThrow(/unknown condition/);
    expect(() => parseHermesCondition("hermes+eden+ephemeral", { config: ALL })).toThrow(/layouts/);
  });

  test("variants, flags and waits parse as in pi-conditions, and every Eden arm pairs with hermes", () => {
    const variants = parseVariants('{"A5":{"askDedup":true}}');
    const c = parseHermesCondition("hermes+eden~A5+compactParts@w0", { config: ALL, variants, defaults });
    expect(c.config).toEqual({ ...ALL, askDedup: true, compactParts: true });
    expect(c.waitMs).toBe(0);
    expect(c.name).toBe("hermes+eden~A5+compactParts@w0");
    for (const n of ["hermes+eden", "hermes+eden~A5", "hermes+eden+compactParts"]) expect(pairedWith(n)).toBe("hermes");
  });

  test("other names, the judge, --act and duplicates throw", () => {
    for (const bad of ["eden", "tools", "hermes-edenx", "hermes+edenx", "hermes+eden-judge", "hermes-eden-judge"]) {
      expect(() => parseHermesCondition(bad, { config: ALL })).toThrow();
    }
    expect(() => parseHermesCondition("hermes", { config: ALL, act: true })).toThrow(/no --act/);
    expect(() => parseHermesConditions(["hermes", "hermes"], { config: ALL })).toThrow(/twice/);
    expect(() => parseHermesCondition("hermes+eden+nope", { config: ALL, defaults })).toThrow(/no engine setting/);
  });
});
