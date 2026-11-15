/**
 * docs/research/redact-perf.md: the gate's fast paths stay linear on input built against them (`gate-crafted.ts`:
 * dense anchors, the longest prefixes, marks and ligatures inside the prefilter's words, the two-character anchors,
 * one long run, separators). CPU time, not wall time (D811). Each 256 KB input took at most about 410 ms of CPU on the
 * development VM (2026-11-14; the slowest, keywords back to back, is as slow before the change: JavaScript's engine on
 * the rules' lazy prefixes); a quadratic slip would take seconds.
 */
import { describe, expect, test } from "bun:test";
import { CRAFTED_UNITS, crafted } from "./gate-crafted.ts";
import { gateOf, secretRules } from "./secrets.ts";

const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const SIZE = 262_144;
const CEILING_MS = 1_500;

describe("the gate on crafted input", () => {
  // Warmed as warmGate warms, on a gate of this file's own: calling warmGate here would mark the module's gate warm,
  // and warm.test.ts, when it shares the process, checks what warmGate does on its first call.
  const rules = secretRules();
  for (const rule of rules) rule.warm?.();
  const gate = gateOf(rules);
  for (const [name, unit] of CRAFTED_UNITS) {
    test(`256 KB of ${name}`, () => {
      const text = crafted(unit, SIZE);
      const t0 = cpuMs();
      gate.sanitizeForStore(text);
      expect(cpuMs() - t0).toBeLessThan(CEILING_MS);
    }, 20_000);
  }
});
