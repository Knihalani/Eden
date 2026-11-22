import { describe, expect, test } from "bun:test";
import { EDEN_CONTEXT_GUIDE } from "@eden/protocol";
import { DEFAULT_CONFIG } from "@eden/engine";
import { systemPrompt, worldOf } from "./ab-common";
import { parseHermesCondition } from "./hermes-conditions";
import { parseCondition } from "./pi-conditions";

describe("integrator system-prompt guide (D2104)", () => {
  const { world } = worldOf(41, "train1", "hidden", { maxTasks: 1, maxOffworld: 0 });
  const options = { config: {}, defaults: DEFAULT_CONFIG as unknown as Record<string, unknown> };

  for (const [base, parse] of [
    ["hermes+eden", parseHermesCondition],
    ["both", parseCondition],
  ] as const) {
    test(`${base}: only the opt-in prompt appends the canonical line`, () => {
      const off = parse(base, options);
      const on = parse(`${base}+edenGuide`, options);
      for (const tenant of [false, true]) {
        for (const act of [false, true]) {
          const promptOptions = { lookups: false, data: true, tenant, act };
          const before = systemPrompt(world, promptOptions);
          expect(systemPrompt(world, { ...promptOptions, edenGuide: off.edenGuide })).toBe(before);
          expect(before).not.toContain(EDEN_CONTEXT_GUIDE);
          const guided = systemPrompt(world, { ...promptOptions, edenGuide: on.edenGuide });
          expect(guided).toBe(`${before}\n${EDEN_CONTEXT_GUIDE}`);
          expect(guided.split(EDEN_CONTEXT_GUIDE)).toHaveLength(2);
        }
      }
      expect(EDEN_CONTEXT_GUIDE).not.toMatch(/[\r\n]/);
    });
  }
});
