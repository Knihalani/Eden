/**
 * M33.3 isolation — cross-talk on the inject path.
 * ICL shots must not land in an EventQA packet.
 * Dispatch lives in M33.1. This file only asserts. Not BrainMemory. // not-product
 * Silent inject. Not a memory tool. No memory_search.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLane, MEMORY_MARK, openMemory, type AgentMemory } from "./index";
import * as edenMem from "./index";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { routeMemory } from "./memory-router";
import * as memoryRouter from "./memory-router";

const ROOT = join(import.meta.dir, "..");
const INDEX_PATH = join(import.meta.dir, "index.ts");
const WRAP_PATH = join(ROOT, "packages", "wrap", "src", "know-inject.ts");
const HOOK_PATH = join(ROOT, "packages", "cli", "src", "hook.ts");
const MEMORY_HOOK_PATH = join(ROOT, "packages", "cli", "src", "memory-hook.ts");

/** EventQA miller paragraph (memory-lanes NOVEL_PARA) plus the zebra needle. */
const MILLER_NOVEL =
  "In the year 1847 the miller of Blackford walked beside the river that ran through the valley. " +
  "He remembered the flood of his childhood and the oak that had fallen across the millrace. " +
  "The villagers said the oak still slept under the silt, waiting. " +
  "The special magic number of zebra-quark-17 is 48291.";

const EVENTQA_MILLER = "What happened to the miller by the river?";
const ICL_CUE = "The movie was great. label:";
const ICL_GOLD = "The movie was great. label: 28";
const AUTH_FAIL = "Auth is failing";

function codeWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function withMem(fn: (mem: AgentMemory, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "eden-m333-"));
  try {
    fn(openMemory({ dir }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function packetOf(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m === "object" ? (m as { role?: string; content?: unknown }) : {}))
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

/** ICL shots and an EventQA-class miller/zebra paragraph, plus a chat fact. */
function seedCrossTalk(mem: AgentMemory): void {
  for (let i = 0; i < 8; i++) {
    mem.observe([{ role: "user", content: `The movie was great. Take ${i}. label: 28` }]);
  }
  mem.observe([{ role: "user", content: MILLER_NOVEL }]);
  mem.observe([{ role: "user", content: "Auth is Clerk" }]);
  mem.observe([{ role: "user", content: "8. The chairperson is Bob" }]);
}

function expectNovelStored(mem: AgentMemory): void {
  expect(encodeLane(MILLER_NOVEL)).toBe("narrative");
  const novel = mem.memories().find((r) => /zebra-quark-17/.test(r.text) && /miller of Blackford/.test(r.text));
  expect(novel?.lane).toBe("narrative");
  expect(mem.memories().filter((r) => r.lane === "icl" && /label:\s*28/.test(r.text)).length).toBeGreaterThanOrEqual(8);
}

describe("M33.3 cross-talk — ICL shots not in EventQA packet", () => {
  test("EventQA miller packet contains miller/zebra and not label: 28", () => {
    withMem((mem) => {
      seedCrossTalk(mem);
      expectNovelStored(mem);
      const pkt = packetOf(mem.inject([{ role: "user", content: EVENTQA_MILLER }]));
      expect(pkt).toMatch(/miller of Blackford/);
      expect(pkt).toMatch(/zebra-quark-17/);
      expect(pkt).not.toMatch(/label:\s*28/);
      expect(pkt).not.toMatch(/The movie was great/);
    });
  });

  test("ICL cue packet may contain label: 28 and does not dump the miller novel", () => {
    withMem((mem) => {
      seedCrossTalk(mem);
      const pkt = packetOf(mem.inject([{ role: "user", content: ICL_CUE }]));
      expect(pkt).toMatch(/label:\s*28/);
      expect(pkt).not.toMatch(/miller of Blackford/);
      expect(pkt).not.toMatch(/zebra-quark-17/);
      expect(pkt).not.toMatch(/oak that had fallen across the millrace/);
    });
  });

  test("Auth is failing packet has Clerk, no label: 28, no miller dump", () => {
    withMem((mem) => {
      seedCrossTalk(mem);
      const pkt = packetOf(mem.inject([{ role: "user", content: AUTH_FAIL }]));
      expect(pkt).toMatch(/Clerk/);
      expect(pkt).not.toMatch(/label:\s*28/);
      expect(pkt).not.toMatch(/The movie was great/);
      expect(pkt).not.toMatch(/miller of Blackford/);
      expect(pkt).not.toMatch(/zebra-quark-17/);
    });
  });
});

describe("M33.3 wrap and hook stay silent", () => {
  test("index imports routeMemory; wrap, hook, and memory-hook do not", () => {
    const indexCode = codeWithoutComments(readFileSync(INDEX_PATH, "utf8"));
    expect(indexCode).toMatch(/from\s+["']\.\/memory-router["']/);
    expect(indexCode).toMatch(/\brouteMemory\b/);
    expect(indexCode).not.toMatch(/\bmemory_search\b/);

    for (const p of [WRAP_PATH, HOOK_PATH, MEMORY_HOOK_PATH]) {
      const src = readFileSync(p, "utf8");
      expect(src, p).not.toMatch(/memory-router/);
      expect(src, p).not.toMatch(/\brouteMemory\b/);
      expect(src, p).not.toMatch(/\bmemory_search\b/);
    }
  });

  test("wrap OpenAI, Anthropic, hook: Clerk / miller / ICL isolation", () => {
    withMem((mem, dir) => {
      seedCrossTalk(mem);
      expectNovelStored(mem);
      const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
      const prevDir = process.env.EDEN_MEMORY_DIR;
      const prevHome = process.env.EDEN_HOME;
      process.env.EDEN_MEMORY_DIR = dir;
      delete process.env.EDEN_HOME;
      try {
        const openaiAuth = packetOf(withKnowFacts({ messages: [{ role: "user", content: AUTH_FAIL }] }).messages as unknown[]);
        expect(openaiAuth).toMatch(/Clerk/);
        expect(openaiAuth).not.toMatch(/label:\s*28/);
        expect(openaiAuth).not.toMatch(/zebra-quark-17/);
        const openaiMiller = packetOf(withKnowFacts({ messages: [{ role: "user", content: EVENTQA_MILLER }] }).messages as unknown[]);
        expect(openaiMiller).toMatch(/miller of Blackford|zebra-quark-17/);
        expect(openaiMiller).not.toMatch(/label:\s*28/);
        const openaiIcl = packetOf(withKnowFacts({ messages: [{ role: "user", content: ICL_CUE }] }).messages as unknown[]);
        expect(openaiIcl).toMatch(/label:\s*28/);
        expect(openaiIcl).not.toMatch(/zebra-quark-17/);

        const anthAuthBody = withKnowFactsAnthropic({ messages: [{ role: "user", content: AUTH_FAIL }] });
        const anthAuth = [anthAuthBody.system].flat().map((b) => typeof b === "string" ? b : String((b as { text?: string })?.text ?? "")).join("\n");
        expect(anthAuth).toMatch(/Clerk/);
        expect(anthAuth).not.toMatch(/label:\s*28/);
        const anthMillerBody = withKnowFactsAnthropic({ messages: [{ role: "user", content: EVENTQA_MILLER }] });
        const anthMiller = [anthMillerBody.system].flat().map((b) => typeof b === "string" ? b : String((b as { text?: string })?.text ?? "")).join("\n");
        expect(anthMiller).toMatch(/miller of Blackford|zebra-quark-17/);
        expect(anthMiller).not.toMatch(/label:\s*28/);

        const hookAuth = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: AUTH_FAIL });
        const hookAuthCtx = [hookAuth?.additional_context, (hookAuth?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext].join("\n");
        expect(hookAuthCtx).toMatch(/Clerk/);
        expect(hookAuthCtx).not.toMatch(/label:\s*28/);
        const hookMiller = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: EVENTQA_MILLER });
        const hookMillerCtx = [hookMiller?.additional_context, (hookMiller?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext].join("\n");
        expect(hookMillerCtx).toMatch(/miller of Blackford|zebra-quark-17/);
        expect(hookMillerCtx).not.toMatch(/label:\s*28/);
      } finally {
        if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
        else process.env.EDEN_MEMORY_DIR = prevDir;
        if (prevHome === undefined) delete process.env.EDEN_HOME;
        else process.env.EDEN_HOME = prevHome;
        procSpy.mockRestore();
      }
    });
  });
});

describe("M33.3 fail-open", () => {
  test("routeMemory toString throw stays chat-jsonl", () => {
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

  test("routeMemory throw degrades to chat-jsonl; inject does not 500", () => {
    withMem((mem) => {
      for (let i = 0; i < 4; i++) {
        mem.observe([{ role: "user", content: `The movie was great. Take ${i}. label: 28` }]);
      }
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      const list = [{ role: "user", content: ICL_GOLD }];
      expect(routeMemory(ICL_GOLD)).toBe("icl-index");
      const boom = spyOn(memoryRouter, "routeMemory").mockImplementation(() => {
        throw new Error("m33 routeMemory boom");
      });
      try {
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
        const pkt = packetOf(out as unknown[]);
        expect(pkt).not.toMatch(/label:\s*28/);
      } finally {
        boom.mockRestore();
      }
    });
  });
});
