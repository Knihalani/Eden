import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@eden/engine";
import { parseHermesCondition, parseHermesConditions } from "./hermes-conditions";
import { pairedWith, parseVariants } from "./pi-conditions";

const ALL = { sync: true, cards: true };
const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;

describe("hermes-ab conditions", () => {
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

  test("variants, flags and waits parse as in pi-conditions, and every Eden arm pairs with hermes", () => {
    const variants = parseVariants('{"A5":{"askGuard":true}}');
    const c = parseHermesCondition("hermes+eden~A5+packetBearing@w0", { config: ALL, variants, defaults });
    expect(c.config).toEqual({ ...ALL, askGuard: true, packetBearing: true });
    expect(c.waitMs).toBe(0);
    expect(c.name).toBe("hermes+eden~A5+packetBearing@w0");
    for (const n of ["hermes+eden", "hermes+eden~A5", "hermes+eden+packetBearing"])
      expect(pairedWith(n)).toBe("hermes");
  });

  test("other names, the judge, --act and duplicates throw", () => {
    for (const bad of ["eden", "tools", "hermes-eden", "hermes+edenx", "hermes+eden-judge"]) {
      expect(() => parseHermesCondition(bad, { config: ALL })).toThrow();
    }
    expect(() => parseHermesCondition("hermes", { config: ALL, act: true })).toThrow(/no --act/);
    expect(() => parseHermesConditions(["hermes", "hermes"], { config: ALL })).toThrow(/twice/);
    expect(() => parseHermesCondition("hermes+eden+nope", { config: ALL, defaults })).toThrow(/no engine setting/);
  });
});
