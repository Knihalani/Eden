/**
 * M30.3 router stub — four routes + isolation.
 * Product path stays silent inject (Plan §0). M33 wires inject; wrap/hook
 * must not import this as a tool. Not BrainMemory. Not six MIRIX stores.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { routeMemory, type MemoryRoute } from "./memory-router";

const ROOT = join(import.meta.dir, "..");
const ROUTER_PATH = join(import.meta.dir, "memory-router.ts");
const INDEX_PATH = join(import.meta.dir, "index.ts");
const WRAP_PATH = join(ROOT, "packages", "wrap", "src", "know-inject.ts");
const HOOK_PATH = join(ROOT, "packages", "cli", "src", "hook.ts");
const MEMORY_HOOK_PATH = join(ROOT, "packages", "cli", "src", "memory-hook.ts");

const ROUTER_SRC = readFileSync(ROUTER_PATH, "utf8");

const SUMMARIZE = "Please summarize the book.";
const INFBENCH_CUE = `You are given a book above and you are tasked to summarize it.

Write a summary of about 1000 to 1200 words. Only write about the plot and characters of the story.

For example:

[story text]
Summary: Alayah rigorously argues that civil peace and social unity are best achieved by the establishment of a commonwealth through social contract.

[story text]
Summary: Halley Darlene is born in a workhouse in 1830s England.

Now summarize the book.`;
const DETQA_MC = `Based on the context you memorized...
Question: Lichem Rocchi's method of death...
A. Murder
B. Sudden death
C. Suicide
D. Sudden illness`;
const ICL_CUE = "The movie was great. label: 28";
const EVENTQA_MILLER = "What happened to the miller by the river?";
/** Official detective_qa extract after `Now Answer the Question:` — trailing Output: is not MCC. */
const DETQA_LIVE_EXTRACT = `Which character is related to the death of the deceased?
A. Mrs. Hemm
B. Mr. and Mrs. MacNamara
C. The Brandt couple
D. Miss House
 Output:`;

function codeWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("M30.3 routeMemory — four routes", () => {
  test("summary: Please summarize the book. → gist-chunk", () => {
    expect(routeMemory(SUMMARIZE)).toBe("gist-chunk");
  });

  test("InfBench-shaped summarize (few-shot Summary: + Now summarize the book.) → gist-chunk", () => {
    expect(routeMemory(INFBENCH_CUE)).toBe("gist-chunk");
  });

  test("DetQA MC (memorized context + Question: + A./B./C./D.) → gist-chunk", () => {
    expect(routeMemory(DETQA_MC)).toBe("gist-chunk");
    expect(routeMemory(`Lichem Rocchi's method of death was certainly not ( )
A. Murder
B. Sudden death
C. Suicide
D. Sudden illness`)).toBe("gist-chunk");
    expect(routeMemory(DETQA_LIVE_EXTRACT)).toBe("gist-chunk");
  });

  test("ICL: The movie was great. label: 28 → icl-index", () => {
    expect(routeMemory(ICL_CUE)).toBe("icl-index");
  });

  test("overwrite: who is the chairperson and 8. The chairperson is Bob → sf-assemble", () => {
    expect(routeMemory("who is the chairperson")).toBe("sf-assemble");
    expect(routeMemory("8. The chairperson is Bob")).toBe("sf-assemble");
  });

  test("default chat: Auth is failing / fix the flake → chat-jsonl", () => {
    expect(routeMemory("Auth is failing")).toBe("chat-jsonl");
    expect(routeMemory("fix the flake in auth.test.ts")).toBe("chat-jsonl");
  });
});

describe("M30.3 isolation + fail-open", () => {
  test("EventQA miller is NOT gist-chunk (AR/narrative BM25, not DetQA)", () => {
    const got = routeMemory(EVENTQA_MILLER);
    expect(got).not.toBe("gist-chunk");
    expect(got).toBe("chat-jsonl");
  });

  test("empty → chat-jsonl", () => {
    expect(routeMemory("")).toBe("chat-jsonl");
    expect(routeMemory("   ")).toBe("chat-jsonl");
  });

  test("throw inside classifier still returns chat-jsonl (fail-open)", () => {
    const boom = {
      toString(): string {
        throw new Error("classifier boom");
      },
      valueOf(): string {
        throw new Error("classifier boom");
      },
    };
    expect(routeMemory(boom as unknown as string)).toBe("chat-jsonl");
    expect(() => routeMemory(boom as unknown as string)).not.toThrow();
  });

  test("never throws on ordinary cues", () => {
    const cues = [
      SUMMARIZE,
      INFBENCH_CUE,
      DETQA_MC,
      ICL_CUE,
      "who is the chairperson",
      "8. The chairperson is Bob",
      "Auth is failing",
      "fix the flake in auth.test.ts",
      EVENTQA_MILLER,
      "",
      "what's 2+2?",
    ];
    for (const c of cues) {
      expect(() => routeMemory(c)).not.toThrow();
    }
  });

  test("priority: ICL wins overlap; chairperson is not gist-chunk", () => {
    expect(routeMemory("Please summarize the book. label: 28")).toBe("icl-index");
    expect(routeMemory("who is the chairperson")).not.toBe("gist-chunk");
    expect(routeMemory("8. The chairperson is Bob")).not.toBe("gist-chunk");
    expect(routeMemory("input: the movie was great\noutput: 28")).toBe("icl-index");
    expect(routeMemory("Input: src/auth.ts\nOutput: 12 tests passed")).not.toBe("icl-index");
    expect(routeMemory(DETQA_LIVE_EXTRACT)).not.toBe("icl-index");
  });

  test("copula identity vs chat status; what's 2+2 stays chat", () => {
    expect(routeMemory("who is the auth provider")).toBe("sf-assemble");
    expect(routeMemory("Auth is Clerk")).toBe("sf-assemble");
    expect(routeMemory("Auth is failing")).toBe("chat-jsonl");
    expect(routeMemory("what's 2+2?")).toBe("chat-jsonl");
  });

  test("file exists and exports routeMemory; four MemoryRoute values", () => {
    expect(existsSync(ROUTER_PATH)).toBe(true);
    expect(typeof routeMemory).toBe("function");
    const samples: Record<MemoryRoute, string> = {
      "gist-chunk": SUMMARIZE,
      "icl-index": ICL_CUE,
      "sf-assemble": "who is the chairperson",
      "chat-jsonl": "Auth is failing",
    };
    const seen = new Set<MemoryRoute>();
    for (const [want, cue] of Object.entries(samples) as [MemoryRoute, string][]) {
      expect(routeMemory(cue)).toBe(want);
      seen.add(want);
    }
    expect(seen.size).toBe(4);
  });

  test("does not mention memory_search as an API, does not import BrainMemory, not six ontologies as stores", () => {
    const code = codeWithoutComments(ROUTER_SRC);
    expect(code).not.toMatch(/\bmemory_search\s*\(/);
    expect(code).not.toMatch(/\bexport\s+.*\bmemory_search\b/);
    expect(code).not.toMatch(/\bBrainMemory\b/);
    expect(code).not.toMatch(/from\s+['"][^'"]*brain-memory[^'"]*['"]/);
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/Knowledge Vault/i);
    expect(code).not.toMatch(/Core Memory/i);
    expect(code).not.toMatch(/Resource Memory/i);
    expect(ROUTER_SRC).toMatch(/not six MIRIX ontologies/i);
    expect(ROUTER_SRC).toMatch(/not a memory tool/i);
    expect(ROUTER_SRC).toMatch(/M33 wires/i);
    expect(ROUTER_SRC).toMatch(/[Ff]ail-open/);
  });

  test("index imports routeMemory; wrap and hook stay silent (M33)", () => {
    expect(existsSync(INDEX_PATH)).toBe(true);
    const indexSrc = readFileSync(INDEX_PATH, "utf8");
    const indexCode = codeWithoutComments(indexSrc);
    expect(indexCode).toMatch(/from\s+["']\.\/memory-router["']/);
    expect(indexCode).toMatch(/\brouteMemory\b/);

    for (const p of [WRAP_PATH, HOOK_PATH, MEMORY_HOOK_PATH]) {
      expect(existsSync(p), p).toBe(true);
      const src = readFileSync(p, "utf8");
      expect(src, p).not.toMatch(/memory-router/);
      expect(src, p).not.toMatch(/\brouteMemory\b/);
      expect(src, p).not.toMatch(/\bmemory_search\b/);
    }
  });
});
