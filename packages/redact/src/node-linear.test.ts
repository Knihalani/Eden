/**
 * D1850: the gate stays linear on V8 too. `gate-linear.test.ts` holds each crafted input under a CPU ceiling on Bun
 * (JavaScriptCore); this runs the same inputs on Node 24+ (`REDACT_NODE`, else `node` on the PATH; skipped when there
 * is none that new) through `node-linear.ts`. At 256 KB the slowest (eden-keyword) took 55 ms of CPU on Node 24.22
 * on the development VM (2026-11-14), against 1.5 s here, as on Bun: a quadratic slip would take seconds.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CRAFTED_UNITS } from "./gate-crafted.ts";

const NODE = process.env.REDACT_NODE ?? "node";
const version = spawnSync(NODE, ["--version"], { encoding: "utf8" });
const major = version.status === 0 ? Number(/^v(\d+)/.exec(version.stdout)?.[1] ?? 0) : 0;
const SIZE = 262_144;
const CEILING_MS = 1_500;

describe("the gate on crafted input, on Node", () => {
  test.skipIf(major < 24)(
    `every crafted input at 256 KB under ${CEILING_MS} ms of CPU`,
    () => {
      const run = spawnSync(NODE, [join(import.meta.dir, "node-linear.ts"), String(SIZE)], { encoding: "utf8" });
      expect(run.stderr).toBe("");
      const times = JSON.parse(run.stdout) as Record<string, number>;
      expect(Object.keys(times)).toEqual(CRAFTED_UNITS.map(([name]) => name));
      const over = Object.entries(times).filter(([, ms]) => ms >= CEILING_MS);
      expect(over).toEqual([]);
    },
    120_000,
  );
});
