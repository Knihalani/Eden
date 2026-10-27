/**
 * M24 experience retrieve: cue → file slices → labeled packet. Not full LME 451.
 * gold_in_packet for the M16-style Change-request (debug-sample q25) case.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { injectBodyThenObserveTools } from "../packages/wrap/src/tool-observe";
import {
  EXPERIENCE_RETRIEVE_K,
  EXPERIENCE_RETRIEVE_K_MAX,
  EXPERIENCE_SLICE_CHAR_CAP,
  retrieveExperience,
} from "./experience-retrieve";
import { EXPERIENCE_DIRNAME, ExperienceStore, putExperience } from "./experience-store";
import { extractCandidates } from "./assemble";
import { AgentMemory, MEMORY_MARK, memoryInjectSwallows, openMemory, sleep, injectedPackets } from "./index";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/46

const GOLD = "Change-request";
const GOLD_MARKER = "UNIQUE_GOLD_M24_Q25";
const DISTRACTOR = "UNIQUE_DISTRACTOR_M24";
const Q25_CUE = "What is the heading shown on the Change-request catalog page?";
const GOLD_TREE = `RootWebArea [landmark] heading ${GOLD} ${GOLD_MARKER} button Submit catalog`;
const DIST_TREE = `RootWebArea [landmark] heading Incident Portal ${DISTRACTOR} button Open`;
const HOST_FILES = [
  join(import.meta.dir, "../packages/wrap/src/know-inject.ts"),
  join(import.meta.dir, "../packages/wrap/src/proxy.ts"),
  join(import.meta.dir, "../packages/wrap/src/tool-observe.ts"),
  join(import.meta.dir, "../packages/cli/src/memory-hook.ts"),
  join(import.meta.dir, "../packages/cli/src/setup.ts"),
  join(import.meta.dir, "../packages/cli/src/doctor.ts"),
];

function tmpDir(prefix = "eden-m24-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withMem<T>(
  prefix: string,
  fn: (mem: AgentMemory, dir: string) => T | Promise<T>,
  session?: string,
): Promise<T> {
  const dir = tmpDir(prefix);
  return withEnv(
    { EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_MEMORY: "on", EDEN_MEMORY_CAP: undefined },
    async () => {
      try {
        const mem = openMemory({ dir, session });
        return await fn(mem, dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

function packetOf(messages: unknown[]): string {
  return injectedPackets(messages).join("\n");
}

function hookHay(raw: Record<string, unknown> | null): string {
  return JSON.stringify(raw ?? {});
}

function seedGold(dir: string): void {
  putExperience(dir, {
    id: "q25-change-request",
    states: [
      {
        url: "https://example.test/change-request",
        tree: GOLD_TREE,
        t: 1,
      },
    ],
  });
  putExperience(dir, {
    id: "other-catalog",
    states: [
      {
        url: "https://example.test/other-catalog",
        tree: DIST_TREE,
        t: 2,
      },
    ],
  });
}

describe("M24.1 cue → experience files", () => {
  test("slice budget is extra (≤10), not MCC k=40", () => {
    expect(EXPERIENCE_RETRIEVE_K).toBeGreaterThan(0);
    expect(EXPERIENCE_RETRIEVE_K).toBeLessThanOrEqual(10);
    expect(EXPERIENCE_RETRIEVE_K_MAX).toBeLessThanOrEqual(10);
    expect(EXPERIENCE_SLICE_CHAR_CAP).toBeLessThanOrEqual(2000);
    const src = readFileSync(join(import.meta.dir, "experience-retrieve.ts"), "utf8");
    expect(src).toMatch(/not MCC k=40|Not retrieve@40|not retrieve@40/i);
    expect(src).toMatch(/6–10|6-10/);
  });

  test("question tokens hit the file that contains the gold phrase", () => {
    const dir = tmpDir("eden-m24-hit-");
    try {
      seedGold(dir);
      const hits = retrieveExperience(dir, Q25_CUE);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThanOrEqual(EXPERIENCE_RETRIEVE_K_MAX);
      expect(hits[0]!.text).toContain(GOLD);
      expect(hits[0]!.id).toBe("q25-change-request");
      expect(hits[0]!.text).toContain(GOLD_MARKER);
      expect(hits.some((h) => h.text.includes(DISTRACTOR))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty cue / missing dir / k=0 → []", () => {
    const dir = tmpDir("eden-m24-empty-");
    try {
      seedGold(dir);
      expect(retrieveExperience(dir, "")).toEqual([]);
      expect(retrieveExperience(dir, "   ")).toEqual([]);
      expect(retrieveExperience(dir, Q25_CUE, { k: 0 })).toEqual([]);
      expect(retrieveExperience(join(dir, "nope-missing"), Q25_CUE)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("place (url/path) ranks the matching traj", () => {
    const dir = tmpDir("eden-m24-place-");
    try {
      seedGold(dir);
      const hits = retrieveExperience(dir, "open https://example.test/change-request");
      expect(hits.some((h) => h.text.includes(GOLD))).toBe(true);
      expect(hits[0]!.url).toContain("change-request");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M24.2 packet merge — labeled slices; Start has no traj dump", () => {
  test.failing("inject labels the slice [episode]; chat k is not 40", async () => {
    await withMem("eden-m24-label-", (mem, dir) => {
      seedGold(dir);
      const notes = mem.notesFor(Q25_CUE);
      expect(notes.length).toBeLessThanOrEqual(16);
      const pkt = packetOf(mem.inject([{ role: "user", content: Q25_CUE }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/\[episode(?:\s*·[^\]]*)?\]/);
      expect(pkt).toContain(GOLD);
      expect(pkt).toContain(GOLD_MARKER);
      expect(pkt).not.toContain(DISTRACTOR);
    });
  });

  test('empty cue inject and notesFor("") do not dump traj files', async () => {
    await withMem("eden-m24-nodump-", (mem, dir) => {
      seedGold(dir);
      expect(packetOf(mem.inject([{ role: "user", content: "" }]))).not.toContain(GOLD_MARKER);
      expect(packetOf(mem.inject([]))).not.toContain(GOLD);
      expect(
        mem
          .notesFor("")
          .map((r) => r.text)
          .join("\n"),
      ).not.toContain(GOLD_MARKER);
      expect(packetOf(mem.inject([{ role: "user", content: "what's 2+2?" }]))).not.toContain(GOLD_MARKER);
    });
  });

  test("SessionStart briefing is pins+gists, not a traj dump", async () => {
    const session = "s-m24-start";
    await withMem(
      "eden-m24-start-",
      (mem, dir) => {
        seedGold(dir);
        mem.remember("Always run tests before committing", { kind: "constraint" });
        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: session });
        const hay = hookHay(start);
        expect(hay).not.toContain(GOLD_MARKER);
        expect(hay).not.toContain(DISTRACTOR);
        expect(hay).not.toMatch(/RootWebArea/);
        expect(hay).not.toMatch(new RegExp(`${EXPERIENCE_DIRNAME}/`));
        if (hay.includes(MEMORY_MARK)) {
          expect(hay).toMatch(/- Always run tests before committing|\(earlier session notes/);
          expect(hay).not.toMatch(/RootWebArea/);
        }
      },
      session,
    );
  });
});

describe("M24.3 gold_in_packet Change-request (q25-shaped)", () => {
  test.failing("after retrieve, gold phrase Change-request is in the inject packet", async () => {
    await withMem("eden-m24-gold-", (mem, dir) => {
      seedGold(dir);
      const pkt = packetOf(mem.inject([{ role: "user", content: Q25_CUE }]));
      expect(pkt).toContain(GOLD);
      expect(pkt).toContain(GOLD_MARKER);
    });
  });

  test.failing("wrap OpenAI injectBody and Anthropic inject the gold slice", async () => {
    await withMem("eden-m24-wrap-", (mem, dir) => {
      seedGold(dir);
      const openai = injectBodyThenObserveTools(mem, {
        messages: [{ role: "user", content: Q25_CUE }],
      });
      expect(packetOf((openai as { messages?: unknown[] }).messages ?? [])).toContain(GOLD);

      const real = AgentMemory.prototype.inject;
      const inject = spyOn(AgentMemory.prototype, "inject").mockImplementation(function (
        this: AgentMemory,
        messages: unknown[],
      ) {
        return real.call(mem, messages);
      });
      try {
        const anth = withKnowFactsAnthropic({
          messages: [{ role: "user", content: Q25_CUE }],
        });
        const sys = anth.system;
        const hay = typeof sys === "string" ? sys : JSON.stringify(sys ?? anth);
        expect(inject).toHaveBeenCalled();
        expect(hay).toContain(GOLD);
      } finally {
        inject.mockRestore();
      }
    });
  });

  test.failing("hook UserPromptSubmit packet contains the gold phrase", async () => {
    await withMem("eden-m24-hook-", (_mem, dir) => {
      seedGold(dir);
      const out = memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        prompt: Q25_CUE,
      });
      const hay = hookHay(out);
      expect(hay).toContain(GOLD);
      expect(hay).toContain(GOLD_MARKER);
    });
  });

  test("lane=trajectory is not SF-extracted (gold phrase stays a slice)", () => {
    expect(extractCandidates([{ text: `The heading is ${GOLD}.`, t: 1, lane: "trajectory" }])).toEqual([]);
    expect(extractCandidates([{ text: `The heading is ${GOLD}.`, t: 1, kind: "trajectory" }])).toEqual([]);
  });

  test("long url/action/thought still keeps the gold heading in the slice", () => {
    const dir = tmpDir("eden-m24-trunc-");
    try {
      putExperience(dir, {
        id: "q25-change-request",
        states: [
          {
            url: "https://example.test/change-request?" + "x".repeat(400),
            action: "click Submit on the change-request catalog ".repeat(8),
            thought: "planning to inspect the change-request catalog next ".repeat(8),
            tree: GOLD_TREE,
            t: 1,
          },
        ],
      });
      const hit = retrieveExperience(dir, Q25_CUE)[0];
      expect(hit?.text).toContain(GOLD);
      expect(hit?.text).toContain(GOLD_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("later click/thought does not steal the gold heading state", () => {
    const dir = tmpDir("eden-m24-recency-");
    try {
      putExperience(dir, {
        id: "q25-change-request",
        states: [
          { url: "https://example.test/change-request", tree: GOLD_TREE, t: 1 },
          {
            url: "https://example.test/change-request",
            action: "click catalog change-request retry",
            thought: "inspect change-request catalog",
            t: 2,
          },
        ],
      });
      const hit = retrieveExperience(dir, Q25_CUE)[0];
      expect(hit?.text).toContain(GOLD);
      expect(hit?.text).toContain(GOLD_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("other-catalog path is not a catalog heading hit", () => {
    const dir = tmpDir("eden-m24-hyphen-");
    try {
      seedGold(dir);
      const weak = retrieveExperience(dir, "What heading is on the catalog page?");
      expect(weak.some((h) => h.id === "other-catalog" && !h.text.includes(GOLD))).toBe(false);
      const hits = retrieveExperience(dir, Q25_CUE);
      expect(hits.some((h) => h.text.includes(DISTRACTOR))).toBe(false);
      expect(hits[0]?.text).toContain(GOLD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("same-host URL cue does not dump every example.test traj", () => {
    const dir = tmpDir("eden-m24-host-");
    try {
      seedGold(dir);
      const hits = retrieveExperience(dir, "open https://example.test/change-request");
      expect(hits.some((h) => h.text.includes(GOLD))).toBe(true);
      expect(hits.some((h) => h.text.includes(DISTRACTOR))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retrieve redacts secrets on read", () => {
    const dir = tmpDir("eden-m24-secret-");
    try {
      mkdirSync(join(dir, EXPERIENCE_DIRNAME), { recursive: true });
      const secretRow = JSON.stringify({
        url: "https://example.test/change-request",
        tree: `heading ${GOLD} token sk-LIVESECRET99999999`,
        t: 1,
      });
      writeFileSync(
        join(dir, EXPERIENCE_DIRNAME, "secret-raw.jsonl"),
        `${JSON.stringify({ id: "secret-raw" })}\n${secretRow}\n`,
        "utf8",
      );
      const hits = retrieveExperience(dir, Q25_CUE);
      const hay = hits.map((h) => h.text).join("\n");
      expect(hay).toContain(GOLD);
      expect(hay).not.toContain("sk-LIVESECRET99999999");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing("two action states without a tree stay [episode], not [procedure]", async () => {
    await withMem("eden-m24-proc-", (mem, dir) => {
      putExperience(dir, {
        id: "clicks",
        states: [
          { url: "https://example.test/change-request", action: "click catalog retry change-request", t: 1 },
          { url: "https://example.test/change-request", action: "click Submit change-request", t: 2 },
        ],
      });
      const pkt = packetOf(mem.inject([{ role: "user", content: Q25_CUE }]));
      expect(pkt).toMatch(/\[episode(?:\s*·[^\]]*)?\]/);
      expect(pkt).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
    });
  });

  test.failing("traj slice drops superseded Alice when live chairperson is Bob", async () => {
    await withMem("eden-m24-alice-", (mem, dir) => {
      putExperience(dir, {
        id: "q25-change-request",
        states: [
          {
            url: "https://example.test/change-request",
            tree: `${GOLD_TREE} The catalog chairperson is Alice`,
            t: 1,
          },
        ],
      });
      mem.observe([{ role: "user", content: "The catalog chairperson is Bob." }]);
      sleep(mem);
      const pkt = packetOf(mem.inject([{ role: "user", content: Q25_CUE }]));
      expect(pkt).toContain(GOLD);
      expect(pkt).toMatch(/Bob/);
      expect(pkt).not.toMatch(/\bAlice\b/);
    });
  });
});

describe("M24.4 no memory_search — retrieve is inject, not a tool", () => {
  test.failing("wrap/hook/setup/doctor have no memory_search or retrieveExperience tool", () => {
    for (const p of HOST_FILES) {
      const src = readFileSync(p, "utf8");
      expect(src, p).not.toMatch(/\bmemory_search\b/);
      expect(src, p).not.toMatch(/\bretrieveExperience\b/);
      expect(src, p).not.toMatch(/\bmemorable-cli\b/);
    }
    const index = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(index).toMatch(/retrieveExperience/);
    expect(index).toMatch(/mergeExperienceLane/);
    expect(index).not.toMatch(/\bmemory_search\b/);
  });

  test("retrieveExperience throw → inject fail-open, original messages", async () => {
    await withMem("eden-m24-failopen-", (mem, dir) => {
      seedGold(dir);
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      const boom = spyOn(ExperienceStore.prototype, "ids").mockImplementation(() => {
        throw new Error("m24 experience ids boom");
      });
      const before = memoryInjectSwallows.n;
      const authCue = [{ role: "user", content: "what is auth using?" }];
      const goldCue = [{ role: "user", content: Q25_CUE }];
      try {
        let authOut: unknown;
        expect(() => {
          authOut = mem.inject(authCue);
        }).not.toThrow();
        expect(Array.isArray(authOut)).toBe(true);
        expect(JSON.stringify(authOut)).not.toMatch(/\b500\b|Internal Server Error/i);
        expect(memoryInjectSwallows.n).toBe(before);
        expect(packetOf(authOut as unknown[])).toMatch(/Clerk/i);

        let goldOut: unknown;
        expect(() => {
          goldOut = mem.inject(goldCue);
        }).not.toThrow();
        expect(goldOut).toEqual(goldCue);
        expect(JSON.stringify(goldOut)).not.toMatch(/\b500\b|Internal Server Error/i);
        expect(memoryInjectSwallows.n).toBe(before);
      } finally {
        boom.mockRestore();
      }
    });
  });
});
