import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_CLAIMS, claimById, claimsOf, customerStudies, fixtureStudies } from "./claims";

const ROOT = join(import.meta.dir, "../../..");

describe("public claims", () => {
  test("every claim points at a file that exists (retired may land this wave)", () => {
    expect(PUBLIC_CLAIMS.length).toBeGreaterThanOrEqual(12);
    for (const c of PUBLIC_CLAIMS) {
      if (c.kind === "retired" || c.source === "retired" || c.source === "host-limit") continue;
      expect(existsSync(join(ROOT, c.file)), c.file).toBe(true);
    }
  });

  test("oblivious-long is a limit, never a win", () => {
    const row = claimById("oblivious-long");
    expect(row?.kind).toBe("limit");
    expect(claimsOf("win").some((c) => c.id === "oblivious-long")).toBe(false);
    expect(row?.printed).toMatch(/\+/);
  });

  test("jit-soak FAIL is a limit, never a win", () => {
    const row = claimById("jit-soak");
    expect(row?.kind).toBe("limit");
    expect(row?.printed).toBe("FAIL precision=0.789 n=38");
    expect(claimsOf("win").some((c) => c.id === "jit-soak")).toBe(false);
    expect(existsSync(join(ROOT, row!.file))).toBe(true);
  });

  test("S1b analogue is tagged analogue-headless, not live-invoice, not a win", () => {
    const row = claimById("s1b-analogue");
    expect(row?.kind).toBe("analogue");
    expect(row?.source).toBe("analogue-headless");
    expect(row?.printed).toMatch(/analogue/i);
    expect(row?.statement).toMatch(/not a live Claude Code invoice/i);
    expect(claimsOf("win").some((c) => c.id === "s1b-analogue")).toBe(false);
    expect(PUBLIC_CLAIMS.filter((c) => c.source === "analogue-headless").every((c) => c.kind !== "win")).toBe(true);
  });

  test("live invoice quote is retired until a file parses", () => {
    const row = claimById("s1b-live-invoice");
    expect(row?.kind).toBe("retired");
    expect(row?.printed).toBe("retired");
  });

  test("fixture studies are campaign verticals, not customers", () => {
    const fixtures = fixtureStudies();
    expect(fixtures.map((c) => c.vertical).sort()).toEqual(["desk", "etl", "incident", "orders", "support"]);
    expect(customerStudies()).toEqual([]);
    expect(fixtures.every((c) => c.approved !== true)).toBe(true);
  });

  test("parity table has unique-work, creative, micro, chaos-observe", () => {
    const ids = claimsOf("parity").map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["unique-work", "creative", "micro", "chaos-observe"]));
  });
});
