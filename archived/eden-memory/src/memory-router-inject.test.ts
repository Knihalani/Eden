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
import { MEMORY_MARK, openMemory, type AgentMemory, injectedPackets } from "./index";
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
  return injectedPackets(messages).join("\n");
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

describe("M33.3 cross-talk — ICL shots not in EventQA packet", () => {
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
