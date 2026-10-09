/**
 * M36.2 — Plan §7 walkthrough on inject, wrap (OpenAI + Anthropic), and hook.
 * Tests only. Assertions stay honest if the current product misses a step.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { injectBodyThenObserveTools, observeToolTraces } from "../packages/wrap/src/tool-observe";
import { ExperienceStore, putExperience } from "./experience-store";
import { retrieveExperience } from "./experience-retrieve";
import { GistStore } from "./gist-store";
import { HowToStore } from "./howto-store";
import { IclIndex } from "./icl-index";
import {
  AgentMemory,
  MEMORY_MARK,
  PROCEDURE_CHAR_CAP,
  PROCEDURE_TOKEN_CAP,
  memoryInjectSwallows,
  openMemory,
  queryHay,
  sleep,
} from "./index";
import * as edenMem from "./index";
import { loadToolTraces, type ToolTrace } from "./tool-trace";
import { repoIdentity, repoStoreDir } from "./memory-repo";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/66

const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
const COMPLETE_SRC = readFileSync(join(import.meta.dir, "cls/complete.ts"), "utf8");

const RULE = "Always run tests before committing.";
const COMMIT_CUE = "commit these changes";
const CLERK = "Auth is Clerk.";
const FAILING = "Auth is failing.";
const AUTH_CUE = "what is auth";
const USE_PG = "Use postgres.";
const USE_SQLITE = "Use sqlite instead.";
const DB_CUE = "use sqlite";
/** Natural cues. "use sqlite" overlaps the stored token and is too easy. */
const DB_NATURAL = ["what database do we use", "what should we use"] as const;
const PYTEST_CMD = "pytest tests/auth/session.test.ts -q";
const PYTEST_OUT = "collected 1 item\nauth.ts touched\nexit 0";
const FAIL_OUT = "FAILED tests/auth/session.test.ts\nauth.ts\nexit 1";
const FLAKE_CMD_CUE = JSON.stringify({ cmd: PYTEST_CMD, path: "auth.ts" });
const FLAKE_TEXT_CUE = "the flake is in auth.ts";
const PLAYS = "Player Zane plays lacrosse.";
const LOSER = "1. Lacrosse originated in Scotland.";
const WINNER = "8. Lacrosse originated in Canada.";
const HOP_CUE = "What country is the sport of Zane from?";
const ICL_SHOT = "The movie was great. label: 28";
const ICL_CUE = "The movie was great. label: 28";
const HOOK_ICL_CUE = "The movie was great. label:";
const NOVEL =
  "In the year 1847 the miller of Blackford walked beside the river that ran through the valley. " +
  "He remembered the flood of his childhood and the oak that had fallen across the millrace. " +
  "The villagers said the oak still slept under the silt, waiting. " +
  "Winter after winter the mill wheel turned against the ice, and the miller's sons counted sacks of " +
  "grain until the loft beams creaked. " +
  "They spoke of the flood as if it were still coming, and of the oak as if it might rise from the " +
  "millrace after the thaw.";
const JUNK = "The shelf marker is m36-quark-991.";
const TRAJ_MARK = "TRAJ-DUMP-M36-ZEBRA";
const EXP_MARK = "m36-exp-only FAILED pytest in auth.ts";

function tmpDir(prefix: string): string {
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

async function withSession<T>(
  prefix: string,
  session: string,
  fn: (mem: AgentMemory, dir: string) => T | Promise<T>,
): Promise<T> {
  const dir = tmpDir(prefix);
  return withEnv(
    {
      EDEN_MEMORY: "on",
      EDEN_MEMORY_DIR: dir,
      EDEN_HOME: undefined,
      EDEN_KNOW: "0",
      EDEN_MEMORY_CAP: undefined,
    },
    async () => {
      const mem = openMemory({ dir, session });
      try {
        return await fn(mem, dir);
      } finally {
        try {
          mem.close();
        } catch {}
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

async function withProcessMem<T>(mem: AgentMemory, fn: () => T | Promise<T>): Promise<T> {
  const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
  const openSpy = spyOn(edenMem, "openMemory").mockImplementation(() => mem);
  try {
    return await fn();
  } finally {
    procSpy.mockRestore();
    openSpy.mockRestore();
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

function hookContext(raw: Record<string, unknown> | null): string {
  if (!raw) return "";
  const spec = raw.hookSpecificOutput;
  const extra = spec && typeof spec === "object" ? (spec as { additionalContext?: unknown }).additionalContext : "";
  return [raw.additional_context, extra].map((x) => String(x ?? "")).join("\n");
}

function flat(hay: string): string {
  return hay.replace(/\\n/g, "\n");
}

function user(content: string): { role: "user"; content: string }[] {
  return [{ role: "user", content }];
}

function pytestWindow(): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_pytest",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: PYTEST_CMD }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_pytest", content: PYTEST_OUT },
  ];
}

function failPytestWindow(): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_pytest_fail",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: PYTEST_CMD }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_pytest_fail", content: FAIL_OUT, is_error: true },
  ];
}

/** The store the hook keeps for this process's repo under `root` (D1: a payload without `cwd` is keyed by it). */
function hookStore(root: string): string {
  return repoStoreDir(root, repoIdentity(process.cwd())!.key);
}

function tracesOf(dir: string, session: string): ToolTrace[] {
  const dirs = [join(dir, session), dir];
  const out: ToolTrace[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    for (const row of loadToolTraces(d)) {
      const key = `${row.order}\0${row.name}\0${row.t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

function assertFailStored(dir: string, session: string): void {
  const traces = tracesOf(dir, session);
  const blob = JSON.stringify(traces);
  expect(blob).toMatch(/auth\.ts/);
  expect(blob).toMatch(/pytest/i);
  expect(traces.some((t) => t.exit === 1)).toBe(true);
  const exp = experienceHay(dir);
  const mem = existsSync(join(dir, session, "memories.jsonl"))
    ? readFileSync(join(dir, session, "memories.jsonl"), "utf8")
    : "";
  const root = existsSync(join(dir, "memories.jsonl")) ? readFileSync(join(dir, "memories.jsonl"), "utf8") : "";
  const stored = `${blob}\n${exp}\n${mem}\n${root}`;
  expect(stored).toMatch(/auth\.ts/);
  expect(stored).toMatch(/FAILED|exit.: 1|exit":1|"exit":1/i);
}

function experienceHay(dir: string): string {
  const exp = join(dir, "experience");
  if (!existsSync(exp)) return "";
  const chunks: string[] = [];
  for (const name of readdirSync(exp)) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      chunks.push(readFileSync(join(exp, name), "utf8"));
    } catch {}
  }
  return chunks.join("\n");
}

function assertRule(hay: string): void {
  const text = flat(hay);
  expect(text).toContain(MEMORY_MARK);
  expect(text).toMatch(/\[rule(?:\s*·[^\]]*)?\]/);
  expect(text).toMatch(/Always run tests before committing/);
  expect(text).not.toMatch(/\[rule(?:\s*·[^\]]*)?\]\s+\[rule(?:\s*·[^\]]*)?\]/);
}

function assertClerk(hay: string): void {
  expect(flat(hay)).toMatch(/Clerk/);
}

function assertSqlite(hay: string): void {
  const text = flat(hay);
  expect(text).toMatch(/\[fact(?:\s*·[^\]]*)?\]/);
  expect(text).toMatch(/sqlite/i);
  expect(text).not.toMatch(/postgres/i);
  const facts = [...text.matchAll(/\[fact(?:\s*·[^\]]*)?\][^\n]*/gi)].map((m) => m[0]);
  expect(facts.some((line) => /sqlite/i.test(line))).toBe(true);
}

function assertFailRetrieved(hay: string): void {
  const text = flat(hay);
  expect(text).toMatch(/auth\.ts/);
  expect(text).toMatch(/FAILED|exit 1/);
  expect(text).toMatch(/session\.test\.ts/);
}

function procedureBodies(hay: string): string[] {
  return flat(hay)
    .split("\n")
    .filter((line) => /\[procedure(?:\s*·[^\]]*)?\]/i.test(line))
    .map((line) => line.replace(/^.*\[procedure(?:\s*·[^\]]*)?\]\s*/i, "").trim());
}

function assertProcedure(hay: string): void {
  const text = flat(hay);
  expect(text).toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
  expect(text).toMatch(/auth\.ts/);
  expect(text).toMatch(/pytest/i);
  expect(text).toMatch(/tests\/auth\/session\.test\.ts/);
  const bodies = procedureBodies(text);
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    expect(body.length).toBeLessThanOrEqual(PROCEDURE_CHAR_CAP);
    expect(Math.ceil(body.length / 4)).toBeLessThanOrEqual(PROCEDURE_TOKEN_CAP);
  }
}

/** No procedure: `inject` tags one `[procedure]`; the hook words it without a tag (D14), so its `verify:` names it. */
function assertNoProcedure(hay: string): void {
  expect(flat(hay)).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
  expect(flat(hay)).not.toMatch(/\b(?:verify|unknown): /);
}

function assertCanada(hay: string): void {
  const text = flat(hay);
  expect(text).toMatch(/Canada/);
  expect(text).not.toMatch(/Scotland/);
  const facts = [...text.matchAll(/\[fact(?:\s*·[^\]]*)?\][^\n]*/gi)].map((m) => m[0]);
  expect(facts.length).toBeGreaterThan(0);
  expect(facts[0]).toMatch(/Canada/);
  expect(facts[0]).not.toMatch(/Scotland/);
}

function assertIclShot(hay: string): void {
  const text = flat(hay);
  expect(text).toMatch(/label:\s*28/);
  expect(text).not.toMatch(/Blackford/);
  expect(text).not.toMatch(/millrace/);
}

function forOpenAI(mem: AgentMemory, cue: string, check: (hay: string) => void): void {
  const body = mem.injectBody({ model: "gpt-4o", messages: user(cue) });
  check(packetOf((body.messages ?? []) as unknown[]));
  const traced = injectBodyThenObserveTools(mem, { model: "gpt-4o", messages: user(cue) });
  check(packetOf((traced.messages ?? []) as unknown[]));
}

async function forKnow(mem: AgentMemory, cue: string, check: (hay: string) => void): Promise<void> {
  await withProcessMem(mem, () => {
    const wrapped = withKnowFacts({ model: "gpt-4o", messages: user(cue) });
    check(packetOf((wrapped.messages ?? []) as unknown[]));
    const anth = withKnowFactsAnthropic({
      system: "You are a coding agent.",
      messages: user(cue),
    });
    check(JSON.stringify(anth));
  });
}

function hookSubmit(session: string, prompt: string): string {
  return hookContext(
    memoryHookResponse({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt,
    }),
  );
}

function hookStop(session: string): void {
  expect(memoryHookResponse({ hook_event_name: "Stop", session_id: session })).toBeNull();
}

describe("M36.2 walkthrough 1 — commit cue labels [rule]", () => {
  test.failing("inject", async () => {
    await withSession("eden-m36-1i-", "s-m36-1i", async (mem) => {
      mem.observe(user(RULE));
      assertRule(packetOf(mem.inject(user(COMMIT_CUE))));
    });
  });

  test.failing("wrap OpenAI and Anthropic", async () => {
    await withSession("eden-m36-1w-", "s-m36-1w", async (mem) => {
      mem.observe(user(RULE));
      forOpenAI(mem, COMMIT_CUE, assertRule);
      await forKnow(mem, COMMIT_CUE, assertRule);
    });
  });

  test.failing("hook submit", async () => {
    await withSession("eden-m36-1h-", "s-m36-1h", async () => {
      memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: "s-m36-1h", prompt: RULE });
      assertRule(hookSubmit("s-m36-1h", COMMIT_CUE));
    });
  });
});

describe("M36.2 walkthrough 2 — Clerk survives Auth is failing after sleep", () => {
  test("inject", async () => {
    await withSession("eden-m36-2i-", "s-m36-2i", async (mem, dir) => {
      mem.observe(user(CLERK));
      mem.observe(user(FAILING));
      await sleep({ dir, mem, session: "s-m36-2i" });
      const pkt = packetOf(mem.inject(user(AUTH_CUE)));
      assertClerk(pkt);
      expect(pkt).toContain(MEMORY_MARK);
    });
  });

  test("wrap OpenAI and Anthropic", async () => {
    await withSession("eden-m36-2w-", "s-m36-2w", async (mem, dir) => {
      mem.observe(user(CLERK));
      mem.observe(user(FAILING));
      await sleep({ dir, mem, session: "s-m36-2w" });
      forOpenAI(mem, AUTH_CUE, assertClerk);
      await forKnow(mem, AUTH_CUE, assertClerk);
    });
  });

  test("hook Stop then later cue", async () => {
    await withSession("eden-m36-2h-", "s-m36-2h", async () => {
      memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: "s-m36-2h", prompt: CLERK });
      memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: "s-m36-2h", prompt: FAILING });
      hookStop("s-m36-2h");
      // The second Submit delivered Clerk; a compaction re-arms it (A4 §4), so the later cue shows what survived.
      memoryHookResponse({ hook_event_name: "SessionStart", source: "compact", session_id: "s-m36-2h" });
      const later = hookSubmit("s-m36-2h", AUTH_CUE);
      assertClerk(later);
      expect(later).toContain(MEMORY_MARK);
    });
  });
});

describe("M36.2 walkthrough 3 — sqlite wins; postgres absent after sleep", () => {
  test.failing("inject", async () => {
    await withSession("eden-m36-3i-", "s-m36-3i", async (mem, dir) => {
      mem.observe(user(USE_PG));
      mem.observe(user(USE_SQLITE));
      await sleep({ dir, mem, session: "s-m36-3i" });
      for (const cue of [DB_CUE, ...DB_NATURAL]) assertSqlite(packetOf(mem.inject(user(cue))));
      expect(mem.memories().some((r) => /postgres/i.test(r.text))).toBe(false);
    });
  });

  test.failing("wrap OpenAI and Anthropic", async () => {
    await withSession("eden-m36-3w-", "s-m36-3w", async (mem, dir) => {
      mem.observe(user(USE_PG));
      mem.observe(user(USE_SQLITE));
      await sleep({ dir, mem, session: "s-m36-3w" });
      for (const cue of [DB_CUE, ...DB_NATURAL]) {
        forOpenAI(mem, cue, assertSqlite);
        await forKnow(mem, cue, assertSqlite);
      }
    });
  });

  test.failing("hook Stop then later cue", async () => {
    await withSession("eden-m36-3h-", "s-m36-3h", async () => {
      memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: "s-m36-3h", prompt: USE_PG });
      memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: "s-m36-3h", prompt: USE_SQLITE });
      hookStop("s-m36-3h");
      for (const cue of [DB_CUE, ...DB_NATURAL]) assertSqlite(hookSubmit("s-m36-3h", cue));
    });
  });
});

describe("M36.2 walkthrough 4 — failing pytest stored; flake cue retrieves it", () => {
  test("wrap observeToolTraces and injectBodyThenObserveTools", async () => {
    await withSession("eden-m36-4w-", "s-m36-4w", async (mem, dir) => {
      observeToolTraces(mem, failPytestWindow());
      injectBodyThenObserveTools(mem, { model: "gpt-4o", messages: failPytestWindow() });
      assertFailStored(dir, "s-m36-4w");
      expect(new HowToStore(dir).latest("auth pytest flake", 10).filter((r) => r.exit === 0)).toEqual([]);
      assertFailRetrieved(packetOf(mem.inject(user(FLAKE_TEXT_CUE))));
      forOpenAI(mem, FLAKE_TEXT_CUE, assertFailRetrieved);
      await forKnow(mem, FLAKE_TEXT_CUE, assertFailRetrieved);
    });
  });

  test("hook PostToolUse failure then flake cue", async () => {
    await withSession("eden-m36-4h-", "s-m36-4h", async (_mem, dir) => {
      expect(
        memoryHookResponse({
          hook_event_name: "PostToolUse",
          session_id: "s-m36-4h",
          tool_name: "Bash",
          tool_input: { command: PYTEST_CMD },
          tool_response: FAIL_OUT,
        }),
      ).toBeNull();
      assertFailStored(hookStore(dir), "s-m36-4h");
      assertFailRetrieved(hookSubmit("s-m36-4h", FLAKE_TEXT_CUE));
    });
  });
});

describe("M36.2 walkthrough 5 — successful fix sleeps into [procedure]; chat-only does not", () => {
  test("procedure cap is ~300 tokens", () => {
    expect(PROCEDURE_TOKEN_CAP).toBe(300);
    expect(PROCEDURE_CHAR_CAP).toBe(PROCEDURE_TOKEN_CAP * 4);
    expect(FLAKE_CMD_CUE).toContain('"cmd"');
    expect(FLAKE_CMD_CUE).not.toContain('"command"');
  });

  test.failing("inject after sleep: cmd cue still matches; body under the cap", async () => {
    await withSession("eden-m36-5i-", "s-m36-5i", async (mem, dir) => {
      observeToolTraces(mem, pytestWindow());
      await sleep({ dir, mem, session: "s-m36-5i" });
      const rows = new HowToStore(dir).latest("auth pytest flake", 5);
      expect(rows.some((r) => /command/.test(JSON.stringify(r)))).toBe(true);
      assertProcedure(packetOf(mem.inject(user(FLAKE_CMD_CUE))));
      assertProcedure(packetOf(mem.inject(user(FLAKE_TEXT_CUE))));
    });
  });

  test.failing("wrap OpenAI and Anthropic", async () => {
    await withSession("eden-m36-5w-", "s-m36-5w", async (mem, dir) => {
      observeToolTraces(mem, pytestWindow());
      await sleep({ dir, mem, session: "s-m36-5w" });
      forOpenAI(mem, FLAKE_CMD_CUE, assertProcedure);
      await forKnow(mem, FLAKE_CMD_CUE, assertProcedure);
    });
  });

  test.failing("hook PostToolUse success, Stop, cmd cue", async () => {
    await withSession("eden-m36-5h-", "s-m36-5h", async () => {
      expect(
        memoryHookResponse({
          hook_event_name: "PostToolUse",
          session_id: "s-m36-5h",
          tool_name: "Bash",
          tool_input: { command: PYTEST_CMD },
          tool_response: PYTEST_OUT,
        }),
      ).toBeNull();
      hookStop("s-m36-5h");
      assertProcedure(hookSubmit("s-m36-5h", FLAKE_CMD_CUE));
      assertProcedure(hookSubmit("s-m36-5h", FLAKE_TEXT_CUE));
    });
  });

  test("chat-only mints no [procedure] on inject, wrap, or hook", async () => {
    await withSession("eden-m36-5c-", "s-m36-5c", async (mem, dir) => {
      mem.observe(user(CLERK));
      await sleep({ dir, mem, session: "s-m36-5c" });
      const clerk = packetOf(mem.inject(user(AUTH_CUE)));
      assertClerk(clerk);
      assertNoProcedure(clerk);
      assertNoProcedure(packetOf(mem.inject(user(FLAKE_TEXT_CUE))));
      forOpenAI(mem, FLAKE_TEXT_CUE, assertNoProcedure);
      await forKnow(mem, AUTH_CUE, (hay) => {
        assertNoProcedure(hay);
        assertClerk(hay);
      });
      assertNoProcedure(hookSubmit("s-m36-5c", FLAKE_TEXT_CUE));
      expect(new HowToStore(dir).latest("auth pytest flake", 5)).toEqual([]);
    });
  });
});

describe("M36.2 walkthrough 6 — SessionStart is gists + pins; empty cue dumps nothing", () => {
  async function seedBrief(mem: AgentMemory, dir: string, session: string): Promise<void> {
    mem.observe(user(RULE));
    mem.observe(user("The deploy region is us-east-1."));
    await sleep({ dir, mem, session });
    expect(new GistStore(dir).latest(session, 5).length).toBeGreaterThan(0);
    mem.observe(user(JUNK));
    putExperience(dir, {
      id: "traj-m36-dump",
      states: [{ thought: `${TRAJ_MARK} collected 1 item auth.ts`, t: 1 }],
    });
    new HowToStore(dir).put({
      cue: "auth pytest flake",
      steps: [{ name: "Bash", args: { command: PYTEST_CMD }, files: ["auth.ts"], exit: 0, order: 0 }],
      files: ["auth.ts"],
      verify: PYTEST_CMD,
      exit: 0,
      t: 1,
    });
    expect(mem.notesFor("").some((r) => /m36-quark-991/.test(r.text))).toBe(true);
  }

  function assertEmpty(hay: string): void {
    const text = flat(hay);
    expect(text).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
    expect(text).not.toContain(TRAJ_MARK);
    expect(text).not.toMatch(/m36-quark-991/);
    expect(text).not.toContain(MEMORY_MARK);
  }

  test.failing("inject empty cue", async () => {
    await withSession("eden-m36-6i-", "s-m36-6i", async (mem, dir) => {
      await seedBrief(mem, dir, "s-m36-6i");
      assertEmpty(packetOf(mem.inject([])));
      assertEmpty(packetOf(mem.inject(user(""))));
      assertEmpty(packetOf(mem.inject([{ role: "assistant", content: "working" }])));
    });
  });

  test.failing("wrap empty cue", async () => {
    await withSession("eden-m36-6w-", "s-m36-6w", async (mem, dir) => {
      await seedBrief(mem, dir, "s-m36-6w");
      forOpenAI(mem, "", assertEmpty);
      await forKnow(mem, "", assertEmpty);
    });
  });

  test.failing("hook SessionStart briefs pins and gists, not eviction junk or a traj dump", async () => {
    await withSession("eden-m36-6h-", "s-m36-6h", async (mem, dir) => {
      await seedBrief(mem, dir, "s-m36-6h");
      const start = hookContext(
        memoryHookResponse({
          hook_event_name: "SessionStart",
          session_id: "s-m36-6h",
        }),
      );
      expect(start).toContain(MEMORY_MARK);
      expect(start).toMatch(/\[rule(?:\s*·[^\]]*)?\]/);
      expect(start).toMatch(/Always run tests before committing/);
      expect(start).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
      const bullets = flat(start)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("-"));
      expect(bullets.length).toBeGreaterThan(0);
      expect(bullets.every((l) => /^-\s*\[(rule|gist)(?:\s*·[^\]]*)?\]/.test(l))).toBe(true);
      expect(start).not.toMatch(/\[fact(?:\s*·[^\]]*)?\][^\n]*m36-quark-991/);
      expect(start).not.toMatch(/\[episode(?:\s*·[^\]]*)?\]/);
      expect(start).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
      expect(start).not.toContain(TRAJ_MARK);
      expect(start).not.toMatch(/collected 1 item/);
      assertEmpty(hookSubmit("s-m36-6h", ""));
    });
  });
});

describe("M36.2 walkthrough 7 — fail-open and EDEN_MEMORY=0 identity", () => {
  test("ranker throw returns the original messages", async () => {
    await withSession("eden-m36-7r-", "s-m36-7r", async (mem) => {
      mem.observe(user(CLERK));
      const list = user(AUTH_CUE);
      const boom = spyOn(mem, "relevant").mockImplementation(() => {
        throw new Error("m36 ranker boom");
      });
      const before = memoryInjectSwallows.n;
      try {
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(out).toBe(list);
        expect(memoryInjectSwallows.n).toBe(before + 1);
      } finally {
        boom.mockRestore();
      }
    });
  });

  test("persist lock fault does not throw into inject", async () => {
    await withSession("eden-m36-7p-", "s-m36-7p", async (mem, dir) => {
      mem.observe(user(CLERK));
      const lock = join(dir, "s-m36-7p", "memories.jsonl") + ".lock";
      const fd = openSync(lock, "wx");
      try {
        const list = user(AUTH_CUE);
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
        expect(JSON.stringify(out)).not.toMatch(/\b500\b|Internal Server Error/i);
      } finally {
        closeSync(fd);
      }
    });
  }, 10_000);

  test("experience fault returns original messages for an experience-only cue", async () => {
    await withSession("eden-m36-7e-", "s-m36-7e", async (mem, dir) => {
      putExperience(dir, {
        id: "traj-m36-only",
        states: [{ thought: EXP_MARK, t: 1 }],
      });
      const cue = "m36-exp-only auth.ts";
      expect(retrieveExperience(dir, cue).some((h) => /m36-exp-only/.test(h.text))).toBe(true);
      const boom = spyOn(ExperienceStore.prototype, "ids").mockImplementation(() => {
        throw new Error("m36 experience ids boom");
      });
      const before = memoryInjectSwallows.n;
      try {
        const list = user(cue);
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(out).toBe(list);
        expect(packetOf(out as unknown[])).not.toContain(MEMORY_MARK);
        expect(memoryInjectSwallows.n).toBe(before);
      } finally {
        boom.mockRestore();
      }
    });
  });

  test("experience fault still leaves a lexical Clerk packet (lane catch)", async () => {
    await withSession("eden-m36-7c-", "s-m36-7c", async (mem) => {
      mem.observe(user(CLERK));
      const boom = spyOn(ExperienceStore.prototype, "ids").mockImplementation(() => {
        throw new Error("m36 experience clerk boom");
      });
      try {
        let out: unknown;
        expect(() => {
          out = mem.inject(user(AUTH_CUE));
        }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
        assertClerk(packetOf(out as unknown[]));
      } finally {
        boom.mockRestore();
      }
    });
  });

  test("inject throw is swallowed on inject, wrap, and hook", async () => {
    const list = user(AUTH_CUE);
    const body = { model: "gpt-4o", messages: user(AUTH_CUE) };
    const anth = { system: "be brief", messages: user(AUTH_CUE) };
    const boom = spyOn(AgentMemory.prototype, "notesFor").mockImplementation(() => {
      throw new Error("m36 notesFor boom");
    });
    try {
      await withSession("eden-m36-7x-", "s-m36-7x", async (mem) => {
        mem.observe(user(CLERK));
        const before = memoryInjectSwallows.n;
        let injected: unknown;
        expect(() => {
          injected = mem.inject(list);
        }).not.toThrow();
        expect(injected).toBe(list);
        expect(memoryInjectSwallows.n).toBe(before + 1);

        const beforeBody = memoryInjectSwallows.n;
        let injectedBody: unknown;
        expect(() => {
          injectedBody = mem.injectBody(body);
        }).not.toThrow();
        expect(injectedBody).toBe(body);
        expect(memoryInjectSwallows.n).toBe(beforeBody + 1);

        await withProcessMem(mem, () => {
          const beforeWrap = memoryInjectSwallows.n;
          const wrapBody = { messages: user(AUTH_CUE) };
          expect(withKnowFacts(wrapBody)).toBe(wrapBody);
          expect(memoryInjectSwallows.n).toBe(beforeWrap + 1);
          const beforeAnth = memoryInjectSwallows.n;
          expect(withKnowFactsAnthropic(anth)).toBe(anth);
          expect(memoryInjectSwallows.n).toBe(beforeAnth + 1);
        });

        const beforeHook = memoryInjectSwallows.n;
        let hookOut: unknown;
        expect(() => {
          hookOut = memoryHookResponse({
            hook_event_name: "UserPromptSubmit",
            session_id: "s-m36-7x",
            prompt: AUTH_CUE,
          });
        }).not.toThrow();
        expect(hookOut).toBeNull();
        expect(memoryInjectSwallows.n).toBe(beforeHook + 1);
      });
    } finally {
      boom.mockRestore();
    }
  });

  test("EDEN_MEMORY=0 is identity on inject, wrap, and hook", async () => {
    await withSession("eden-m36-7z-", "s-m36-7z", async (mem, dir) => {
      mem.observe(user(CLERK));
      await withEnv({ EDEN_MEMORY: "0", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, async () => {
        const list = user(AUTH_CUE);
        const out = mem.inject(list);
        expect(out).toBe(list);
        expect(packetOf(out)).not.toContain(MEMORY_MARK);
        const body = { model: "gpt-4o", messages: list };
        expect(mem.injectBody(body)).toBe(body);
        await withProcessMem(mem, () => {
          const wrapBody = { messages: list };
          expect(withKnowFacts(wrapBody)).toBe(wrapBody);
          const anth = { system: "be brief", messages: list };
          expect(withKnowFactsAnthropic(anth)).toBe(anth);
        });
        expect(
          memoryHookResponse({
            hook_event_name: "UserPromptSubmit",
            session_id: "s-m36-7z",
            prompt: AUTH_CUE,
          }),
        ).toBeNull();
        expect(
          memoryHookResponse({
            hook_event_name: "SessionStart",
            session_id: "s-m36-7z",
          }),
        ).toBeNull();
      });
    });
  });
});

describe("M36.2 walkthrough 8 — chat-only still gets 1–3 and 6–7; no diet or CircleCI pins", () => {
  test("queryHay is tokenize+skip; pinEnvFact and CircleCI are gone", () => {
    expect(queryHay("best restaurant").has("diet")).toBe(false);
    expect(queryHay("what diet am I on").has("diet")).toBe(true);
    expect(INDEX_SRC).not.toMatch(/\bpinEnvFact\b/);
    expect(INDEX_SRC).not.toMatch(/CircleCI/);
    expect(INDEX_SRC).not.toMatch(/staging\.example/);
  });

  test.failing("set up ci does not pin CircleCI; restaurant cue does not pull a diet fact", async () => {
    await withSession("eden-m36-8p-", "s-m36-8p", async (mem) => {
      mem.remember("CI is GitHub Actions and we set up ci with reusable workflows");
      mem.remember("CI is CircleCI");
      const top = mem.notesFor("set up ci")[0]?.text ?? "";
      expect(top).toMatch(/GitHub Actions/i);
      expect(top).not.toBe("CI is CircleCI");
      expect(top).not.toBe("[fact] CI is CircleCI");
      mem.observe(user("Kai has a peanut diet allergy and skips dairy."));
      mem.observe(user("The restaurant to book is Noma."));
      const pkt = packetOf(mem.inject(user("best restaurant")));
      expect(pkt).not.toMatch(/diet allergy|peanut/i);
    });
  });

  test.failing("chat-only inject, wrap, and hook still do 1–3 and 6–7 with no [procedure]", async () => {
    await withSession("eden-m36-8c-", "s-m36-8c", async (mem, dir) => {
      mem.observe(user(RULE));
      assertRule(packetOf(mem.inject(user(COMMIT_CUE))));
      assertNoProcedure(packetOf(mem.inject(user(COMMIT_CUE))));

      mem.observe(user(CLERK));
      mem.observe(user(FAILING));
      await sleep({ dir, mem, session: "s-m36-8c" });
      const clerk = packetOf(mem.inject(user(AUTH_CUE)));
      assertClerk(clerk);
      assertNoProcedure(clerk);

      mem.observe(user(USE_PG));
      mem.observe(user(USE_SQLITE));
      await sleep({ dir, mem, session: "s-m36-8c" });
      for (const cue of [DB_CUE, ...DB_NATURAL]) {
        const db = packetOf(mem.inject(user(cue)));
        assertSqlite(db);
        assertNoProcedure(db);
      }

      expect(new GistStore(dir).latest("s-m36-8c", 5).length).toBeGreaterThan(0);
      mem.observe(user(JUNK));
      putExperience(dir, {
        id: "traj-m36-chat",
        states: [{ thought: TRAJ_MARK, t: 2 }],
      });
      const empty = packetOf(mem.inject(user("")));
      expect(empty).not.toContain(MEMORY_MARK);
      expect(empty).not.toContain(TRAJ_MARK);
      expect(empty).not.toMatch(/m36-quark-991/);

      const start = hookContext(
        memoryHookResponse({
          hook_event_name: "SessionStart",
          session_id: "s-m36-8c",
        }),
      );
      expect(start).toMatch(/\[rule(?:\s*·[^\]]*)?\]/);
      expect(start).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
      const bullets = flat(start)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("-"));
      expect(bullets.every((l) => /^-\s*\[(rule|gist)(?:\s*·[^\]]*)?\]/.test(l))).toBe(true);
      expect(start).not.toMatch(/\[fact(?:\s*·[^\]]*)?\][^\n]*m36-quark-991/);
      expect(start).not.toContain(TRAJ_MARK);
      assertNoProcedure(start);

      const list = user(COMMIT_CUE);
      const boom = spyOn(mem, "relevant").mockImplementation(() => {
        throw new Error("m36 chat ranker");
      });
      const before = memoryInjectSwallows.n;
      try {
        expect(mem.inject(list)).toBe(list);
        expect(memoryInjectSwallows.n).toBe(before + 1);
      } finally {
        boom.mockRestore();
      }

      await withEnv({ EDEN_MEMORY: "0", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, () => {
        const offList = user(AUTH_CUE);
        const off = mem.inject(offList);
        expect(off).toBe(offList);
        expect(packetOf(off)).not.toContain(MEMORY_MARK);
      });

      forOpenAI(mem, COMMIT_CUE, assertNoProcedure);
      await forKnow(mem, DB_CUE, assertNoProcedure);
      assertNoProcedure(hookSubmit("s-m36-8c", AUTH_CUE));
    });
  });
});

describe("M36.2 walkthrough 9 — two-hop overwrite still holds after sleep", () => {
  test("REL_ALIASES has no sport / plays / originated / lacrosse", () => {
    const aliases = COMPLETE_SRC.match(/const REL_ALIASES: Record<string, string> = \{[\s\S]*?\n\};/);
    expect(aliases?.[0]).toBeTruthy();
    const block = aliases![0]!;
    expect(block).not.toMatch(/\bsport\b/i);
    expect(block).not.toMatch(/\bplays\b/i);
    expect(block).not.toMatch(/\boriginated\b/i);
    expect(block).not.toMatch(/\blacrosse\b/i);
  });

  function seedHop(mem: AgentMemory): void {
    // Product path is observe. remember() is the M22 unit fixture; extract must keep the plays fact.
    const plays = mem.observe(user(PLAYS));
    expect(plays.some((r) => /Zane/.test(r.text) && /lacrosse/i.test(r.text))).toBe(true);
    mem.observe(user(LOSER));
    mem.observe(user(WINNER));
  }

  test.failing("inject before and after sleep", async () => {
    await withSession("eden-m36-9i-", "s-m36-9i", async (mem, dir) => {
      seedHop(mem);
      assertCanada(packetOf(mem.inject(user(HOP_CUE))));
      await sleep({ dir, mem, session: "s-m36-9i" });
      assertCanada(packetOf(mem.inject(user(HOP_CUE))));
    });
  });

  test.failing("wrap OpenAI and Anthropic before and after sleep", async () => {
    await withSession("eden-m36-9w-", "s-m36-9w", async (mem, dir) => {
      seedHop(mem);
      forOpenAI(mem, HOP_CUE, assertCanada);
      await forKnow(mem, HOP_CUE, assertCanada);
      await sleep({ dir, mem, session: "s-m36-9w" });
      forOpenAI(mem, HOP_CUE, assertCanada);
      await forKnow(mem, HOP_CUE, assertCanada);
    });
  });

  test.failing("hook before Stop and after consolidate", async () => {
    await withSession("eden-m36-9h-", "s-m36-9h", async (mem) => {
      seedHop(mem);
      assertCanada(hookSubmit("s-m36-9h", HOP_CUE));
      hookStop("s-m36-9h");
      assertCanada(hookSubmit("s-m36-9h", HOP_CUE));
    });
  });
});

describe("M36.2 walkthrough 10 — ICL shot survives a novel-sized narrative ingest", () => {
  test("novel fixture is over 400 characters", () => {
    expect(NOVEL.length).toBeGreaterThan(400);
    expect(ICL_SHOT).toMatch(/label:\s*28/);
  });

  function seedLanes(mem: AgentMemory): void {
    mem.observe(user(ICL_SHOT));
    mem.observe(user(NOVEL));
  }

  function assertLaneStore(mem: AgentMemory, dir: string): void {
    const shot = mem.memories().find((r) => /The movie was great/.test(r.text));
    expect(shot).toBeTruthy();
    expect(shot!.text).toContain("label: 28");
    expect(shot!.lane).toBe("icl");
    expect(shot!.text).not.toMatch(/Blackford/);
    const novel = mem.memories().find((r) => /Blackford/.test(r.text));
    expect(novel).toBeTruthy();
    expect(novel!.text.length).toBeGreaterThan(400);
    expect(novel!.lane).toBe("narrative");
    expect(novel!.text).not.toMatch(/label:\s*28/);
    const idx = new IclIndex(dir).all();
    expect(idx.some((r) => /The movie was great/.test(r.text) && /label:\s*28/.test(r.text))).toBe(true);
  }

  test("inject store and cue", async () => {
    await withSession("eden-m36-10i-", "s-m36-10i", async (mem, dir) => {
      seedLanes(mem);
      assertLaneStore(mem, dir);
      assertIclShot(packetOf(mem.inject(user(ICL_CUE))));
    });
  });

  test("wrap OpenAI and Anthropic", async () => {
    await withSession("eden-m36-10w-", "s-m36-10w", async (mem, dir) => {
      seedLanes(mem);
      assertLaneStore(mem, dir);
      forOpenAI(mem, ICL_CUE, assertIclShot);
      await forKnow(mem, ICL_CUE, assertIclShot);
    });
  });

  test("hook", async () => {
    await withSession("eden-m36-10h-", "s-m36-10h", async (_mem, dir) => {
      memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: "s-m36-10h", prompt: ICL_SHOT });
      memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: "s-m36-10h", prompt: NOVEL });
      const store = hookStore(dir);
      const later = openMemory({ dir: store, session: "s-m36-10h", perRepo: true });
      try {
        assertLaneStore(later, store);
      } finally {
        try {
          later.close();
        } catch {}
      }
      // D26: the hook does not deliver what the current prompt already says, so its cue asks for the label.
      assertIclShot(hookSubmit("s-m36-10h", HOOK_ICL_CUE));
    });
  });
});

/** Stranger first hour: one sqlite decision, then a cue that is not that sentence. */
const FIRST_SQLITE = "Use sqlite.";
const FIRST_DB_CUE = DB_NATURAL[0];
const MATH_CUE = "what is 2 + 2";

function assertFirstHourSqlite(hay: string): void {
  assertSqlite(hay);
  assertNoProcedure(hay);
}

describe("M49.3 first session — decide sqlite, new cue, sleep, still sqlite", () => {
  test.failing("wrap OpenAI and Anthropic: cue has sqlite [fact] before and after sleep", async () => {
    await withSession("eden-m49-3w-", "s-m49-3w", async (mem, dir) => {
      mem.observe(user(FIRST_SQLITE));
      forOpenAI(mem, FIRST_DB_CUE, assertFirstHourSqlite);
      await forKnow(mem, FIRST_DB_CUE, assertFirstHourSqlite);
      await sleep({ dir, mem, session: "s-m49-3w" });
      forOpenAI(mem, FIRST_DB_CUE, assertFirstHourSqlite);
      await forKnow(mem, FIRST_DB_CUE, assertFirstHourSqlite);
      expect(packetOf(mem.inject(user(MATH_CUE)))).not.toContain(MEMORY_MARK);
      expect(mem.memories().some((r) => /postgres/i.test(r.text))).toBe(false);
    });
  });

  test.failing("hook: UserPromptSubmit encode, cue, Stop, cue still sqlite", async () => {
    await withSession("eden-m49-3h-", "s-m49-3h", async () => {
      memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: "s-m49-3h", prompt: FIRST_SQLITE });
      assertFirstHourSqlite(hookSubmit("s-m49-3h", FIRST_DB_CUE));
      hookStop("s-m49-3h");
      assertFirstHourSqlite(hookSubmit("s-m49-3h", FIRST_DB_CUE));
      expect(hookSubmit("s-m49-3h", MATH_CUE)).not.toContain(MEMORY_MARK);
    });
  });
});
