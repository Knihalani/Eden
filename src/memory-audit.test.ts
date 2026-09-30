/**
 * M36.4 caller audit. Product is openMemory inject / wrap injectBody /
 * withKnowFactsAnthropic / hook memoryHookResponse.
 *
 * BrainMemory import/construct detection is the M6.2 gate
 * (benchmarks/memoryagentbench/inject-only.test.ts). This file imports that
 * gate and does not rescan benchmarks/memoryagentbench.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { mkdtempSync } from "node:fs";
import {
  isBrainMemoryConstruct,
  isBrainMemoryImport,
  NOT_PRODUCT_LINE,
} from "../benchmarks/memoryagentbench/inject-gate";
import { ICL_RETRIEVE_K } from "./icl-index";
import { AgentMemory, memoryRetrieveCap, openMemory, PACKET_CHAT_K_DEFAULT, processMemory } from "./index";
import { NARRATIVE_RETRIEVE_K } from "./chunk-retrieve";

const ROOT = join(import.meta.dir, "..");

/** Default inject path. BrainMemory token count must stay 0 (no banner escape). */
const PRODUCT_FILES = [
  "packages/wrap/src/proxy.ts",
  "packages/wrap/src/know-inject.ts",
  "packages/wrap/src/anthropic.ts",
  "packages/wrap/src/tool-observe.ts",
  "packages/cli/src/memory-hook.ts",
  "packages/cli/src/hook.ts",
  "packages/cli/src/setup.ts",
  "packages/cli/src/doctor.ts",
  "src/index.ts",
  "src/sleep.ts",
] as const;

/** memory_search must stay 0. Entire wrap tree, plus hook/setup/doctor/index. */
const MEMORY_SEARCH_FILES = [
  "packages/cli/src/memory-hook.ts",
  "packages/cli/src/hook.ts",
  "packages/cli/src/setup.ts",
  "packages/cli/src/doctor.ts",
  "src/index.ts",
  "src/sleep.ts",
] as const;

const WRAP_DIR = join(ROOT, "packages/wrap/src");
const CLI_DIR = join(ROOT, "packages/cli/src");
const SRC_DIR = join(ROOT, "src");
const PLUGIN_DIR = join(ROOT, "plugins");

function rel(file: string): string {
  return relative(ROOT, file);
}

function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "archived") continue;
    const next = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkTs(next));
    else if (ent.isFile() && ent.name.endsWith(".ts") && !ent.name.endsWith(".test.ts")) out.push(next);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

/** Product-tree lines that import or construct BrainMemory without the M6.2 banner. */
function unbanneredBrain(files: string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!(isBrainMemoryImport(line) || isBrainMemoryConstruct(line))) continue;
      if (NOT_PRODUCT_LINE.test(line)) continue;
      offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
    }
  }
  return offenders;
}

function productTreeFiles(): string[] {
  return [...walkTs(WRAP_DIR), ...walkTs(CLI_DIR), ...walkTs(SRC_DIR), ...walkTs(PLUGIN_DIR)];
}

describe("M36.4 caller audit", () => {
  test("M6.2 gate flags a wrap-shaped BrainMemory import that lacks // not-product", () => {
    const bare = `import { BrainMemory } from "../../../src/brain-memory";`;
    const banner = `import { BrainMemory } from "../../../src/brain-memory"; // not-product`;
    expect(isBrainMemoryImport(bare)).toBe(true);
    expect(isBrainMemoryConstruct(`  mem = new BrainMemory({ dir, cortex: false });`)).toBe(true);
    expect(NOT_PRODUCT_LINE.test(bare)).toBe(false);
    expect(NOT_PRODUCT_LINE.test(banner)).toBe(true);
    expect(unbanneredBrain([])).toEqual([]);
  });

  test("wrap, cli, src, and plugins: BrainMemory import or construct needs the not-product banner", () => {
    // src/brain-memory.ts defines the adapter. It does not import or `new` itself.
    expect(unbanneredBrain(productTreeFiles())).toEqual([]);
  });

  test("named product files have zero BrainMemory and zero memory_search", () => {
    const brain: string[] = [];
    const search: string[] = [];
    for (const file of PRODUCT_FILES) {
      const src = read(file);
      if (/\bBrainMemory\b/.test(src)) brain.push(file);
      if (/\bmemory_search\b/.test(src)) search.push(file);
    }
    expect(brain).toEqual([]);
    expect(search).toEqual([]);
  });

  test("wrap tree plus hook/setup/doctor/index/sleep have zero memory_search", () => {
    const hits: string[] = [];
    const files = [...walkTs(WRAP_DIR), ...MEMORY_SEARCH_FILES.map((p) => join(ROOT, p))];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (/\bmemory_search\b/.test(src)) hits.push(rel(file));
    }
    expect(hits).toEqual([]);
  });

  test("default product retrieve k is 6–10, not 40", () => {
    const prev = process.env.EDEN_MEMORY_CAP;
    delete process.env.EDEN_MEMORY_CAP;
    try {
      expect(PACKET_CHAT_K_DEFAULT).toBe(6);
      expect(memoryRetrieveCap()).toBe(6);
    } finally {
      if (prev === undefined) delete process.env.EDEN_MEMORY_CAP;
      else process.env.EDEN_MEMORY_CAP = prev;
    }
    expect(ICL_RETRIEVE_K).toBe(10);
    expect(NARRATIVE_RETRIEVE_K).toBe(10);
    expect(ICL_RETRIEVE_K).not.toBe(40);
    expect(NARRATIVE_RETRIEVE_K).not.toBe(40);

    const k40: string[] = [];
    for (const file of ["src/index.ts", "src/icl-index.ts", "src/chunk-retrieve.ts", "src/sleep.ts"]) {
      const code = stripComments(read(file));
      if (/notesFor\s*\([^)]*\bk\s*=\s*40\b/.test(code)) k40.push(`${file}: notesFor k=40`);
      if (/function\s+memoryRetrieveCap[\s\S]{0,500}\breturn\s+40\b/.test(code))
        k40.push(`${file}: memoryRetrieveCap returns 40`);
      if (/EDEN_MEMORY_CAP[^;\n]{0,80}\|\|\s*40\b/.test(code)) k40.push(`${file}: EDEN_MEMORY_CAP || 40`);
      if (/PACKET_CHAT_K_DEFAULT\s*=\s*40\b/.test(code)) k40.push(`${file}: PACKET_CHAT_K_DEFAULT = 40`);
      if (/ICL_RETRIEVE_K\s*=\s*40\b/.test(code)) k40.push(`${file}: ICL_RETRIEVE_K = 40`);
      if (/NARRATIVE_RETRIEVE_K\s*=\s*40\b/.test(code)) k40.push(`${file}: NARRATIVE_RETRIEVE_K = 40`);
      if (/retrieve\s*\(\s*[^)]*\bk\s*=\s*40\b/.test(code)) k40.push(`${file}: retrieve k=40`);
    }
    expect(k40).toEqual([]);
  });

  test("EventQA product retrieve is not GraphRAG", () => {
    const hits: string[] = [];
    const banned = /\b(?:graphrag|raptor|openie|personalizedPageRank)\b|\bPPR\b/;
    for (const file of ["src/chunk-retrieve.ts", "src/chunk-store.ts", "src/index.ts"]) {
      const code = stripComments(read(file));
      if (banned.test(code)) hits.push(file);
    }
    expect(hits).toEqual([]);
    expect(stripComments(read("src/chunk-retrieve.ts"))).toMatch(/function retrieveNarrative|export function retrieve/);
  });

  test("stored ICL keeps label: (no label-strip on the store path)", () => {
    const icl = stripComments(read("src/icl-index.ts"));
    const index = stripComments(read("src/index.ts"));
    const strip = /\.replace\(\s*\/[^/\n]*label\s*:|text\.replace\([^)]*label\s*:/i;
    expect(strip.test(icl)).toBe(false);
    expect(strip.test(index)).toBe(false);
    expect(icl).toMatch(/text:\s*body/);
    expect(index).toMatch(/new IclIndex\([^)]*\)\.put\(text/);
    expect(icl).toMatch(/Keep `label:` in stored text|text:\s*body/);
  });

  test("default inject hosts stay on AgentMemory", () => {
    const proxy = read("packages/wrap/src/proxy.ts");
    const know = read("packages/wrap/src/know-inject.ts");
    const anth = read("packages/wrap/src/anthropic.ts");
    const tools = read("packages/wrap/src/tool-observe.ts");
    const hook = read("packages/cli/src/memory-hook.ts");
    const cliHook = read("packages/cli/src/hook.ts");
    const index = read("src/index.ts");
    const sleep = read("src/sleep.ts");
    const plugin = read("plugins/eden-memory/scripts/hook.ts");
    const cli = read("packages/cli/src/cli.ts");

    expect(proxy).toMatch(/injectBodyThenObserveTools\(\s*processMemory\(\)/);
    expect(know).toMatch(/export function withKnowFacts\(/);
    expect(know).toMatch(/injectBodyThenObserveTools\(\s*processMemory\(\)/);
    expect(know).toMatch(/export function withKnowFactsAnthropic\(/);
    expect(know).toMatch(/processMemory\(\)/);
    expect(know).toMatch(/mem\.inject\(/);
    expect(know).toMatch(/mem\.observe\(/);
    expect(anth).toMatch(/withKnowFactsAnthropic\(/);
    expect(tools).toMatch(/mem\.injectBody\(/);
    expect(tools).toMatch(/mem\.observe\(/);
    expect(hook).toMatch(/openMemory\(/);
    expect(hook).toMatch(/mem\.inject\(/);
    expect(hook).toMatch(/mem\.observe\(/);
    expect(hook).toMatch(/\bconsolidate\(/);
    expect(hook).toMatch(/export function memoryHookResponse\(/);
    expect(hook).toMatch(/export async function runMemoryHookStdin\(/);
    expect(cliHook).toMatch(/memoryHookResponse\(/);
    expect(cliHook).toMatch(/export async function respondToHook\(/);
    expect(index).toMatch(/export function openMemory\(/);
    expect(index).toMatch(/export function processMemory\(/);
    expect(index).toMatch(/\n  inject\(messages/);
    expect(index).toMatch(/\n  observe\(messages/);
    expect(index).toMatch(/\n  injectBody\(body/);
    expect(index).toMatch(/\n  async sleep\(/);
    expect(index).toMatch(/inject\(messages[\s\S]*?catch\s*\{\s*memoryInjectSwallows\.n\+\+/);
    expect(index).toMatch(/injectBody\(body[\s\S]*?catch\s*\{\s*memoryInjectSwallows\.n\+\+/);
    expect(sleep).toMatch(/export function consolidate\(/);
    expect(sleep).toMatch(/export async function sleep\(/);
    expect(sleep).toMatch(/openMemory\(/);
    expect(plugin).toMatch(/runMemoryHookStdin\(/);
    expect(cli).toMatch(/import\("\.\/hook"\)/);
    expect(plugin).not.toMatch(/\bBrainMemory\b/);
    expect(cli).not.toMatch(/\bBrainMemory\b/);
  });

  test("openMemory and processMemory return AgentMemory", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m364-"));
    const prev = process.env.EDEN_MEMORY_DIR;
    process.env.EDEN_MEMORY_DIR = dir;
    try {
      const opened = openMemory({ dir });
      expect(opened).toBeInstanceOf(AgentMemory);
      expect(opened.constructor.name).toBe("AgentMemory");
      opened.close();
      const proc = processMemory();
      expect(proc).toBeInstanceOf(AgentMemory);
      expect(proc.constructor.name).toBe("AgentMemory");
      proc.close();
    } finally {
      if (prev === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
