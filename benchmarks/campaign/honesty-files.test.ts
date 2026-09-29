/**
 * Wave 21 honesty files.
 *
 *   bun test benchmarks/campaign/honesty-files.test.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claimById, PUBLIC_CLAIMS, renderClaimsListing, WAVE_21_CATCHERS, WAVE_22_CATCHERS } from "@eden/measure";
import { surfaceMode } from "@eden/wrap";
import { LIMIT_CLAIMS, ISO_ANALOGUE_ROWS, ISO_LIMIT_ROWS, ISO_RETIRED_ROWS } from "../../apps/web/app/(notes)/isolation/copy";

const ROOT = join(import.meta.dir, "../..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("Wave 21.1 cited file", () => {
  test("oblivious-long file is the measurement close, not ROADMAP", () => {
    const row = claimById("oblivious-long");
    expect(row?.file).toBe("benchmarks/campaign/OBLIVIOUS-LONG.md");
    expect(existsSync(join(ROOT, row!.file))).toBe(true);
    expect(read(row!.file)).toMatch(/\+2\.8% cents \/ \+3\.2% wall/);
    expect(read(row!.file)).toMatch(/Limit, not a win/);
    for (const c of PUBLIC_CLAIMS) {
      expect(c.file, c.id).not.toMatch(/ROADMAP/);
    }
    const header = read("packages/measure/src/claims.ts");
    expect(header).not.toMatch(/Frozen public claims for Wave 8/);
    expect(header).toMatch(/Wave 21 honesty files/);
  });

  test("isolation, proof, claims letter, marketplace draft cite that file", () => {
    const file = "benchmarks/campaign/OBLIVIOUS-LONG.md";
    expect(LIMIT_CLAIMS.find((r) => r.id === "oblivious-long")?.test).toBe(file);
    expect(read("docs/isolation.md")).toContain(file);
    expect(read("docs/whitepaper.md")).toContain(file);
    expect(read("docs/marketplace-draft.md")).toContain(file);
    expect(renderClaimsListing()).toContain(file);
    expect(read("docs/marketplace-draft.md")).toBe(renderClaimsListing());
  });
});

describe("Wave 21.2 isolation class", () => {
  test("analogue and retired are their own lists; Kind/Source on every pin", () => {
    expect(ISO_LIMIT_ROWS.every((r) => r.kind === "limit")).toBe(true);
    expect(ISO_ANALOGUE_ROWS.every((r) => r.kind === "analogue")).toBe(true);
    expect(ISO_RETIRED_ROWS.every((r) => r.kind === "retired")).toBe(true);
    expect(ISO_LIMIT_ROWS.map((r) => r.id).sort()).toEqual(
      PUBLIC_CLAIMS.filter((c) => c.kind === "limit")
        .map((c) => c.id)
        .sort(),
    );
    for (const row of LIMIT_CLAIMS) {
      expect(row.claim).toBe(claimById(row.id)?.statement);
    }
    expect(ISO_LIMIT_ROWS.some((r) => r.id === "oblivious-long")).toBe(true);
    expect(ISO_LIMIT_ROWS.some((r) => r.id === "ood-long")).toBe(true);
    expect(ISO_LIMIT_ROWS.some((r) => r.id === "cert-bounds")).toBe(true);
    expect(ISO_LIMIT_ROWS.some((r) => r.id === "jit-soak")).toBe(false);
    expect(ISO_ANALOGUE_ROWS.some((r) => r.id === "s1b-analogue")).toBe(true);
    expect(ISO_RETIRED_ROWS.some((r) => r.id === "s1b-live-invoice")).toBe(true);
    expect(ISO_LIMIT_ROWS.some((r) => r.kind === "analogue")).toBe(false);
    const page = read("apps/web/app/(notes)/isolation/page.tsx");
    expect(page).toContain("iso-limits-analogue");
    expect(page).toContain("iso-limits-retired");
    expect(page).toContain("ClaimTable");
    expect(page).not.toMatch(/className="[^"]*ship/);
    const table = read("apps/web/app/(notes)/claim-table.tsx");
    expect(table).toContain("<th>Kind</th>");
    expect(table).toContain("<th>Source</th>");
    expect(table).toContain("LIMIT_KEY");
    expect(table).toContain("CLASS_KEY");
    expect(page).toContain("LIMIT_KEY");
  });
});

describe("Wave 21.3 proof cases chrome", () => {
  test("cases use the same Kind/Source table as wins; customer n is 0", () => {
    const page = read("apps/web/app/(notes)/proof/page.tsx");
    expect(page).toContain("fromFixtures(FIXTURES)");
    expect(page).toContain("Fixture verticals");
    expect(page).not.toContain("<h2 id=\"proof-cases\">Case studies</h2>");
    expect(page).toContain("ClaimTable");
    expect(page).toContain("tag: \"fixture\"");
    expect(page).toContain("row.vertical");
    expect(page).not.toContain("iso-owasp");
    expect(page).toContain("CLASS_KEY");
    expect(read("docs/cases.md")).toMatch(/\| Kind \| Source \|/);
    expect(read("docs/cases.md")).toMatch(/fixture/);
    expect(read("docs/cases.md")).toMatch(/Customer-approved measured studies: \*\*0\*\*/);
  });
});

describe("Wave 21 catchers", () => {
  test("ARC-REGRESSION names 21.1–21.4", () => {
    const md = read("benchmarks/campaign/ARC-REGRESSION.md");
    expect(WAVE_21_CATCHERS).toHaveLength(4);
    for (const { phase, mark } of WAVE_21_CATCHERS) {
      expect(md).toContain(phase);
      expect(md).toContain(mark);
    }
    expect(md).toMatch(/Wave 21 \*\(landed\)\*/);
  });
});

describe("Wave 22 catchers", () => {
  test("ARC-REGRESSION names 22.2", () => {
    const md = read("benchmarks/campaign/ARC-REGRESSION.md");
    expect(WAVE_22_CATCHERS).toHaveLength(1);
    for (const { phase, mark } of WAVE_22_CATCHERS) {
      expect(md).toContain(phase);
      expect(md).toContain(mark);
    }
  });
});

describe("Wave 21.4 soak pin", () => {
  test("file still records the historical FAIL; live default is jit after 22.2", () => {
    const pin = read("benchmarks/campaign/JIT-SOAK.md");
    expect(pin).toMatch(/Wave 21\.4/);
    expect(pin).toMatch(/precision=0\.789 n=38/);
    expect(pin).toMatch(/verdict=FAIL/);
    expect(pin).toMatch(/surfaceMode_unset=all/);
    expect(pin).toMatch(/Measurement-only/);
    expect(pin).toMatch(/Wave 22\.2/);
    expect(pin).toMatch(/precision=1\.000 n=38/);
    expect(pin).toMatch(/surfaceMode_unset=jit/);
    expect(pin).toMatch(/verdict=PASS/);
    delete process.env.EDEN_SURFACE;
    expect(surfaceMode()).toBe("jit");
  });
});
