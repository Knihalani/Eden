/**
 * Wave 19 limits board pin.
 *
 *   bun test benchmarks/campaign/limits-board.test.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  claimById,
  claimsOf,
  parseClaimsKind,
  renderClaimsBoard,
} from "@eden/measure";
import { PUBLIC_COPY_PATHS, scanPublicFiles, scanPublicText, winTableHas } from "@eden/measure/publish-check";
import { LIMIT_CLAIMS } from "../../apps/web/app/(notes)/isolation/copy";
import { LIMITS, PROOF_COUNTS, WINS } from "../../apps/web/app/(notes)/proof/copy";
import { surfaceCheck, surfaceModeOf } from "../../packages/cli/src/doctor";
import { claimsHelp } from "../../packages/cli/src/claims";
import { surfaceMode } from "@eden/wrap";

const ROOT = join(import.meta.dir, "../..");

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(next));
    else out.push(next);
  }
  return out;
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("Wave 19.1 live-invoice cell", () => {
  test("landing, proof, whitepaper, digest have zero billed S1b invoice quotes", () => {
    const roots = [
      join(ROOT, "apps/web/app/landing"),
      join(ROOT, "apps/web/app/(marketing)"),
      join(ROOT, "apps/web/app/(notes)/proof"),
      join(ROOT, "docs/whitepaper.md"),
      join(ROOT, "packages/cli/src/digest.ts"),
      join(ROOT, "packages/measure/src/digest.ts"),
    ];
    const hits: string[] = [];
    for (const root of roots) {
      const files = existsSync(root) && !root.endsWith(".ts") && !root.endsWith(".md") ? filesUnder(root) : [root];
      for (const file of files) {
        if (!existsSync(file) || file.endsWith(".test.ts")) continue;
        const text = readFileSync(file, "utf8");
        for (const line of text.split("\n")) {
          if (/(billed S1b|Claude Code invoice)/i.test(line) && !/not a live|retired|no live Claude Code invoice/i.test(line)) {
            hits.push(`${file}: ${line.trim()}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test("analogue −9.1% is labeled analogue; LIVE-AB retired cell stays retired", () => {
    const analogue = claimById("s1b-analogue");
    expect(analogue?.kind).toBe("analogue");
    expect(analogue?.printed).toMatch(/analogue/i);
    expect(analogue?.statement).toMatch(/not a live Claude Code invoice/i);
    expect(WINS.some((c) => c.id === "s1b-analogue")).toBe(false);
    const retired = claimById("s1b-live-invoice");
    expect(retired?.kind).toBe("retired");
    expect(read("benchmarks/campaign/LIVE-AB.md")).toMatch(/\*\*retired\*\*/);
    expect(read("benchmarks/campaign/LIVE-AB.md")).toMatch(/The analogue −9\.1% cell is not a live bill/);
  });
});

describe("Wave 19.2 oblivious-long", () => {
  test("win tables do not list it; PUBLIC_CLAIMS and isolation copy name the deltas", () => {
    expect(winTableHas("oblivious-long")).toBe(false);
    expect(claimsOf("win").some((c) => c.id === "oblivious-long")).toBe(false);
    const row = claimById("oblivious-long");
    expect(row?.kind).toBe("limit");
    expect(row?.printed).toBe("+2.8% cents / +3.2% wall");
    const iso = LIMIT_CLAIMS.find((c) => c.id === "oblivious-long");
    expect(iso?.claim).toMatch(/oblivious-long/);
    expect(iso?.claim).toMatch(/\+2\.8% cents/);
    expect(iso?.claim).toMatch(/\+3\.2% wall/);
    expect(iso?.claim).toMatch(/not a win table row/);
    expect(read("docs/isolation.md")).toMatch(/oblivious-long/);
    expect(read("docs/isolation.md")).toMatch(/\+2\.8% cents/);
  });
});

describe("Wave 19.3 JIT soak pin", () => {
  test("FAIL precision=0.789 n=38 stays the pin; default surface is all", () => {
    const pin = read("benchmarks/campaign/JIT-SOAK.md");
    expect(pin).toMatch(/precision=0\.789 n=38/);
    expect(pin).toMatch(/verdict=FAIL/);
    expect(pin).toMatch(/surfaceMode_unset=all/);
    expect(pin).toMatch(/JIT_DEFAULT=all/);
    expect(pin).toMatch(/Measurement-only/);
    expect(pin).not.toMatch(/retuned the soak fixture/);
    const row = claimById("jit-soak");
    expect(row?.kind).toBe("limit");
    expect(row?.printed).toBe("FAIL precision=0.789 n=38");
    expect(LIMITS.some((c) => c.id === "jit-soak")).toBe(true);
    expect(WINS.some((c) => c.id === "jit-soak")).toBe(false);
    delete process.env.EDEN_SURFACE;
    expect(surfaceMode()).toBe("all");
    expect(surfaceModeOf(undefined)).toBe("all");
    expect(surfaceCheck(undefined).detail).toMatch(/precision=0\.789 n=38/);
    expect(surfaceCheck("jit").detail).toMatch(/opt-in/);
  });
});

describe("Wave 19.4 replica host-drop", () => {
  test("HOST-DROP.md remains the close; landing and proof never claim a live ack", () => {
    const host = read("benchmarks/campaign/HOST-DROP.md");
    expect(host).toMatch(/host limit/i);
    expect(host).toMatch(/Replica host-drop is a permanent/);
    expect(host).toMatch(/Live Claude Code cannot ack/i);
    const titleHits: string[] = [];
    for (const file of [
      ...filesUnder(join(ROOT, "apps/web/app/landing")),
      ...filesUnder(join(ROOT, "apps/web/app/(marketing)")),
      join(ROOT, "apps/web/app/(notes)/proof/copy.ts"),
      join(ROOT, "apps/web/app/(notes)/proof/page.tsx"),
    ]) {
      if (file.endsWith(".test.ts")) continue;
      const text = readFileSync(file, "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        if (!/live[- ]host-drop/i.test(line)) continue;
        if (/not|never|cannot|limit|replica/i.test(line)) continue;
        titleHits.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(titleHits).toEqual([]);
    const row = LIMITS.find((c) => c.id === "replica-host-drop");
    expect(row?.id).not.toMatch(/live-host-drop/);
    expect(row?.name).toBe("replica host-drop");
    expect(row?.name).not.toMatch(/live host-drop/i);
    expect(row?.source).toBe("host-limit");
    const iso = LIMIT_CLAIMS.find((c) => c.id === "replica-host-drop");
    expect(iso?.claim).toMatch(/Replica host-drop is a host limit/);
    expect(iso?.claim).toMatch(/not claimed to ack/);
    expect(iso?.test).toBe("benchmarks/campaign/HOST-DROP.md");
  });
});

describe("board + publish-check", () => {
  test("eden claims letter puts oblivious-long under limits, analogue labeled, invoice retired", () => {
    const letter = renderClaimsBoard();
    expect(letter).toMatch(/^eden claims — published limits board/m);
    expect(letter).toContain(PROOF_COUNTS);
    expect(parseClaimsKind("limit")).toBe("limit");
    expect(parseClaimsKind("nope")).toBeNull();
    const limits = renderClaimsBoard(undefined, { kind: "limit" });
    expect(limits).toMatch(/oblivious-long/);
    expect(limits).toMatch(/\+2\.8% cents \/ \+3\.2% wall/);
    expect(limits).not.toMatch(/^WINS$/m);
    expect(letter.indexOf("LIMITS")).toBeGreaterThan(letter.indexOf("WINS"));
    expect(letter).toMatch(/−9\.1% cents \(analogue\)/);
    expect(letter).toMatch(/S1b live Claude Code invoice/);
    expect(letter).toMatch(/retired · retired · retired/);
    expect(claimsHelp()).toMatch(/not a live Claude Code invoice/);
    expect(winTableHas("oblivious-long")).toBe(false);
  });

  test("expanded public copy scans clean; hard-case sentences still find", () => {
    const paths = PUBLIC_COPY_PATHS.map((p) => join(ROOT, p));
    expect(scanPublicFiles(paths)).toEqual([]);
    const bad = scanPublicText(
      "x.md",
      [
        "Live Claude Code billed −9.1% TURN_CENTS.",
        "oblivious-long is a WIN on wrap skipRest.",
        "Live Claude Code ack of host-drop.",
        "UNCERTIFIED programs win 4× cheaper.",
        "A billed S1b live Claude Code invoice saved 9%.",
        "Hook remainder −9.1% cents vs raw.",
      ].join("\n"),
    );
    expect(bad.map((f) => f.rule).sort()).toEqual([
      "analogue-as-live",
      "billed-s1b-invoice",
      "oblivious-as-win",
      "replica-drop-as-live-ack",
      "uncertified-as-win",
      "unlabeled-analogue",
      "unlabeled-analogue",
    ]);
  });
});
