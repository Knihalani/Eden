import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { openMemory } from "../../src/index.ts";

const ROOT = join(import.meta.dir, "../..");
const BENCH = join(ROOT, "benchmarks");
const MAB = join(BENCH, "memoryagentbench");
const NOT_PRODUCT = "// not-product";

function walkSource(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules") continue;
    const next = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkSource(next));
    else if (ent.isFile() && (ent.name.endsWith(".ts") || ent.name.endsWith(".py"))) out.push(next);
  }
  return out;
}

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules") continue;
    const next = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkMarkdown(next));
    else if (ent.isFile() && ent.name.endsWith(".md")) out.push(next);
  }
  return out;
}

function brainMemoryImportLines(src: string): string[] {
  return src.split("\n").filter((line) => {
    const t = line.trim();
    if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) return false;
    const js = /import\s*(?:type\s+)?(?:\{[^}]*\bBrainMemory\b[^}]*\}|\bBrainMemory\b)\s*from\s*['"][^'"]*brain-memory/.test(line);
    const py = /\bfrom\s+\S*brain[_-]memory\S*\s+import\s+[^\n]*\bBrainMemory\b/.test(line);
    return js || py;
  });
}

describe("M1.1 inject API freeze", () => {
  test("new bench files cannot import BrainMemory without // not-product", () => {
    const offenders: string[] = [];
    for (const file of walkSource(BENCH)) {
      const src = readFileSync(file, "utf8");
      for (const line of brainMemoryImportLines(src)) {
        if (!line.includes(NOT_PRODUCT) && !line.includes("# not-product")) {
          offenders.push(`${relative(ROOT, file)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("product path still exports openMemory / processMemory / injectBody / hook / Anthropic inject", () => {
    const index = readFileSync(join(ROOT, "src/index.ts"), "utf8");
    expect(index).toContain("export function openMemory");
    expect(index).toContain("export function processMemory");

    const hook = readFileSync(join(ROOT, "packages/cli/src/memory-hook.ts"), "utf8");
    expect(hook).toContain("memoryHookResponse");
    expect(hook).toContain("openMemory");
    expect(hook).toMatch(/MEMORY_EVENTS[\s\S]*PostToolUse/);
    expect(hook).toMatch(/MEMORY_EVENTS[\s\S]*SubagentStop/);

    const proxy = readFileSync(join(ROOT, "packages/wrap/src/proxy.ts"), "utf8");
    const proxyLive = proxy.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(proxyLive).toMatch(/injectBodyThenObserveTools\(\s*processMemory\(\)/);
    expect(proxyLive).not.toMatch(/processMemory\(\)\s*\.injectBody/);
    expect(proxyLive.match(/injectBodyThenObserveTools\(\s*processMemory\(\)/g)?.length).toBeGreaterThanOrEqual(2);

    const know = readFileSync(join(ROOT, "packages/wrap/src/know-inject.ts"), "utf8");
    expect(know).toContain("withKnowFactsAnthropic");

    const freeze = readFileSync(join(MAB, "INJECT-API.md"), "utf8");
    expect(freeze).toContain("injectBodyThenObserveTools");
    expect(freeze).toMatch(/MEMORY_EVENTS[\s\S]*PostToolUse/);
    expect(freeze).toMatch(/MEMORY_EVENTS[\s\S]*SubagentStop/);
    expect(freeze).not.toMatch(/Not PostToolUse/);
  });

  test("memoryagentbench results markdown cannot publish cortex: false as product", () => {
    const skip = new Set(["SOTA-GAP-REPORT.md", "INJECT-API.md"]);
    const offenders: string[] = [];
    for (const file of walkMarkdown(MAB)) {
      if (skip.has(file.split("/").pop() ?? "")) continue;
      const src = readFileSync(file, "utf8");
      if (src.includes("cortex: false") && !src.includes("not-product")) offenders.push(relative(ROOT, file));
    }
    for (const file of walkSource(MAB)) {
      if (file.endsWith("inject-api.test.ts")) continue;
      const src = readFileSync(file, "utf8");
      for (const line of src.split("\n")) {
        if (!line.includes("cortex: false") && !line.includes("cortex:false")) continue;
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) continue;
        if (!line.includes("not-product")) offenders.push(`${relative(ROOT, file)}: ${t}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("openMemory().inject is the product API (not a score)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-inject-api-"));
    try {
      const mem = openMemory({ dir });
      const out = mem.inject([{ role: "user", content: "Auth is Clerk" }]);
      expect(Array.isArray(out)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
