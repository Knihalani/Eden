/**
 * M36.1 hostile probe. Live inject path (wrap OpenAI, wrap Anthropic, hook).
 * Fail-open catch stays pass-through. Pins every probe so a re-probe is automated.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { injectBodyThenObserveTools } from "../packages/wrap/src/tool-observe";
import { EXPERIENCE_DIRNAME, putExperience } from "./experience-store";
import { retrieveExperience } from "./experience-retrieve";
import { GistStore } from "./gist-store";
import { HowToStore } from "./howto-store";
import {
  AgentMemory,
  MEMORY_MARK,
  PACKET_CHAT_K_DEFAULT,
  PACKET_CHAT_K_MAX,
  PACKET_CHAT_K_MIN,
  memoryInjectSwallows,
  memoryRetrieveCap,
  openMemory,
  sleep,
  type AgentMemory as AgentMemoryType,
} from "./index";
import * as edenMem from "./index";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/57

const INDEX = join(import.meta.dir, "index.ts");
const EP = "M36EPISODE";
const PROC = "M36PROCVERIFY";
const TRAJ = "M36TRAJONLY";
const PIN = "M36PINRULE";
const EMAIL = "kai-m36-probe@example.com";
const CWD = "/tmp/eden-m36-unique-cwd";
const SESSION = "sess-m36-probe";
const CUE_DB = "what database do we use";

const PRODUCT_FILES = [
  "index.ts",
  "../packages/wrap/src/proxy.ts",
  "../packages/wrap/src/know-inject.ts",
  "../packages/wrap/src/tool-observe.ts",
  "../packages/cli/src/memory-hook.ts",
  "../packages/cli/src/setup.ts",
  "../packages/cli/src/doctor.ts",
];

const EVENTQA_FILES = ["chunk-retrieve.ts", "chunk-store.ts", "index.ts"];

function tmpDir(prefix = "eden-m36-"): string {
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
  fn: (mem: AgentMemoryType, dir: string) => T | Promise<T>,
  extra?: { session?: string; cwd?: string; cap?: string },
): Promise<T> {
  const dir = tmpDir(prefix);
  return withEnv(
    {
      EDEN_MEMORY_DIR: dir,
      EDEN_HOME: undefined,
      EDEN_MEMORY: "on",
      EDEN_MEMORY_CAP: extra?.cap,
      EDEN_MEMORY_STORE_CAP: undefined,
    },
    async () => {
      try {
        const mem = openMemory({ dir, session: extra?.session, cwd: extra?.cwd });
        return await fn(mem, dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

function packetOf(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m === "object" ? (m as { role?: string; content?: unknown }) : {}))
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

function anthropicText(body: { system?: unknown; messages?: unknown[] }): string {
  const chunks: string[] = [];
  const sys = body.system;
  if (typeof sys === "string") chunks.push(sys);
  else if (Array.isArray(sys)) {
    for (const b of sys) {
      if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string")
        chunks.push((b as { text: string }).text);
    }
  }
  chunks.push(packetOf(body.messages ?? []));
  return chunks.join("\n");
}

function hookContext(raw: Record<string, unknown> | null): string {
  if (!raw) return "";
  const spec = raw.hookSpecificOutput;
  const extra = spec && typeof spec === "object" ? (spec as { additionalContext?: unknown }).additionalContext : "";
  return [raw.additional_context, extra].map((x) => String(x ?? "")).join("\n");
}

function bullets(hay: string): string[] {
  return hay.split("\n").filter((l) => l.startsWith("- "));
}

function codeWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readProduct(rel: string): string {
  return readFileSync(join(import.meta.dir, rel), "utf8");
}

function gistText(dir: string): string {
  const p = join(dir, "gists.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function readNamed(root: string): string {
  const names = new Set(["memories.jsonl", "semantic.jsonl", "gists.jsonl", "howto.jsonl", "howtos.jsonl"]);
  const chunks: string[] = [];
  const walk = (dir: string, underExperience: boolean) => {
    if (!existsSync(dir)) return;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p, underExperience || ent.name === EXPERIENCE_DIRNAME);
        continue;
      }
      const expFile = underExperience && ent.name.endsWith(".jsonl");
      if (!names.has(ent.name) && !expFile) continue;
      try {
        chunks.push(readFileSync(p, "utf8"));
      } catch {}
    }
  };
  walk(root, false);
  return chunks.join("\n");
}

function assertJsonlIntact(dir: string): void {
  const root = join(dir, "memories.jsonl");
  for (const p of [root, `${root}.wal`]) {
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    if (!raw) continue;
    expect(raw.endsWith("\n"), p).toBe(true);
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const rec = JSON.parse(line) as { id?: unknown; text?: unknown };
      expect(typeof rec.id).toBe("string");
      expect(typeof rec.text).toBe("string");
    }
  }
}

function seedDumpBait(mem: AgentMemoryType, dir: string): void {
  mem.quiet(() => {
    for (let n = 1; n <= 12; n++) {
      mem.remember(`The zeta catalog keeps ${EP}${n} as a durable episode fact.`, { kind: "episode" });
    }
    mem.remember(`Never print ${PIN} in production logs.`, { kind: "constraint" });
  });
  new HowToStore(dir).put({
    cue: `${PROC} auth flake`,
    steps: [{ name: "Bash", args: { command: `echo ${PROC}` }, exit: 0, order: 0 }],
    files: ["m36-probe.ts"],
    verify: `echo ${PROC}`,
    exit: 0,
    t: 1,
  });
  putExperience(dir, {
    id: "traj-m36-empty",
    states: [{ thought: `${TRAJ} the agent walked a long trajectory slice.`, t: 1 }],
  });
}

function expectNoEmptyDump(hay: string): void {
  expect(hay).not.toContain(EP);
  expect(hay).not.toContain(PROC);
  expect(hay).not.toContain(TRAJ);
  expect(hay).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
  expect(hay).not.toMatch(/\[episode(?:\s*·[^\]]*)?\]/);
}

/** OpenAI injectBody, tool-observe, withKnowFacts, Anthropic, and hook submit. */
function livePackets(mem: AgentMemoryType, messages: { role: string; content: string }[], prompt: string): string[] {
  const copies = () => messages.map((m) => ({ ...m }));
  const out: string[] = [];
  out.push(packetOf(mem.inject(copies())));
  const body = mem.injectBody({ model: "gpt-4o", messages: copies() });
  out.push(packetOf((body.messages ?? []) as unknown[]));
  const traced = injectBodyThenObserveTools(mem, { model: "gpt-4o", messages: copies() });
  out.push(packetOf((traced.messages ?? []) as unknown[]));
  const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
  try {
    const wrapped = withKnowFacts({ model: "gpt-4o", messages: copies() });
    out.push(packetOf((wrapped.messages ?? []) as unknown[]));
    const anth = withKnowFactsAnthropic({ messages: copies() });
    out.push(anthropicText(anth));
  } finally {
    procSpy.mockRestore();
  }
  const hook = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt });
  out.push(hookContext(hook));
  return out;
}

describe("M36.1 empty cue", () => {
  test("inject([]) and empty user content do not dump last-k, how-to, or traj", async () => {
    await withMem("eden-m36-empty-", (mem, dir) => {
      seedDumpBait(mem, dir);
      const lists = [
        [] as { role: string; content: string }[],
        [{ role: "user", content: "" }],
        [{ role: "user", content: "   " }],
        [
          { role: "user", content: "" },
          { role: "assistant", content: "" },
        ],
      ];
      for (const list of lists) {
        const calls: string[] = [];
        const orig = mem.notesFor.bind(mem);
        mem.notesFor = ((text = "", ...rest: unknown[]) => {
          calls.push(String(text));
          return orig(text, ...(rest as []));
        }) as typeof mem.notesFor;
        const pkt = packetOf(mem.inject(list));
        expect(calls, JSON.stringify(list)).toEqual([]);
        expect(pkt).not.toContain(MEMORY_MARK);
        expectNoEmptyDump(pkt);
        mem.notesFor = orig;
      }
      for (const hay of livePackets(mem, [{ role: "user", content: "" }], "")) {
        expectNoEmptyDump(hay);
        expect(hay).not.toContain(MEMORY_MARK);
      }
      const anthEmpty = (() => {
        const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
        try {
          return anthropicText(withKnowFactsAnthropic({ messages: [] }));
        } finally {
          procSpy.mockRestore();
        }
      })();
      expectNoEmptyDump(anthEmpty);
      expect(anthEmpty).not.toContain(MEMORY_MARK);
    });
  });

  test("hook SessionStart briefs pins and gists only", async () => {
    await withMem("eden-m36-start-", async (mem, dir) => {
      seedDumpBait(mem, dir);
      mem.observe([{ role: "user", content: "Auth is Clerk." }]);
      await sleep({ dir, mem });
      const start = memoryHookResponse({ hook_event_name: "SessionStart" });
      const ctx = hookContext(start);
      expectNoEmptyDump(ctx);
      expect(ctx).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
      expect(ctx).toContain(PIN);
      expect(ctx).toMatch(/\[rule(?:\s*·[^\]]*)?\]/);
      for (const line of bullets(ctx)) {
        expect(line).toMatch(/^-\s+\[(?:rule|gist)(?:\s*·[^\]]*)?\]/);
      }
      const submit = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "" });
      expectNoEmptyDump(hookContext(submit));
      expect(hookContext(submit)).not.toContain(MEMORY_MARK);
    });
  });

  test.failing("forty experience gists cannot crowd a fact gist off SessionStart", async () => {
    await withMem("eden-m36-crowd-", (mem, dir) => {
      const gs = new GistStore(dir);
      gs.put("Auth is Clerk", "s-m36-crowd", 1);
      for (let i = 0; i < 40; i++) {
        gs.put(`${TRAJ} slice ${i} of a raw trajectory`, `exp-crowd-${i}`, 1000 + i, "experience");
      }
      const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: "s-m36-crowd" });
      const ctx = hookContext(start);
      expect(ctx).toMatch(/Clerk/);
      expect(ctx).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
      expect(ctx).not.toContain(TRAJ);
      expect(gs.latest("s-m36-crowd", 3, { excludeSrc: "experience" }).some((g) => /Clerk/.test(g.text))).toBe(true);
      // Cue retrieve must not pass excludeSrc. Default latest still returns experience rows.
      expect(gs.latest("s-m36-crowd", 32).some((g) => g.src === "experience")).toBe(true);
      expect(gs.latest("s-m36-crowd", 3).some((g) => g.src === "experience")).toBe(true);
      putExperience(dir, {
        id: "traj-m36-crowd-cue",
        states: [{ thought: "EXPCUE36 pytest failed in auth.ts", t: 50 }],
      });
      const cue = "EXPCUE36 pytest auth.ts";
      expect(retrieveExperience(dir, cue).some((s) => /EXPCUE36/.test(s.text))).toBe(true);
      const pkt = packetOf(mem.inject([{ role: "user", content: cue }]));
      expect(pkt).toMatch(/EXPCUE36/);
      expect(pkt).not.toContain(TRAJ);
      for (const rel of ["index.ts", "gist-retrieve.ts", "experience-retrieve.ts"]) {
        expect(codeWithoutComments(readProduct(rel)), rel).not.toMatch(/excludeSrc/);
      }
      const hookSrc = codeWithoutComments(readProduct("../packages/cli/src/memory-hook.ts"));
      expect(hookSrc).toMatch(/excludeSrc:\s*"experience"/);
      expect(hookSrc.match(/excludeSrc/g)?.length).toBe(1);
    });
  });
});

describe("M36.1 unicode path", () => {
  test.failing("openMemory on a unicode dir persists, reloads, and injects", async () => {
    const parent = tmpDir("eden-m36-uni-");
    const dir = join(parent, "记忆-café-日本語");
    try {
      await withEnv(
        { EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_MEMORY: "on", EDEN_MEMORY_CAP: undefined },
        async () => {
          const mem = openMemory({ dir });
          mem.observe([{ role: "user", content: "The unicode catalog token M36UNI is durable." }]);
          mem.close();
          const reloaded = openMemory({ dir });
          expect(reloaded.memories().some((r) => r.text.includes("M36UNI"))).toBe(true);
          const list = [{ role: "user", content: "what is the unicode catalog token" }];
          let pkt = "";
          expect(() => {
            pkt = packetOf(reloaded.inject(list));
          }).not.toThrow();
          expect(pkt).toContain("M36UNI");
          const traced = injectBodyThenObserveTools(reloaded, {
            model: "gpt-4o",
            messages: [{ role: "user", content: "unicode catalog token M36UNI" }],
          });
          expect(packetOf((traced.messages ?? []) as unknown[])).toContain("M36UNI");
          const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => reloaded);
          try {
            const wrapped = withKnowFacts({ messages: [{ role: "user", content: "unicode catalog token M36UNI" }] });
            expect(packetOf((wrapped.messages ?? []) as unknown[])).toContain("M36UNI");
            const anth = withKnowFactsAnthropic({
              messages: [{ role: "user", content: "unicode catalog token M36UNI" }],
            });
            expect(anthropicText(anth)).toContain("M36UNI");
          } finally {
            procSpy.mockRestore();
          }
          const hook = memoryHookResponse({
            hook_event_name: "UserPromptSubmit",
            prompt: "unicode catalog token M36UNI",
          });
          expect(hookContext(hook)).toContain("M36UNI");
          reloaded.close();
          assertJsonlIntact(dir);
        },
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("M36.1 concurrent persist", () => {
  test("two in-process writers do not tear JSONL", async () => {
    const dir = tmpDir("eden-m36-race-");
    try {
      await withEnv(
        {
          EDEN_MEMORY: "on",
          EDEN_MEMORY_DIR: dir,
          EDEN_HOME: undefined,
          EDEN_MEMORY_CAP: undefined,
          EDEN_MEMORY_STORE_CAP: undefined,
        },
        async () => {
          const writer = async (tag: string) => {
            const mem = openMemory({ dir });
            for (let i = 0; i < 12; i++) {
              mem.observe([{ role: "user", content: `The ${tag} catalog item ${i} is durable.` }]);
              await Bun.sleep(1);
            }
            mem.close();
          };
          await Promise.all([writer("alpha"), writer("bravo")]);
          assertJsonlIntact(dir);
          const reloaded = openMemory({ dir });
          const texts = reloaded.memories().map((r) => r.text);
          expect(texts.some((t) => /alpha catalog item 0/i.test(t))).toBe(true);
          expect(texts.some((t) => /bravo catalog item 0/i.test(t))).toBe(true);
          expect(texts.filter((t) => /catalog item/i.test(t)).length).toBe(24);
          expect(() => reloaded.inject([{ role: "user", content: "alpha catalog" }])).not.toThrow();
          reloaded.close();
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("two processes observe and flush without tearing JSONL", async () => {
    const dir = tmpDir("eden-m36-proc-");
    try {
      const src = `
        import { openMemory } from ${JSON.stringify(INDEX)};
        const mem = openMemory({ dir: process.env.EDEN_M36_DIR });
        const tag = process.env.EDEN_M36_TAG;
        for (let i = 0; i < 10; i++) {
          mem.observe([{ role: "user", content: "The " + tag + " process item " + i + " is durable." }]);
        }
        mem.close();
      `;
      const spawn = (tag: string) => {
        const env: Record<string, string | undefined> = {
          ...process.env,
          EDEN_MEMORY: "on",
          EDEN_M36_DIR: dir,
          EDEN_M36_TAG: tag,
        };
        delete env.EDEN_MEMORY_STORE_CAP;
        delete env.EDEN_MEMORY_CAP;
        delete env.EDEN_MEMORY_DIR;
        delete env.EDEN_HOME;
        return Bun.spawn(["bun", "-e", src], { env, stdout: "pipe", stderr: "pipe" });
      };
      const [a, b] = [spawn("alpha"), spawn("bravo")];
      const [ca, cb] = await Promise.all([a.exited, b.exited]);
      if (ca !== 0 || cb !== 0) {
        const err = `${await new Response(a.stderr).text()}\n${await new Response(b.stderr).text()}`;
        throw new Error(`persist children ${ca}/${cb}: ${err}`);
      }
      assertJsonlIntact(dir);
      const reloaded = openMemory({ dir });
      const texts = reloaded
        .memories()
        .map((r) => r.text)
        .join("\n");
      expect(texts).toMatch(/alpha process item 0/i);
      expect(texts).toMatch(/bravo process item 0/i);
      expect(reloaded.memories().filter((r) => /process item/i.test(r.text)).length).toBe(20);
      reloaded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("M36.1 k=40 is not product", () => {
  test.failing("EDEN_MEMORY_CAP=40 clamps to 10 and packet bullets stay ≤10", async () => {
    expect(PACKET_CHAT_K_MIN).toBe(6);
    expect(PACKET_CHAT_K_MAX).toBe(10);
    expect(PACKET_CHAT_K_DEFAULT).toBeGreaterThanOrEqual(PACKET_CHAT_K_MIN);
    expect(PACKET_CHAT_K_DEFAULT).toBeLessThanOrEqual(PACKET_CHAT_K_MAX);
    await withEnv({ EDEN_MEMORY_CAP: undefined }, () => {
      expect(memoryRetrieveCap()).toBe(PACKET_CHAT_K_DEFAULT);
    });
    await withMem(
      "eden-m36-k40-",
      (mem) => {
        expect(memoryRetrieveCap()).toBe(PACKET_CHAT_K_MAX);
        expect(memoryRetrieveCap()).not.toBe(40);
        mem.quiet(() => {
          for (let n = 1; n <= 40; n++) mem.remember(`Hard packet slot ${n} belongs to the omega catalog.`);
        });
        const notes = mem.notesFor("omega catalog");
        expect(notes.length).toBeGreaterThan(0);
        expect(notes.length).toBeLessThanOrEqual(PACKET_CHAT_K_MAX);
        const cue = [{ role: "user", content: "omega catalog" }];
        for (const hay of livePackets(mem, cue, "omega catalog")) {
          const lines = bullets(hay);
          expect(lines.length).toBeLessThanOrEqual(PACKET_CHAT_K_MAX);
          expect(lines.length).toBeGreaterThan(0);
        }
      },
      { cap: "40" },
    );
    const owners = [
      "index.ts",
      "../packages/wrap/src/know-inject.ts",
      "../packages/wrap/src/proxy.ts",
      "../packages/wrap/src/tool-observe.ts",
      "../packages/cli/src/memory-hook.ts",
    ];
    for (const rel of owners) {
      const code = codeWithoutComments(readProduct(rel));
      expect(code, rel).not.toMatch(/EDEN_MEMORY_CAP\s*[:=]\s*["']?40/);
      expect(code, rel).not.toMatch(/notesFor\([^)]*\bk\s*=\s*40\b/);
    }
  });
});

describe("M36.1 BrainMemory column", () => {
  test("wrap, hook, setup, and doctor do not import or score BrainMemory", () => {
    for (const rel of PRODUCT_FILES) {
      const src = readProduct(rel);
      const code = codeWithoutComments(src);
      expect(code, rel).not.toMatch(/\bBrainMemory\b/);
      expect(code, rel).not.toMatch(/brain-memory/);
      expect(src, rel).not.toMatch(/\bfrom\s+['"][^'"]*brain-memory[^'"]*['"]/);
      expect(src, rel).not.toMatch(/\|\s*BrainMemory\s*\|/);
    }
  });
});

describe("M36.1 label-strip", () => {
  test("stored and retrieved ICL still contains label:", async () => {
    await withMem("eden-m36-label-", (mem, dir) => {
      const shot = "The movie was great. label: 28";
      mem.observe([{ role: "user", content: shot }]);
      const stored = mem
        .memories()
        .map((r) => r.text)
        .join("\n");
      expect(stored).toMatch(/label:\s*28/);
      const jsonl = readFileSync(join(dir, "memories.jsonl"), "utf8");
      expect(jsonl).toMatch(/label:\s*28/);
      const cue = [{ role: "user", content: "The movie was great. label:" }];
      for (const hay of livePackets(mem, cue, "The movie was great. label:")) {
        expect(hay).toMatch(/label:\s*28/);
      }
      const reloaded = openMemory({ dir });
      expect(reloaded.memories().some((r) => /label:\s*28/.test(r.text))).toBe(true);
      expect(packetOf(reloaded.inject([{ role: "user", content: "The movie was great. label:" }]))).toMatch(
        /label:\s*28/,
      );
      reloaded.close();
    });
  });
});

describe("M36.1 GraphRAG EventQA", () => {
  test("narrative chunk retrieve is BM25, not GraphRAG or an entity graph", () => {
    const banned = /\b(?:graphrag|raptor|openie|personalizedPageRank|entityGraph)\b|\bPPR\b|entity[-_ ]graph/i;
    for (const rel of EVENTQA_FILES) {
      const code = codeWithoutComments(readProduct(rel));
      expect(banned.test(code), rel).toBe(false);
    }
    const retrieve = codeWithoutComments(readProduct("chunk-retrieve.ts"));
    expect(retrieve).toMatch(/export function bm25Rank/);
    expect(retrieve).toMatch(/export function retrieveNarrativeChunks/);
    expect(retrieve).not.toMatch(/\bhopChain\b/);
    expect(retrieve).not.toMatch(/cls\/complete/);
    const merge = codeWithoutComments(readProduct("index.ts")).match(/function mergeNarrativeLane[\s\S]*?\n\}/);
    expect(merge?.[0] ?? "").toMatch(/retrieveNarrativeChunks/);
    expect(merge?.[0] ?? "").not.toMatch(/\b(?:graphrag|entityGraph|hopChain)\b/i);
  });
});

describe("M36.1 memory_search", () => {
  test("wrap, hook, setup, doctor, and index have zero memory_search hits", () => {
    for (const rel of PRODUCT_FILES) {
      const src = readProduct(rel);
      expect(src, rel).not.toMatch(/\bmemory_search\b/);
      expect(src, rel).not.toMatch(/\bmemorable-cli\b/);
    }
  });
});

describe("M36.1 leftover identity", () => {
  test.failing("Use postgres then Use sqlite instead drops postgres from packet, gists, and slices", async () => {
    await withMem("eden-m36-pg-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "Use postgres" }]);
      mem.observe([{ role: "user", content: "Use sqlite instead" }]);
      putExperience(dir, {
        id: "traj-m36-pg",
        states: [
          { thought: "Use postgres.", t: 1 },
          { thought: "Use sqlite instead.", t: 2 },
        ],
      });
      await sleep({ dir, mem });
      const memories = mem
        .memories()
        .map((r) => r.text)
        .join("\n");
      expect(memories).toMatch(/sqlite/i);
      expect(memories).not.toMatch(/postgres/i);
      const hit = packetOf(mem.inject([{ role: "user", content: "sqlite" }]));
      expect(hit).toMatch(/sqlite/i);
      expect(hit).not.toMatch(/postgres/i);
      for (const hay of livePackets(mem, [{ role: "user", content: CUE_DB }], CUE_DB)) {
        expect(hay).toMatch(/\[fact(?:\s*·[^\]]*)?\]/);
        expect(hay).toMatch(/sqlite/i);
        expect(hay).not.toMatch(/postgres/i);
      }
      const asked = packetOf(mem.inject([{ role: "user", content: "what should we use" }]));
      expect(asked).toMatch(/\[fact(?:\s*·[^\]]*)?\]/);
      expect(asked).toMatch(/sqlite/i);
      expect(asked).not.toMatch(/postgres/i);
      expect(gistText(dir)).toMatch(/sqlite/i);
      expect(gistText(dir)).not.toMatch(/postgres/i);
      for (const cue of [CUE_DB, "what should we use", "postgres", "sqlite"]) {
        const slices = retrieveExperience(dir, cue)
          .map((s) => s.text)
          .join("\n");
        expect(slices).not.toMatch(/postgres/i);
      }
      const start = hookContext(memoryHookResponse({ hook_event_name: "SessionStart" }));
      expect(start).not.toMatch(/postgres/i);
      expect(start).not.toContain(TRAJ);
    });
  });

  test("cwd, email, and session_id are never stored", async () => {
    await withMem(
      "eden-m36-ids-",
      async (mem, dir) => {
        mem.observe([
          {
            role: "user",
            content: `The database is sqlite. Contact ${EMAIL}. cwd ${CWD}. session ${SESSION}.`,
          },
        ]);
        putExperience(dir, {
          id: "traj-m36-ids",
          session: SESSION,
          cwd: CWD,
          states: [{ thought: `goal for ${EMAIL} session ${SESSION} cwd ${CWD} the database is sqlite`, t: 4 }],
        });
        await sleep({ dir, mem, session: SESSION });
        const blob = readNamed(dir);
        expect(blob).not.toContain(SESSION);
        expect(blob).not.toContain(EMAIL);
        expect(blob).not.toContain(CWD);
        expect(blob).toMatch(/sqlite/i);
        const hook = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION,
          cwd: CWD,
          prompt: "what database do we use",
        });
        const ctx = hookContext(hook);
        expect(ctx).not.toContain(SESSION);
        expect(ctx).not.toContain(EMAIL);
        expect(ctx).not.toContain(CWD);
      },
      { session: SESSION, cwd: CWD },
    );
  });

  test("Auth is Clerk survives Auth is failing after sleep", async () => {
    await withMem("eden-m36-clerk-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "Auth is Clerk." }]);
      mem.observe([{ role: "user", content: "Auth is failing." }]);
      await sleep({ dir, mem });
      for (const hay of livePackets(mem, [{ role: "user", content: "what is auth" }], "what is auth")) {
        expect(hay).toMatch(/Clerk/);
      }
      expect(gistText(dir)).toMatch(/Clerk/);
      expect(mem.memories().some((r) => /Clerk/.test(r.text))).toBe(true);
    });
  });
});

describe("M36.1 fail-open and EDEN_MEMORY=0", () => {
  test("inject throw returns the original messages", async () => {
    await withMem("eden-m36-fail-", (mem) => {
      const list = [{ role: "user", content: "what database do we use" }];
      const body = { model: "gpt-4o", messages: list };
      const before = memoryInjectSwallows.n;
      mem.notesFor = (() => {
        throw new Error("m36 notesFor boom");
      }) as typeof mem.notesFor;
      let injected: unknown;
      expect(() => {
        injected = mem.inject(list);
      }).not.toThrow();
      expect(injected).toBe(list);
      expect(memoryInjectSwallows.n).toBe(before + 1);
      let wrappedBody: unknown;
      expect(() => {
        wrappedBody = mem.injectBody(body);
      }).not.toThrow();
      expect(wrappedBody).toBe(body);
      const traced = injectBodyThenObserveTools(mem, body);
      expect(traced).toBe(body);
      const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
      try {
        expect(withKnowFacts(body)).toBe(body);
        const anth = { messages: list };
        expect(withKnowFactsAnthropic(anth)).toBe(anth);
      } finally {
        procSpy.mockRestore();
      }
    });
  });

  test("hook inject throw returns null", async () => {
    await withMem("eden-m36-hook-fail-", () => {
      const boom = spyOn(AgentMemory.prototype, "inject").mockImplementation(() => {
        throw new Error("m36 hook inject");
      });
      try {
        expect(
          memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "what database do we use" }),
        ).toBeNull();
        expect(memoryHookResponse({ hook_event_name: "SessionStart" })).toBeNull();
      } finally {
        boom.mockRestore();
      }
    });
  });

  test("EDEN_MEMORY=0 is inject identity on wrap and hook", async () => {
    const dir = tmpDir("eden-m36-off-");
    try {
      await withEnv(
        { EDEN_MEMORY: "0", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_MEMORY_CAP: undefined },
        async () => {
          const mem = openMemory({ dir });
          const list = [{ role: "user", content: "The database is sqlite." }];
          const body = { model: "gpt-4o", messages: list };
          expect(mem.inject(list)).toBe(list);
          expect(mem.injectBody(body)).toBe(body);
          expect(packetOf(list)).not.toContain(MEMORY_MARK);
          mem.observe(list);
          expect(mem.memories().some((r) => /sqlite/i.test(r.text))).toBe(false);
          const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
          try {
            expect(withKnowFacts(body)).toBe(body);
            expect(withKnowFactsAnthropic({ messages: list })).toEqual({ messages: list });
            expect(injectBodyThenObserveTools(mem, body)).toBe(body);
          } finally {
            procSpy.mockRestore();
          }
          expect(
            memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "The database is sqlite." }),
          ).toBeNull();
          expect(memoryHookResponse({ hook_event_name: "SessionStart" })).toBeNull();
          mem.close();
        },
      );
      expect(readNamed(dir)).not.toMatch(/sqlite/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
