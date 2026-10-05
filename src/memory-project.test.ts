/**
 * M44.4: project identity. Session A encodes, session B injects.
 * Episodes stay under the session directory; semantic + gist stay on the root.
 * Wrap restart is a real subprocess (processMemory ignores *.test.ts).
 * Tests may be red until the D owners land product code.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { EXPERIENCE_DIRNAME, putExperience } from "./experience-store";
import { MEMORY_MARK, memoryInjectSwallows, openMemory, type AgentMemory } from "./index";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/58

const INDEX = join(import.meta.dir, "index.ts");
const SESSION_A = "session-a";
const SESSION_B = "session-b";
const DB_CUE = "what database do we use";
const AUTH_CUE = "what auth do we use";
const MATH = "what's 2+2?";
const SQLITE = "The database is sqlite.";
const CLERK = "Auth is Clerk.";
const AX_URL = "https://example.test/m44-ax-dump";
const AX_TREE = "RootWebArea [landmark] heading M44AXDUMP";
const FACT_OR_GIST = /\[(?:fact|gist)(?:\s*[·|][^\]]*)?\]/i;
const PROCEDURE = /\[procedure(?:\s*[·|][^\]]*)?\]/i;
/** A fact or gist bullet in a hook packet, which ends with where it came from (D14). */
const HOOK_FACT_OR_GIST = /\((?:you said|from a summary of earlier work)\b/;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "eden-m44-"));
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

const QUIET = {
  EDEN_MEMORY: "on",
  EDEN_HOME: undefined,
  EDEN_KNOW: "0",
  EDEN_SLEEP_EVERY: "0",
  EDEN_SLEEP_IDLE: "0",
  EDEN_MEMORY_MIN: undefined,
} as const;

function packet(messages: unknown[]): string {
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

function assertJsonlParseable(path: string): void {
  expect(existsSync(path)).toBe(true);
  const raw = readFileSync(path, "utf8");
  expect(raw.length).toBeGreaterThan(0);
  expect(raw.endsWith("\n")).toBe(true);
  const lines = raw.split("\n").filter((line) => line.length > 0);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) JSON.parse(line);
}

function assertSessionLayout(dir: string, allowedDirs: string[]): void {
  const episode = join(dir, SESSION_A, "memories.jsonl");
  expect(existsSync(episode)).toBe(true);
  const episodeText = readFileSync(episode, "utf8");
  expect(episodeText).toMatch(/sqlite/i);
  expect(episodeText).toMatch(/Clerk/);
  expect(existsSync(join(dir, "semantic.jsonl"))).toBe(true);
  expect(existsSync(join(dir, "gists.jsonl"))).toBe(true);
  expect(existsSync(join(dir, SESSION_A, "semantic.jsonl"))).toBe(false);
  expect(existsSync(join(dir, SESSION_A, "gists.jsonl"))).toBe(false);
  expect(existsSync(join(dir, SESSION_B, "semantic.jsonl"))).toBe(false);
  expect(existsSync(join(dir, SESSION_B, "gists.jsonl"))).toBe(false);
  const allowed = new Set(allowedDirs);
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    expect(allowed.has(ent.name)).toBe(true);
  }
}

describe("M44 project identity", () => {
  test.failing("M48.2 holdout ADR: session A UserPromptSubmit + Stop, session B injects Clerk", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, () => {
        memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION_A,
          prompt: "We decided to use Clerk for auth because SSO.",
        });
        memoryHookResponse({ hook_event_name: "Stop", session_id: SESSION_A });
        const auth = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION_B,
          prompt: "what auth provider?",
        });
        const authCtx = hookContext(auth);
        expect(authCtx).toContain(MEMORY_MARK);
        expect(authCtx).toMatch(/Clerk/);
        const math = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION_B,
          prompt: MATH,
        });
        expect(hookContext(math)).not.toMatch(/Clerk/);
      });
      expect(readFileSync(join(dir, "semantic.jsonl"), "utf8")).toMatch(/Clerk/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing("two hook sessions, same dir: A encodes sqlite and Clerk, B injects them", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, () => {
        memoryHookResponse({
          hook_event_name: "Stop",
          session_id: SESSION_A,
          messages: [
            { role: "user", content: SQLITE },
            { role: "user", content: CLERK },
          ],
        });
        const db = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION_B,
          prompt: DB_CUE,
        });
        const dbCtx = hookContext(db);
        expect(dbCtx).toContain(MEMORY_MARK);
        expect(dbCtx).toMatch(/sqlite/i);
        expect(dbCtx).toMatch(FACT_OR_GIST);
        expect(dbCtx).not.toMatch(PROCEDURE);

        const auth = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION_B,
          prompt: AUTH_CUE,
        });
        const authCtx = hookContext(auth);
        expect(authCtx).toContain(MEMORY_MARK);
        expect(authCtx).toMatch(/Clerk/);
        expect(authCtx).toMatch(FACT_OR_GIST);
      });
      assertSessionLayout(dir, [SESSION_A, SESSION_B]);
      expect(existsSync(join(dir, EXPERIENCE_DIRNAME))).toBe(false);
      expect(readFileSync(join(dir, "semantic.jsonl"), "utf8")).toMatch(/sqlite/i);
      expect(readFileSync(join(dir, "gists.jsonl"), "utf8")).toMatch(/sqlite|Clerk/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SessionStart for B briefs sqlite and skips the traj dump; math submit omits the packet", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir, EDEN_MEMORY_MIN: "1" }, () => {
        memoryHookResponse({
          hook_event_name: "Stop",
          session_id: SESSION_A,
          messages: [
            { role: "user", content: SQLITE },
            { role: "user", content: CLERK },
          ],
        });
        putExperience(dir, {
          id: "m44-traj",
          session: SESSION_A,
          states: [{ url: AX_URL, tree: AX_TREE, action: "click", t: 1 }],
        });
        const start = memoryHookResponse({
          hook_event_name: "SessionStart",
          session_id: SESSION_B,
        });
        const ctx = hookContext(start);
        expect(ctx).toContain(MEMORY_MARK);
        expect(ctx).toMatch(/sqlite/i);
        expect(ctx).toMatch(HOOK_FACT_OR_GIST);
        expect(ctx).not.toContain(AX_URL);
        expect(ctx).not.toContain("M44AXDUMP");
        expect(ctx).not.toMatch(/RootWebArea/);
        expect(ctx).not.toMatch(new RegExp(`${EXPERIENCE_DIRNAME}/`));

        const math = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION_B,
          prompt: MATH,
        });
        const mathCtx = hookContext(math);
        expect(mathCtx).not.toContain(MEMORY_MARK);
        expect(mathCtx).not.toMatch(/sqlite/i);
        expect(JSON.stringify(math ?? {})).not.toContain(MEMORY_MARK);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("wrap restart: a non-test subprocess observes sqlite, the next injects it", async () => {
    const dir = tmpDir();
    const cwd = process.cwd();
    const src = `
      import { processMemory } from ${JSON.stringify(INDEX)};
      const mem = processMemory();
      if (process.env.EDEN_M44_MODE === "encode") {
        mem.observe([{ role: "user", content: ${JSON.stringify(SQLITE)} }]);
        await mem.sleep();
        mem.close();
      } else {
        const out = mem.inject([{ role: "user", content: ${JSON.stringify(DB_CUE)} }]);
        process.stdout.write(JSON.stringify(out));
        mem.close();
      }
    `;
    const spawn = (mode: "encode" | "inject") => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        EDEN_MEMORY: "on",
        EDEN_MEMORY_DIR: dir,
        EDEN_KNOW: "0",
        EDEN_SLEEP_EVERY: "0",
        EDEN_SLEEP_IDLE: "0",
        EDEN_M44_MODE: mode,
      };
      delete env.EDEN_HOME;
      delete env.EDEN_MEMORY_MIN;
      return Bun.spawn(["bun", "-e", src], { cwd, env, stdout: "pipe", stderr: "pipe" });
    };
    try {
      const enc = spawn("encode");
      const encCode = await enc.exited;
      if (encCode !== 0) {
        throw new Error(`encode child ${encCode}: ${await new Response(enc.stderr).text()}`);
      }
      const inj = spawn("inject");
      const injCode = await inj.exited;
      const stdout = await new Response(inj.stdout).text();
      if (injCode !== 0) {
        throw new Error(`inject child ${injCode}: ${await new Response(inj.stderr).text()}\n${stdout}`);
      }
      expect(stdout).toContain(MEMORY_MARK);
      expect(stdout).toMatch(/sqlite/i);
      expect(stdout).toMatch(FACT_OR_GIST);
      expect(existsSync(join(dir, "semantic.jsonl")) || existsSync(join(dir, "memories.jsonl"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("chat-only inject has no procedure and does not need an experience dir", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, () => {
        const mem: AgentMemory = openMemory({ dir, session: SESSION_A });
        mem.observe([{ role: "user", content: SQLITE }]);
        mem.observe([{ role: "user", content: CLERK }]);
        const pkt = packet(mem.inject([{ role: "user", content: DB_CUE }]));
        expect(pkt).toContain(MEMORY_MARK);
        expect(pkt).toMatch(/sqlite/i);
        expect(pkt).not.toMatch(PROCEDURE);
        expect(existsSync(join(dir, EXPERIENCE_DIRNAME))).toBe(false);
        mem.close();
      });
      expect(existsSync(join(dir, EXPERIENCE_DIRNAME))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent session writers leave root semantic.jsonl and gists.jsonl parseable", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, async () => {
        const write = async (session: string, text: string) => {
          const mem = openMemory({ dir, session });
          mem.observe([{ role: "user", content: text }]);
          await mem.sleep({ session });
          mem.close();
        };
        await Promise.all([write("session-alpha", SQLITE), write("session-bravo", CLERK)]);
      });
      assertJsonlParseable(join(dir, "semantic.jsonl"));
      assertJsonlParseable(join(dir, "gists.jsonl"));
      const root = readFileSync(join(dir, "semantic.jsonl"), "utf8") + readFileSync(join(dir, "gists.jsonl"), "utf8");
      expect(root).toMatch(/sqlite/i);
      expect(root).toMatch(/Clerk/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inject throw is pass-through and increments swallows", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, () => {
        const mem = openMemory({ dir, session: SESSION_A });
        const list = [{ role: "user", content: DB_CUE }];
        const before = memoryInjectSwallows.n;
        mem.notesFor = (() => {
          throw new Error("m44 inject notesFor");
        }) as typeof mem.notesFor;
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(out).toBe(list);
        expect(memoryInjectSwallows.n).toBe(before + 1);
        mem.close();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing("session B does not resurrect postgres after sqlite overwrite", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, () => {
        memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION_A,
          prompt: "The database is postgres.",
        });
        memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION_A,
          prompt: "The database is sqlite instead of postgres.",
        });
        memoryHookResponse({ hook_event_name: "Stop", session_id: SESSION_A });
        const db = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION_B,
          prompt: DB_CUE,
        });
        const dbCtx = hookContext(db);
        expect(dbCtx).toMatch(/sqlite/i);
        expect(dbCtx).not.toMatch(/postgres/i);
        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: SESSION_B });
        const ctx = hookContext(start);
        expect(ctx).toMatch(/sqlite/i);
        expect(ctx).not.toMatch(/database is postgres/i);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing("same sentence: later sqlite decision replaces postgres on session B", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, () => {
        memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION_A,
          prompt:
            "We decided to use postgres for the database because durability then we decided to use sqlite for " +
            "the database.",
        });
        memoryHookResponse({ hook_event_name: "Stop", session_id: SESSION_A });
        const db = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION_B,
          prompt: DB_CUE,
        });
        const dbCtx = hookContext(db);
        expect(dbCtx).toMatch(/sqlite/i);
        expect(dbCtx).not.toMatch(/postgres/i);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ICL cue on session B does not mix sqlite root facts", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, () => {
        memoryHookResponse({
          hook_event_name: "Stop",
          session_id: SESSION_A,
          messages: [
            { role: "user", content: SQLITE },
            { role: "user", content: "label: 7 Input: a banking wire Output: fraud" },
          ],
        });
        const icl = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION_B,
          prompt: "label: classify this banking wire",
        });
        const ctx = hookContext(icl);
        expect(ctx).toMatch(/label:/i);
        expect(ctx).not.toMatch(/sqlite/i);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing("one Stop transcript: postgres then sqlite, session B does not resurrect postgres", async () => {
    const dir = tmpDir();
    const secretSession = "sess-secret-m44-9f3a";
    const secretCwd = join(dir, "repo-secret-cwd");
    const secretEmail = "ada@secret.example";
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, () => {
        memoryHookResponse({
          hook_event_name: "Stop",
          session_id: secretSession,
          cwd: secretCwd,
          messages: [
            { role: "user", content: "The database is postgres." },
            { role: "user", content: "The database is sqlite." },
            { role: "user", content: `Email the dba at ${secretEmail}` },
          ],
        });
        const db = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION_B,
          cwd: secretCwd,
          prompt: DB_CUE,
        });
        const dbCtx = hookContext(db);
        expect(dbCtx).toMatch(/sqlite/i);
        expect(dbCtx).not.toMatch(/postgres/i);
        expect(dbCtx).not.toContain(secretSession);
        expect(dbCtx).not.toContain(secretCwd);
        expect(dbCtx).not.toContain(secretEmail);

        const start = memoryHookResponse({
          hook_event_name: "SessionStart",
          session_id: SESSION_B,
          cwd: secretCwd,
        });
        const ctx = hookContext(start);
        expect(ctx).toMatch(/sqlite/i);
        expect(ctx).not.toMatch(/postgres/i);
        expect(ctx).not.toMatch(/\(you said/);
        expect(ctx).not.toContain(secretSession);
        expect(ctx).not.toContain(secretCwd);
        expect(ctx).not.toContain(secretEmail);

        const stale = openMemory({ dir, session: "session-stale" });
        stale.observe([{ role: "user", content: "The database is postgres." }], { keepLiveIdentity: true });
        stale.close();
        const again = packet(openMemory({ dir, session: SESSION_B }).inject([{ role: "user", content: DB_CUE }]));
        expect(again).toMatch(/sqlite/i);
        expect(again).not.toMatch(/postgres/i);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("product path has no memory_search and no BrainMemory", () => {
    const files = [
      join(import.meta.dir, "index.ts"),
      join(import.meta.dir, "sleep.ts"),
      join(import.meta.dir, "../packages/cli/src/memory-hook.ts"),
      join(import.meta.dir, "../packages/wrap/src/know-inject.ts"),
      join(import.meta.dir, "../packages/wrap/src/proxy.ts"),
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\bmemory_search\b/);
      expect(src, f).not.toMatch(/\bBrainMemory\b/);
    }
  });
});
