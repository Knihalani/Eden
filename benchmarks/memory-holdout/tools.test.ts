import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_PATH, RESULTS_PATH, REQUIRED_CASE_IDS, fixtureIssues, loadFixture } from "./run-tools.ts";
import { foldImports } from "../memoryagentbench/inject-gate";

const HOLD = import.meta.dir;
const TOOLS_MD = join(HOLD, "tools.md");

function walkSource(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules") continue;
    const next = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkSource(next));
    else if (ent.isFile() && (ent.name.endsWith(".ts") || ent.name.endsWith(".json") || ent.name.endsWith(".md"))) out.push(next);
  }
  return out;
}

describe("M2.4 tool-trace holdout fixture", () => {
  test("fixture schema + required AMA cases exist", () => {
    expect(existsSync(FIXTURE_PATH)).toBe(true);
    const fix = loadFixture();
    expect(fixtureIssues(fix)).toEqual([]);
    expect(fix.api_under_test).toBe("hook-inject");
    expect(fix.k).toBe("default");
    expect(fix.k_default).toBe(6);
    expect(fix.product).toEqual(expect.arrayContaining(["respondToHook", "memoryHookResponse", "openMemory"]));
    for (const id of REQUIRED_CASE_IDS) {
      const c = fix.cases.find((x) => x.id === id);
      expect(c, id).toBeTruthy();
      expect(c!.observe.some((e) => e.hook_event_name === "PostToolUse")).toBe(true);
      expect(c!.cue.hook_event_name).toBe("UserPromptSubmit");
      expect(c!.gold_needles.length).toBeGreaterThan(0);
    }
  });

  test("protocol docs exist and freeze hook inject (not LoCoMo 92 / k=40)", () => {
    expect(existsSync(TOOLS_MD)).toBe(true);
    const md = readFileSync(TOOLS_MD, "utf8");
    expect(md).toMatch(/hook inject/i);
    expect(md).toMatch(/respondToHook/);
    expect(md).toMatch(/memoryHookResponse/);
    expect(md).toMatch(/openMemory/);
    expect(md).toMatch(/\bk\b.*default/i);
    expect(md).toMatch(/arxiv:2602\.22769/);
    expect(md).toMatch(/not a published column/i);
    expect(md).toMatch(/LoCoMo 92/);
    expect(md).toMatch(/not bakeoff rec5/i);
    expect(md).toMatch(/Not a published column[\s\S]*k=40/);
    expect(md).toMatch(/bun benchmarks\/memory-holdout\/run-tools\.ts/);
  });

  test("TOOLS-RESULTS.md exists with dated per-case rows (verdict unconstrained)", () => {
    expect(existsSync(RESULTS_PATH)).toBe(true);
    const md = readFileSync(RESULTS_PATH, "utf8");
    expect(md).toMatch(/\*\*Date:\*\*\s+\d{4}-\d{2}-\d{2}/);
    expect(md).toMatch(/\*\*Overall:\*\*\s+(PASS|FAIL)/);
    expect(md).toMatch(/hook-inject/);
    for (const id of REQUIRED_CASE_IDS) {
      expect(md, id).toMatch(new RegExp(`\\|\\s*${id}\\s*\\|\\s*(PASS|FAIL)\\s*\\|`));
    }
    expect(md).toMatch(/bun benchmarks\/memory-holdout\/run-tools\.ts/);
  });

  test("holdout dir does not import BrainMemory or publish cortex: false", () => {
    const offenders: string[] = [];
    for (const file of walkSource(HOLD)) {
      const src = readFileSync(file, "utf8");
      for (const line of foldImports(src).split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("|")) continue;
        const js = /import\s*(?:type\s+)?(?:\{[^}]*\bBrainMemory\b[^}]*\}|\bBrainMemory\b)\s*from/.test(line);
        if (js && !line.includes("not-product")) offenders.push(`${file}: ${t}`);
        if (file.endsWith(".test.ts")) continue;
        if ((line.includes("cortex: false") || line.includes("cortex:false")) && !line.includes("not-product") && !/ban|not a published|must not|no `cortex: false`|as a published column/i.test(line)) {
          offenders.push(`${file}: ${t}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
