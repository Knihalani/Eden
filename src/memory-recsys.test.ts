/**
 * M31.4 recsys atoms ⟂ facts. Movies are not SemanticStore triples.
 * M7.4 ICL≠facts. Store-all, not extractDurable-chop. M16.2 kinds stay 5.
 * Product path is openMemory observe/inject/sleep. Not BrainMemory. No memory_search.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { extractCandidates, type CandidateText } from "./assemble";
import {
  MEMORY_MARK,
  encodeLane,
  memoryInjectSwallows,
  openMemory,
  sleep,
  type AgentMemory,
} from "./index";
import * as edenMem from "./index";
import { MEMORY_LANE_KINDS } from "./memory-lanes";
import { isIclExemplar, isRecsysShot, SemanticStore } from "./semantic-store";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/60

const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
const WRAP_SRC = readFileSync(join(import.meta.dir, "../packages/wrap/src/know-inject.ts"), "utf8");
const HOOK_SRC = readFileSync(join(import.meta.dir, "../packages/cli/src/memory-hook.ts"), "utf8");
const HOST_FILES = [
  join(import.meta.dir, "../packages/wrap/src/know-inject.ts"),
  join(import.meta.dir, "../packages/wrap/src/tool-observe.ts"),
  join(import.meta.dir, "../packages/cli/src/memory-hook.ts"),
  join(import.meta.dir, "../packages/cli/src/setup.ts"),
  join(import.meta.dir, "../packages/cli/src/doctor.ts"),
] as const;

/** Case 1 recsys dialogue — store-all atom, not extractDurable chop. */
const RECSYS_LIKED =
  "I liked Superbad (2007), The Hangover (2009), and Knocked Up (2007). Recommend similar comedies.";
const RECSYS_CUE = "recommend comedies like Superbad (2007)";
/** Case 2 numbered movie list — not a fact-serial extract. */
const RECSYS_NUMBERED = "1. Superbad (2007)\n2. The Hangover (2009)\n3. Knocked Up (2007)";
/** Case 3 Matrix title must not become a SemanticStore subject/object. */
const RECSYS_MATRIX = "I liked The Matrix (1999). Recommend similar sci-fi.";
/** M7.4 / M17 ICL gold — still ICL, not recsys. */
const ICL_GOLD = "The movie was great. label: 28";
/** memory-lanes.test.ts EventQA miller paragraph — narrative, not recsys. */
const MILLER =
  "In the year 1847 the miller of Blackford walked beside the river that ran through the valley. He remembered the flood of his childhood and the oak that had fallen across the millrace. The villagers said the oak still slept under the silt, waiting.";
const CHAIR_SERIAL = "8. The chairperson is Bob";
const CHAIR_LIST = "8. The chairperson is Bob\n9. The treasurer is Alice";
const MOVIE_TITLES = ["superbad", "hangover", "knocked up", "the matrix", "matrix"] as const;

function tmpDir(prefix = "eden-m314-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
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
): Promise<T> {
  const dir = tmpDir(prefix);
  return withEnv({ EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, async () => {
    try {
      const mem = openMemory({ dir });
      return await fn(mem, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function packetOf(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m === "object" ? (m as { role?: string; content?: unknown }) : {}))
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

function hookCtx(raw: Record<string, unknown> | null): string {
  if (!raw) return "";
  const spec = raw.hookSpecificOutput;
  const extra = spec && typeof spec === "object" ? (spec as { additionalContext?: unknown }).additionalContext : "";
  return [raw.additional_context, extra].map((x) => String(x ?? "")).join("\n");
}

function factObject(got: unknown): string {
  if (got == null) return "";
  if (typeof got === "string") return got;
  if (typeof got === "object") {
    const o = got as { o?: unknown; object?: unknown; value?: unknown; text?: unknown };
    return String(o.o ?? o.object ?? o.value ?? o.text ?? "");
  }
  return String(got);
}

function flatten(s: string): string {
  return String(s ?? "").trim().replace(/\s+/g, " ");
}

/** M16.2 stays 5 kinds: recsys encode is narrative (or recsys if D added the string, not a 6th kind). */
function isRecsysLane(lane?: string): boolean {
  return lane === "narrative" || lane === "recsys";
}

function storedBlob(mem: AgentMemory): string {
  return mem.memories().map((r) => r.text).join("\n");
}

function movieRecs(mem: AgentMemory): ReturnType<AgentMemory["memories"]> {
  return mem.memories().filter((r) => /Superbad|Hangover|Knocked Up|The Matrix/i.test(r.text));
}

function movieKey(s: string): string {
  return s.trim().toLowerCase().replace(/^(?:the|a|an)\s+/, "");
}

function tripleTouchesMovie(row: { s?: string; o?: string }): boolean {
  const s = movieKey(String(row.s ?? ""));
  const o = movieKey(String(row.o ?? ""));
  return MOVIE_TITLES.some((title) => {
    const t = movieKey(title);
    return s === t || o === t;
  });
}

function recsysCandidate(text: string, extra: Partial<CandidateText> & { tags?: string[] } = {}): CandidateText & { tags?: string[] } {
  return { text, t: extra.t ?? 1, ...extra };
}

describe("M31.4 M16.2 kinds stay 5", () => {
  test("MEMORY_LANE_KINDS is still icl | narrative | fact | trajectory | chat", () => {
    expect([...MEMORY_LANE_KINDS]).toEqual(["icl", "narrative", "fact", "trajectory", "chat"]);
    expect(new Set(MEMORY_LANE_KINDS).size).toBe(5);
    expect(MEMORY_LANE_KINDS).not.toContain("recsys");
  });
});

describe("M31.4 recsys store-all (not extractDurable chop)", () => {
  test.failing("movie list stored as atom (store-all); packet on comedy cue has Superbad / Hangover", async () => {
    await withMem("eden-m314-liked-", (mem) => {
      expect(["narrative", "recsys"]).toContain(encodeLane(RECSYS_LIKED));
      mem.observe([{ role: "user", content: RECSYS_LIKED }]);
      const blob = storedBlob(mem);
      expect(blob).toContain(flatten(RECSYS_LIKED));
      const recs = movieRecs(mem);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs.every((r) => isRecsysLane(r.lane))).toBe(true);
      expect(recs.some((r) => r.lane === "chat")).toBe(false);
      expect(recs.some((r) => (r.tags ?? []).some((t) => t.toLowerCase() === "recsys"))).toBe(true);
      const pkt = packetOf(mem.inject([{ role: "user", content: RECSYS_CUE }]));
      expect(pkt).toMatch(/Superbad/);
      expect(pkt).toMatch(/Hangover/);
    });
  });

  test.failing("numbered movie list is NOT a fact-serial extract", async () => {
    await withMem("eden-m314-numbered-", (mem, dir) => {
      expect(["narrative", "recsys"]).toContain(encodeLane(RECSYS_NUMBERED));
      expect(["narrative", "recsys"]).toContain(encodeLane(flatten(RECSYS_NUMBERED)));
      mem.observe([{ role: "user", content: RECSYS_NUMBERED }]);
      const recs = movieRecs(mem);
      expect(recs.length).toBeGreaterThan(0);
      const blob = storedBlob(mem);
      expect(blob).toMatch(/Superbad/);
      expect(blob).toMatch(/Hangover/);
      expect(blob).toMatch(/Knocked Up/);
      expect(blob).toContain(flatten(RECSYS_NUMBERED));
      expect(recs.every((r) => isRecsysLane(r.lane))).toBe(true);
      expect(recs.every((r) => r.lane !== "chat")).toBe(true);
      const live = new SemanticStore(dir).live();
      expect(live.some((row) => tripleTouchesMovie(row) && row.p === "is")).toBe(false);
      expect(live.some((row) => movieKey(row.s) === "superbad" && row.p === "is")).toBe(false);
    });
  });
});

describe("M31.4 movies are not SemanticStore triples after sleep", () => {
  test("recsys dialogue + Clerk: movies absent from live(); Clerk still live", async () => {
    await withMem("eden-m314-sleep-sem-", async (mem, dir) => {
      const track = spyOn(SemanticStore.prototype, "put");
      try {
        mem.observe([{ role: "user", content: RECSYS_LIKED }]);
        mem.observe([{ role: "user", content: RECSYS_MATRIX }]);
        mem.observe([{ role: "user", content: "Auth is Clerk" }]);
        await sleep({ dir, mem });
        const store = new SemanticStore(dir);
        for (const row of store.live()) {
          expect(tripleTouchesMovie(row)).toBe(false);
        }
        for (const call of track.mock.calls) {
          expect(tripleTouchesMovie({ s: String(call[0] ?? ""), o: String(call[2] ?? "") })).toBe(false);
        }
        expect(factObject(store.get("auth", "is"))).toMatch(/Clerk/i);
        expect(store.live().some((row) => /clerk/i.test(row.o))).toBe(true);
      } finally {
        track.mockRestore();
      }
    });
  });
});

describe("M31.4 ICL still ICL, not recsys (M7.4)", () => {
  test("The movie was great. label: 28 → encodeLane icl; SemanticStore skip", async () => {
    expect(encodeLane(ICL_GOLD)).toBe("icl");
    expect(encodeLane(ICL_GOLD)).not.toBe("recsys");
    expect(encodeLane(ICL_GOLD)).not.toBe("narrative");
    expect(encodeLane(ICL_GOLD)).not.toBe("chat");
    await withMem("eden-m314-icl-", async (mem, dir) => {
      const track = spyOn(SemanticStore.prototype, "put");
      try {
        mem.observe([{ role: "user", content: ICL_GOLD }]);
        expect(mem.memories().some((r) => r.lane === "icl" && /label:\s*28/.test(r.text))).toBe(true);
        expect(mem.memories().some((r) => r.lane === "recsys" && /label:\s*28/.test(r.text))).toBe(false);
        await sleep({ dir, mem });
        const store = new SemanticStore(dir);
        expect(factObject(store.get("movie", "is"))).not.toMatch(/great/i);
        expect(factObject(store.get("movie", "label"))).not.toMatch(/28/);
        expect(factObject(store.get("label", "is"))).not.toMatch(/28/);
        for (const row of store.live()) {
          expect(row.p.toLowerCase()).not.toBe("label");
          expect(String(row.o)).not.toMatch(/^28$/);
        }
        for (const call of track.mock.calls) {
          expect(String(call[1] ?? "").toLowerCase()).not.toBe("label");
        }
      } finally {
        track.mockRestore();
      }
    });
  });
});

describe("M31.4 recsys / ICL false positives", () => {
  test.failing("RFC ids with years are not recsys; Title (YYYY) lists are", () => {
    expect(isRecsysShot("RFC 9110 (2022) superseded RFC 7231 (2014)")).toBe(false);
    expect(encodeLane("RFC 9110 (2022) superseded RFC 7231 (2014)")).not.toBe("narrative");
    expect(isRecsysShot("Superbad (2007), The Hangover (2009), Knocked Up (2007)")).toBe(true);
    expect(encodeLane("Superbad (2007), The Hangover (2009), Knocked Up (2007)")).toBe("narrative");
  });

  test("coding Input: path is not ICL; Input: The film is terrible. is ICL", () => {
    expect(isIclExemplar("Input: src/auth.ts")).toBe(false);
    expect(encodeLane("Input: src/auth.ts")).toBe("chat");
    expect(isIclExemplar("Input: The film is terrible.")).toBe(true);
    expect(encodeLane("Input: The film is terrible.")).toBe("icl");
    expect(encodeLane("Input: The film is terrible. Output: negative")).toBe("icl");
    expect(isIclExemplar("Input: src/auth.ts\nOutput: 12 tests passed")).toBe(false);
    expect(encodeLane("Input: src/auth.ts\nOutput: 12 tests passed")).toBe("chat");
    expect(isIclExemplar("Input: src/film.ts")).toBe(false);
    expect(encodeLane("Input: src/film.ts")).toBe("chat");
    expect(isIclExemplar("Input: src/movie.ts")).toBe(false);
    expect(encodeLane("Input: src/movie.ts")).toBe("chat");
    expect(isIclExemplar("input: the movie was great\noutput: 28")).toBe(true);
    expect(encodeLane("input: the movie was great\noutput: 28")).toBe("icl");
  });

  test("chairperson lists with years, EventQA years, coding years are not recsys", async () => {
    const chairYears = "8. The chairperson is Bob (2020)\n9. The treasurer is Alice (2021)";
    const millerHere =
      "Here is the conversation:\nUser: In 1847 the miller of Blackford walked beside the river.";
    const versailles = "The Treaty of Versailles (1919) followed the armistice (1918)";
    const nodeLts = "Node 18 (2018) and Node 20 (2023) are LTS";
    const tsRel = "TypeScript 4.9 (2022) replaced TypeScript 5.0 (2023)";
    expect(isRecsysShot(chairYears)).toBe(false);
    expect(encodeLane(chairYears)).not.toBe("narrative");
    expect(["chat", "fact"]).toContain(encodeLane(chairYears));
    expect(isRecsysShot(millerHere)).toBe(false);
    expect(isRecsysShot(versailles)).toBe(false);
    expect(isRecsysShot(nodeLts)).toBe(false);
    expect(isRecsysShot(tsRel)).toBe(false);
    expect(isRecsysShot("User: I like postgres (2019) and mysql (2020)")).toBe(false);
    expect(encodeLane(nodeLts)).not.toBe("narrative");
    await withMem("eden-m314-chair-years-", async (mem, dir) => {
      mem.observe([{ role: "user", content: chairYears }]);
      mem.observe([{ role: "user", content: nodeLts }]);
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      expect(mem.memories().some((r) => r.lane === "narrative" && /chairperson/.test(r.text))).toBe(false);
      expect(mem.memories().some((r) => (r.tags ?? []).includes("recsys") && /chairperson/.test(r.text))).toBe(false);
      await sleep({ dir, mem });
      const store = new SemanticStore(dir);
      expect(factObject(store.get("chairperson", "is"))).toMatch(/Bob/i);
      expect(factObject(store.get("auth", "is"))).toMatch(/Clerk/i);
      expect(store.live().some((row) => /superbad|hangover|matrix/i.test(`${row.s} ${row.o}`))).toBe(false);
    });
  });
});

describe("M31.4 chat facts unchanged", () => {
  test("Auth is Clerk → encodeLane chat; 8. The chairperson is Bob stays chat/fact-list, not recsys", async () => {
    expect(encodeLane("Auth is Clerk")).toBe("chat");
    expect(["chat", "fact"]).toContain(encodeLane(CHAIR_SERIAL));
    expect(encodeLane(CHAIR_SERIAL)).not.toBe("recsys");
    expect(encodeLane(CHAIR_SERIAL)).not.toBe("narrative");
    expect(["chat", "fact"]).toContain(encodeLane(CHAIR_LIST));
    expect(encodeLane(CHAIR_LIST)).not.toBe("recsys");
    expect(encodeLane(CHAIR_LIST)).not.toBe("narrative");
    expect(isRecsysShot(CHAIR_SERIAL)).toBe(false);
    expect(isRecsysShot(CHAIR_LIST)).toBe(false);
    expect(isRecsysShot("Auth is Clerk")).toBe(false);
    await withMem("eden-m314-chat-", (mem) => {
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      mem.observe([{ role: "user", content: CHAIR_SERIAL }]);
      const clerk = mem.memories().filter((r) => /Clerk/.test(r.text));
      expect(clerk.length).toBeGreaterThan(0);
      expect(clerk.every((r) => (r.lane || "chat") === "chat")).toBe(true);
      const chair = mem.memories().filter((r) => /chairperson/i.test(r.text) && /Bob/.test(r.text));
      expect(chair.length).toBeGreaterThan(0);
      expect(chair.every((r) => r.lane !== "recsys" && r.lane !== "narrative")).toBe(true);
      expect(chair.every((r) => (r.lane || "chat") === "chat" || r.lane === "fact")).toBe(true);
    });
  });
});

describe("M31.4 EventQA miller is narrative, not recsys", () => {
  test("miller of Blackford paragraph stays narrative", async () => {
    expect(encodeLane(MILLER)).toBe("narrative");
    expect(encodeLane(MILLER)).not.toBe("recsys");
    expect(encodeLane(MILLER)).not.toBe("chat");
    await withMem("eden-m314-miller-", (mem) => {
      mem.observe([{ role: "user", content: MILLER }]);
      const miller = mem.memories().filter((r) => /miller of Blackford/.test(r.text));
      expect(miller.length).toBeGreaterThan(0);
      expect(miller.every((r) => r.lane === "narrative")).toBe(true);
      expect(miller.every((r) => r.lane !== "recsys")).toBe(true);
      expect(storedBlob(mem)).toContain(flatten(MILLER));
    });
  });
});

describe("M31.4 fail-open", () => {
  test("inject throw still pass-through (memoryInjectSwallows)", async () => {
    expect(INDEX_SRC).toMatch(/inject\(messages[\s\S]*catch \{\s*memoryInjectSwallows\.n\+\+/);
    expect(INDEX_SRC).toMatch(/injectBody\(body[\s\S]*catch \{\s*memoryInjectSwallows\.n\+\+/);
    await withMem("eden-m314-inject-throw-", (mem) => {
      mem.observe([{ role: "user", content: RECSYS_LIKED }]);
      const list = [{ role: "user", content: RECSYS_CUE }];
      const before = memoryInjectSwallows.n;
      mem.notesFor = (() => {
        throw new Error("m31.4 inject notesFor boom");
      }) as typeof mem.notesFor;
      let out: unknown;
      expect(() => {
        out = mem.inject(list);
      }).not.toThrow();
      expect(out).toBe(list);
      expect(memoryInjectSwallows.n).toBe(before + 1);
    });
  });

  test("recsys observe must not throw on empty/weird text", async () => {
    await withMem("eden-m314-weird-", (mem) => {
      expect(() => encodeLane("")).not.toThrow();
      expect(() => encodeLane(null as never)).not.toThrow();
      expect(() => encodeLane(undefined as never)).not.toThrow();
      expect(() => mem.observe([])).not.toThrow();
      expect(() => mem.observe([{ role: "user", content: "" }])).not.toThrow();
      expect(() => mem.observe([{ role: "user", content: "   " }])).not.toThrow();
      expect(() => mem.observe([{ role: "user", content: "????" }])).not.toThrow();
      expect(() => mem.observe([{ role: "user", content: "recommend" }])).not.toThrow();
      expect(() => mem.observe([{ role: "user" }])).not.toThrow();
      expect(() => mem.observe([null as never, { role: "user", content: RECSYS_LIKED }])).not.toThrow();
    });
  });
});

describe("M31.4 wrap + hook still silent inject", () => {
  test("wrap/hook/setup/doctor have no memory_search; wrap/hook still call inject/observe", () => {
    for (const p of HOST_FILES) {
      const src = readFileSync(p, "utf8");
      expect(src, p).not.toMatch(/\bmemory_search\b/);
      expect(src, p).not.toMatch(/\bBrainMemory\b/);
    }
    expect(WRAP_SRC).toMatch(/injectBodyThenObserveTools|mem\.inject\(/);
    expect(HOOK_SRC).toMatch(/mem\.inject\(/);
    expect(thisFileHasNoMcp()).toBe(true);
  });

  test("withKnowFacts / Anthropic / UserPromptSubmit packet has movie titles, no MCP", async () => {
    const dir = tmpDir("eden-m314-wrap-");
    const mem = openMemory({ dir });
    const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
    try {
      withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, () => {
        mem.observe([{ role: "user", content: RECSYS_LIKED }]);
        const openai = withKnowFacts({ messages: [{ role: "user", content: RECSYS_CUE }] });
        const openaiPkt = packetOf((openai.messages as unknown[]) ?? []);
        expect(openaiPkt).toMatch(/Superbad/);
        expect(openaiPkt).toMatch(/Hangover/);
        expect(JSON.stringify(openai)).not.toMatch(/\bmemory_search\b/);

        const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: RECSYS_CUE }] });
        expect(JSON.stringify(anth)).toMatch(/Superbad/);
        expect(JSON.stringify(anth)).toMatch(/Hangover/);
        expect(JSON.stringify(anth)).not.toMatch(/\bmemory_search\b/);

        const hook = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          prompt: RECSYS_CUE,
        });
        const ctx = hookCtx(hook);
        expect(ctx).toMatch(/Superbad/);
        expect(ctx).toMatch(/Hangover/);
        expect(JSON.stringify(hook ?? {})).not.toMatch(/\bmemory_search\b/);
      });
    } finally {
      procSpy.mockRestore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M31.4 assemble firewall", () => {
  test("extractCandidates on lane=narrative recsys text yields zero triples", () => {
    const recsysCopula =
      "I liked Superbad (2007), The Hangover (2009), and Knocked Up (2007). Superbad is a comedy. Recommend similar comedies.";
    expect(extractCandidates([recsysCandidate(recsysCopula, { lane: "narrative" })])).toEqual([]);
    expect(extractCandidates([recsysCandidate(recsysCopula, { kind: "narrative" })])).toEqual([]);
    expect(extractCandidates([recsysCandidate(recsysCopula, { lane: "recsys" })])).toEqual([]);
    expect(extractCandidates([recsysCandidate(recsysCopula, { kind: "recsys" })])).toEqual([]);
    expect(extractCandidates([recsysCandidate(recsysCopula, { lane: "narrative", tags: ["recsys"] })])).toEqual([]);
    expect(extractCandidates([recsysCandidate(RECSYS_LIKED, { lane: "narrative" })])).toEqual([]);
    expect(extractCandidates([recsysCandidate(RECSYS_NUMBERED, { lane: "narrative" })])).toEqual([]);
  });

  test.failing("observed recsys atoms (and recsys-tagged notes) yield zero triples", async () => {
    await withMem("eden-m314-assemble-", (mem) => {
      mem.observe([{ role: "user", content: RECSYS_LIKED }]);
      mem.observe([{ role: "user", content: RECSYS_NUMBERED }]);
      const recs = movieRecs(mem);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs.some((r) => (r.tags ?? []).some((t) => t.toLowerCase() === "recsys"))).toBe(true);
      for (const r of recs) {
        expect(extractCandidates([recsysCandidate(r.text, {
          t: r.at,
          kind: r.kind,
          lane: r.lane,
          tags: r.tags,
        })])).toEqual([]);
      }
    });
  });
});

function thisFileHasNoMcp(): boolean {
  const self = readFileSync(join(import.meta.dir, "memory-recsys.test.ts"), "utf8");
  return !/\bmemory_search\s*\(/.test(self);
}
