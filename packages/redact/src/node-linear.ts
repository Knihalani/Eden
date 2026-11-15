/**
 * Test support for `node-linear.test.ts`, run by Node (D1850): the gate's CPU time on each crafted input
 * (`gate-crafted.ts`) at the size named by its argument, the lesser of two calls after a warm one, as one JSON object
 * on stdout. V8 is not JavaScriptCore: a path linear on one engine can backtrack or deoptimize on the other.
 */
import { CRAFTED_UNITS, crafted } from "./gate-crafted.ts";
import { gateOf, secretRules } from "./secrets.ts";

const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

export function craftedTimes(size: number): Record<string, number> {
  const rules = secretRules();
  for (const rule of rules) rule.warm?.();
  const gate = gateOf(rules);
  const out: Record<string, number> = {};
  for (const [name, unit] of CRAFTED_UNITS) {
    const text = crafted(unit, size);
    gate.sanitizeForStore(text.slice(0, 4_096));
    let best = Infinity;
    for (let k = 0; k < 2; k++) {
      const t0 = cpuMs();
      gate.sanitizeForStore(text);
      best = Math.min(best, cpuMs() - t0);
    }
    out[name] = best;
  }
  return out;
}

if (process.argv[1] === import.meta.filename) {
  process.stdout.write(JSON.stringify(craftedTimes(Number(process.argv[2]))));
}
