import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  WAVE_16_19_CATCHERS,
  WAVE_21_CATCHERS,
  WAVE_22_CATCHERS,
  WAVE_LEFTOVERS,
  autoApproveCheck,
  openLeftovers,
  renderTreeLetter,
  treeCheck,
  treeSnapshot,
} from "./tree";
import { customerStudies } from "./claims";

const ROOT = resolve(import.meta.dir, "../../..");
const ROADMAP = readFileSync(resolve(ROOT, "docs/ROADMAP.md"), "utf8");

describe("tree inventory", () => {
  test("Wave 16–20 has no Open; Wave 21 closed; customer n is 0", () => {
    const snap = treeSnapshot();
    expect(snap.open16_20).toBe(0);
    expect(snap.closed).toBe(true);
    expect(snap.customers).toBe(0);
    expect(customerStudies()).toEqual([]);
    expect(snap.open21_22).toBe(0);
    expect(openLeftovers("21-22")).toEqual([]);
    expect(openLeftovers("16-20")).toEqual([]);
    expect(WAVE_LEFTOVERS.filter((r) => r.band === "21").every((r) => r.status === "shipped")).toBe(true);
  });

  test("letter says closed, names Wave 21 closed and Wave 22 Later, never SOC2 certified or a customer n", () => {
    const letter = renderTreeLetter();
    expect(letter).toMatch(/^Tree closed — Wave 16–20/);
    expect(letter).toMatch(/Wave 21 closed/);
    expect(letter).not.toMatch(/Wave 21 stays Next/);
    expect(letter).toMatch(/Wave 22\.2 shipped · 22\.1 Later/);
    expect(letter).toMatch(/Customer studies {7}0/);
    expect(letter).toMatch(/Human Approve {10}required/);
    expect(letter).toMatch(/skills-only/);
    expect(letter).toMatch(/21\.4/);
    expect(letter).not.toMatch(/certified SOC|SOC 2 certified/i);
    expect(letter).not.toMatch(/Tree closed — Wave 21/);
    const tree = treeCheck();
    expect(tree.ok).toBe(true);
    expect(tree.count).toBe(0);
    expect(tree.detail).toMatch(/Wave 16–20 0 open/);
    expect(tree.detail).toMatch(/Wave 21 closed/);
  });

  test("ROADMAP §4.12 leftover names match the frozen table; Wave 16–21 rows are Shipped or Limit", () => {
    const section = ROADMAP.split("### 4.12")[1]?.split("\n## 5.")[0] ?? "";
    expect(section.length).toBeGreaterThan(200);
    for (const r of WAVE_LEFTOVERS.filter((x) => x.band === "16-20" || x.band === "21")) {
      expect(section).toContain(r.close);
      const line = section
        .split("\n")
        .find((l) => l.includes(`| ${r.close} `) || l.includes(`| ${r.close} ·`) || l.includes(`| ${r.close}|`));
      expect(line ?? section).toMatch(/Shipped|Limit/);
      expect(line ?? "").not.toMatch(/\|\s*Open\s*\|/);
    }
  });

  test("auto-approve default is off; =1 is a named bypass", () => {
    expect(autoApproveCheck(undefined).ok).toBe(true);
    expect(autoApproveCheck("").ok).toBe(true);
    expect(autoApproveCheck("0").ok).toBe(true);
    expect(autoApproveCheck("1").ok).toBe(false);
    expect(autoApproveCheck("1").detail).toBe("EDEN_AUTO_APPROVE on · human gate bypassed");
  });

  test("Wave 16–19 catcher marks are listed", () => {
    expect(WAVE_16_19_CATCHERS).toHaveLength(16);
    expect(new Set(WAVE_16_19_CATCHERS.map((c) => c.phase)).size).toBe(16);
  });

  test("Wave 21 catcher marks are listed", () => {
    expect(WAVE_21_CATCHERS).toHaveLength(4);
    expect(new Set(WAVE_21_CATCHERS.map((c) => c.phase)).size).toBe(4);
  });

  test("Wave 22 catcher marks are listed", () => {
    expect(WAVE_22_CATCHERS).toHaveLength(1);
    expect(WAVE_22_CATCHERS[0]?.phase).toBe("22.2");
  });
});
