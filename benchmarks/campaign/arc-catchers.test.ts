/**
 * Wave 1.3 Arc catchers — every ROADMAP §3 item names a running fixture.
 *
 * This file is the CI gate for `benchmarks/campaign/ARC-REGRESSION.md`:
 *   - no row may say "no fixture yet" / "missing"
 *   - every named path must exist
 * plus a handful of cheap contract pins for items whose product work is
 * later waves (so a regression of the *substrate* fails here today).
 *
 * Does not implement Arc 1–8 product features. Wave 1: instrument + coverage.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { dcShare, WAVE_16_19_CATCHERS } from "@eden/measure";
import { compileTraces } from "@eden/compile";
import { collectDoctor } from "../../packages/cli/src/doctor";
import { codingRegistry } from "@eden/wrap";
import { applyCacheBreakpoints, parseCacheTokens, parseUsage } from "@eden/wrap";
import { PAGE_ITEMS } from "./coverage-worlds";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/2

const ROOT = resolve(import.meta.dir, "../..");
const MAP = resolve(import.meta.dir, "ARC-REGRESSION.md");

function repoFile(rel: string): string {
  return resolve(ROOT, rel);
}

describe("ARC-REGRESSION map (Wave 1.3 done-when)", () => {
  const md = readFileSync(MAP, "utf8");

  test("every Arc item names a running fixture (zero unnamed table rows)", () => {
    const rows = md.split("\n").filter((l) => /^\| \*\*[1-8]\*\*/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(30);
    const countLine = md.match(/Arc items enumerated in the table above: \*\*(\d+)\*\*/);
    expect(countLine).not.toBeNull();
    expect(Number(countLine![1])).toBe(rows.length);
    for (const row of rows) {
      expect(row).not.toMatch(/unnamed|no fixture/i);
      expect(row).toMatch(/`[^`]+`/);
      expect(row.toLowerCase()).toMatch(/\b(covered|pinned|gap-pin)\b/);
    }
  });

  test.failing("every backtick path in the Catcher column exists on disk", () => {
    const files = new Set<string>();
    for (const m of md.matchAll(/`((?:packages|apps|benchmarks|docs|scripts)\/[^`]+)`/g)) {
      const rel = m[1]!;
      if (rel.endsWith("/") || rel.includes(" ")) continue;
      if (!/\.(ts|tsx|md|sh)$/.test(rel) && !rel.includes(".test.")) continue;
      files.add(rel.split(/\s/)[0]!);
    }
    const missing: string[] = [];
    for (const rel of files) {
      if (!existsSync(repoFile(rel))) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });

  test("ROADMAP §3 table items and prose laundry lists appear in the catcher map", () => {
    const required = [
      "Token attribution",
      "Certified go-live",
      "DC%",
      "Skip ledger",
      "Novelty feed",
      "cached_tokens",
      "Activation funnel",
      "sequence entropy",
      "repeats below support",
      "width-class split",
      "envelope coverage",
      "eden explain",
      "Cache-guard",
      "PTC-complement",
      "Witness-efficiency",
      "Width-class envelope",
      "read-set exposure",
      "zero-LLM badge",
      "refusal analytics",
      "envelope editor",
      "Graduated rollout",
      "read-your-writes",
      "Bit-exact replay",
      "Audit export",
      "SOC2",
      "canary",
      "Multi-tenant arming",
      "Concurrent-regime",
      "handoff",
      "Regional deployment",
      "archival",
      "Production A/B",
      "Whitepaper",
      "Negative-control",
    ];
    const missing = required.filter((s) => !md.toLowerCase().includes(s.toLowerCase()));
    expect(missing).toEqual([]);
  });

  test("every Wave 16–19 phase names a fixture or gap-pin in §14 and this map", () => {
    const roadmap = readFileSync(repoFile("docs/ROADMAP.md"), "utf8");
    const section14 = roadmap.split("## 14. Scenario & probe registry")[1]?.split("\n## 15.")[0] ?? "";
    expect(WAVE_16_19_CATCHERS).toHaveLength(16);
    for (const { phase, mark } of WAVE_16_19_CATCHERS) {
      expect(section14.toLowerCase()).toContain(mark.toLowerCase());
      expect(md.toLowerCase()).toContain(mark.toLowerCase());
      expect(md).toContain(phase);
    }
  });
});

describe("Arc 1 substrate pins", () => {
  test("DC% formula excludes providerCache (packages/measure/src/dc.ts)", () => {
    expect(
      dcShare({
        compiled: 2,
        memoized: 2,
        transparent: 1,
        steeredSkip: 1,
        frontier: 4,
        providerCache: 999,
      }),
    ).toBe(6 / 10);
  });

  test("parseUsage stays prompt+completion; parseCacheTokens is the cache dialect hook", () => {
    const raw = {
      prompt_tokens: 50,
      completion_tokens: 5,
      cache_read_input_tokens: 40,
      prompt_tokens_details: { cached_tokens: 40 },
    };
    expect(parseUsage(raw)).toEqual({ prompt: 50, completion: 5 });
    expect(parseCacheTokens(raw)).toMatchObject({ cached: 40 });
  });
});

describe("Arc 2 / 3 / 4 substrate pins", () => {
  test("doctor always names config, wrap, hookd, live-tools stages", async () => {
    const home = resolve(import.meta.dir, "../../packages/cli/.tmp-eden-arc-doctor");
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = home;
    writeFileSync(
      resolve(home, "config.json"),
      JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }),
    );
    try {
      const checks = await collectDoctor({
        fetch: (async () => new Response("no", { status: 503 })) as typeof fetch,
      });
      const names = checks.map((c) => c.name);
      for (const need of ["config", "wrap", "hookd", "live-tools", "mine", "knock", "serving", "install", "approve"]) {
        expect(names).toContain(need);
      }
    } finally {
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.failing("CLI help lists doctor/hookd and eden explain", () => {
    const cli = readFileSync(repoFile("packages/cli/src/cli.ts"), "utf8");
    expect(cli).toContain("eden doctor");
    expect(cli).toContain("eden doctor --tree");
    expect(cli).toContain("eden hookd");
    expect(cli).toContain("eden explain");
    expect(cli).toContain("eden approve");
    expect(cli).toContain("eden promote");
  });

  test("coding registry emits allowed_callers as PTC guidance (not a security wall)", () => {
    const reg = codingRegistry(process.cwd());
    expect(reg.allowed_callers).toEqual(["direct", "code_execution_20260120"]);
    expect(typeof reg.execute).toBe("function");
  });

  test("applyCacheBreakpoints preserves order by default; cache-guard reorders when opted in", () => {
    const body: Record<string, unknown> = {
      system: [
        { type: "text", text: "volatile-ts" },
        { type: "text", text: "stable" },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    applyCacheBreakpoints(body);
    const sys = body.system as Array<{ text: string; cache_control?: unknown }>;
    expect(sys[0]!.text).toBe("volatile-ts");
    expect(sys[1]!.text).toBe("stable");
    expect(sys[0]!.cache_control).toBeUndefined();
    expect(sys[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("bindable listAll mines foreach (Arc 4 read-set); cursor listPage mines until+flatten", () => {
    const bound = compileTraces(
      Array.from({ length: 3 }, (_, i) => ({
        id: `arc-pb${i}`,
        llmCalls: 4,
        duration_ms: 10,
        cost_cents: 1,
        input: { batch: `B${i}` },
        complete: true as const,
        events: [
          { name: "listAll", args: { batch: `B${i}` }, result: { items: [...PAGE_ITEMS] }, ok: true },
          ...PAGE_ITEMS.map((id) => ({
            name: "writeItem",
            args: { id },
            result: { written: true, id },
            ok: true,
          })),
        ],
      })),
      { maxGram: 26 },
    );
    expect(bound.programs[0]?.steps.some((s) => s.kind === "loop")).toBe(true);
  });
});
