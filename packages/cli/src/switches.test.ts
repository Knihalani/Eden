import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PATH_ALLOWLIST,
  WAVE_16_19_SWITCHES,
  productionEdenNames,
  section15Switches,
  undocumentedSwitches,
} from "./switches";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/20

const ROOT = resolve(import.meta.dir, "../../..");
const ROADMAP = readFileSync(resolve(ROOT, "docs/ROADMAP.md"), "utf8");

describe("kill-switch inventory (Wave 20.3)", () => {
  test("every Wave 16–19 switch has a §15 row", () => {
    const rows = section15Switches(ROADMAP);
    for (const name of WAVE_16_19_SWITCHES) {
      expect(rows.has(name)).toBe(true);
    }
    expect(rows.has("EDEN_NET_ALLOW")).toBe(true);
    expect(rows.has("EDEN_HOOKD")).toBe(true);
    expect(rows.has("EDEN_WEBHOOK_RAW")).toBe(true);
  });

  test.failing("production EDEN_* is in §15 or the path/test allowlist", () => {
    const missing = undocumentedSwitches(ROADMAP, ROOT);
    expect(missing).toEqual([]);
  });

  test("path allowlist does not swallow a 16–19 kill-switch", () => {
    for (const name of WAVE_16_19_SWITCHES) {
      expect(PATH_ALLOWLIST.has(name)).toBe(false);
    }
  });

  test("production still reads EDEN_NET_ALLOW and EDEN_HOOKD", () => {
    const names = productionEdenNames(ROOT);
    expect(names).toContain("EDEN_NET_ALLOW");
    expect(names).toContain("EDEN_HOOKD");
    expect(names).toContain("EDEN_AUTO_APPROVE");
  });
});
