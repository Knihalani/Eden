/**
 * M47.4 — harmed id absent on the next cue.
 * D owns src/memory-harmed.ts. This file only asserts the omit contract.
 *
 *   bun test src/memory-harmed.test.ts
 */
import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { HowToStore } from "./howto-store";
import { MEMORY_MARK, memoryInjectSwallows, openMemory, sleep, type AgentMemory } from "./index";
import * as edenMem from "./index";
import { dropHarmed, harmedPath, loadHarmedIds, markHarmed } from "./memory-harmed";
import * as harmedMod from "./memory-harmed";

const SQLITE = "Use sqlite.";
const CLERK = "Auth is Clerk";
const SQLITE_Q = "What sqlite database do we use?";
const CLERK_Q = "what auth provider?";
const FLAKE_CUE = "the flake is in auth.ts";
const FLAKE_ID = "ht-m47-flake-procedure";
const PYTEST_CMD = "pytest tests/auth/session.test.ts -q";
const SESSION = "m47-session-9f3a7c2b";
const EMAIL = "kai-m47@example.com";
const SECRET = "sk-m47-SECRET";
const HARM_SRC = join(import.meta.dir, "memory-harmed.ts");

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
      EDEN_MEMORY_MIN: undefined,
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

function user(content: string): { role: "user"; content: string }[] {
  return [{ role: "user", content }];
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

function assertNoChrome(hay: string): void {
  expect(hay).not.toContain(MEMORY_MARK);
  expect(hay).not.toContain("Eden Memory:");
}

/** Every on-cue id whose text matches. Semantic and episodic rows are different ids. */
function idsFor(mem: AgentMemory, cue: string, needle: RegExp): string[] {
  const ids = [
    ...new Set(
      mem
        .notesFor(cue)
        .filter((r) => r.id && needle.test(r.text))
        .map((r) => r.id),
    ),
  ];
  expect(ids.length, cue).toBeGreaterThan(0);
  return ids;
}

function harmedRaw(dir: string): string {
  const path = harmedPath(dir);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function assertIdsOnly(raw: string, banned: string[]): void {
  expect(raw).not.toMatch(/"session_id"/);
  expect(raw).not.toMatch(/\bmemory_search\b/);
  for (const s of banned) {
    if (s) expect(raw).not.toContain(s);
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(["at", "id"]);
    expect(typeof row.id).toBe("string");
  }
}

function putFlake(dir: string): void {
  const row = new HowToStore(dir).put({
    id: FLAKE_ID,
    cue: "auth pytest flake",
    steps: [{ name: "Bash", args: { command: PYTEST_CMD }, files: ["auth.ts"], exit: 0, order: 0 }],
    files: ["auth.ts"],
    verify: PYTEST_CMD,
    exit: 0,
    t: 1,
  });
  expect(row?.id).toBe(FLAKE_ID);
}

describe("M47.4 harmed id absent next cue", () => {
  test("only sqlite note: markHarmed drops it and the Eden Memory chrome", async () => {
    await withSession("eden-m47-only-", SESSION, async (mem) => {
      mem.observe(user(SQLITE));
      const before = packetOf(mem.inject(user(SQLITE_Q)) as unknown[]);
      expect(before).toContain(MEMORY_MARK);
      expect(before).toMatch(/sqlite/i);
      const ids = idsFor(mem, SQLITE_Q, /sqlite/i);
      mem.markHarmed(ids);
      for (const id of ids) expect(loadHarmedIds(mem.dir).has(id)).toBe(true);
      const pkt = packetOf(mem.inject(user(SQLITE_Q)) as unknown[]);
      for (const id of ids) expect(pkt).not.toContain(id);
      expect(pkt).not.toMatch(/sqlite/i);
      assertNoChrome(pkt);
    });
  });

  test("a different harmed id leaves the other on-cue fact", async () => {
    await withSession("eden-m47-other-", SESSION, async (mem) => {
      mem.observe(user(SQLITE));
      mem.observe(user(CLERK));
      const clerkIds = idsFor(mem, CLERK_Q, /Clerk/);
      mem.markHarmed(clerkIds);
      const db = packetOf(mem.inject(user(SQLITE_Q)) as unknown[]);
      expect(db).toContain(MEMORY_MARK);
      expect(db).toMatch(/sqlite/i);
      for (const id of clerkIds) expect(db).not.toContain(id);
      const auth = packetOf(mem.inject(user(CLERK_Q)) as unknown[]);
      for (const id of clerkIds) expect(auth).not.toContain(id);
      expect(auth).not.toMatch(/Clerk/);
    });
  });

  test("harmed howto id is absent from the flake [procedure]", async () => {
    await withSession("eden-m47-howto-", SESSION, async (mem, dir) => {
      putFlake(dir);
      const before = packetOf(mem.inject(user(FLAKE_CUE)) as unknown[]);
      expect(before).toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
      expect(before).toMatch(/pytest/i);
      mem.markHarmed([FLAKE_ID]);
      const next = mem.inject(user(FLAKE_CUE));
      const hay = `${packetOf(next as unknown[])}\n${JSON.stringify(next)}`;
      expect(hay).not.toContain(FLAKE_ID);
      expect(hay).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
      expect(hay).not.toContain(PYTEST_CMD);
    });
  });

  test("EDEN_MEMORY=0 and readonly: markHarmed does not persist", async () => {
    const dir = tmpDir("eden-m47-off-");
    try {
      let id = "";
      await withEnv(
        { EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0", EDEN_MEMORY_MIN: undefined },
        () => {
          const mem = openMemory({ dir, session: SESSION });
          mem.observe(user(SQLITE));
          id = idsFor(mem, SQLITE_Q, /sqlite/i)[0]!;
          mem.close();
        },
      );
      const before = harmedRaw(dir);
      for (const value of ["0", "readonly"]) {
        await withEnv(
          {
            EDEN_MEMORY: value,
            EDEN_MEMORY_DIR: dir,
            EDEN_HOME: undefined,
            EDEN_KNOW: "0",
            EDEN_MEMORY_MIN: undefined,
          },
          () => {
            markHarmed(dir, [id]);
            const mem = openMemory({ dir, session: SESSION });
            mem.markHarmed([id]);
            mem.close();
          },
        );
        expect(harmedRaw(dir)).toBe(before);
        expect(loadHarmedIds(dir).has(id)).toBe(false);
      }
      await withEnv(
        { EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0", EDEN_MEMORY_MIN: undefined },
        () => {
          const mem = openMemory({ dir, session: SESSION });
          const hay = packetOf(mem.inject(user(SQLITE_Q)) as unknown[]);
          expect(hay).toContain(MEMORY_MARK);
          expect(hay).toMatch(/sqlite/i);
          mem.close();
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inject throw pass-through; dropHarmed throw and missing dir are not 403; torn file does not throw", async () => {
    await withSession("eden-m47-fail-", SESSION, async (mem, dir) => {
      mem.observe(user(SQLITE));
      const list = user(SQLITE_Q);
      const notesBoom = spyOn(mem, "notesFor").mockImplementation(() => {
        throw new Error("m47 notesFor boom");
      });
      const before = memoryInjectSwallows.n;
      try {
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(out).toBe(list);
        expect(memoryInjectSwallows.n).toBe(before + 1);
        expect(JSON.stringify(out)).not.toMatch(/403/);
        assertNoChrome(JSON.stringify(out));
      } finally {
        notesBoom.mockRestore();
      }

      const dropBoom = spyOn(harmedMod, "dropHarmed").mockImplementation(() => {
        throw new Error("m47 dropHarmed boom");
      });
      try {
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(JSON.stringify(out)).not.toMatch(/403/);
      } finally {
        dropBoom.mockRestore();
      }

      const kept = [{ id: "keep-m47", text: "still here" }];
      expect(() => dropHarmed("", kept)).not.toThrow();
      expect(dropHarmed("", kept)).toEqual(kept);
      expect(JSON.stringify(dropHarmed(join(dir, "missing-m47-dir"), kept))).not.toMatch(/403/);
      expect(loadHarmedIds("")).toEqual(new Set());

      const ids = idsFor(mem, SQLITE_Q, /sqlite/i);
      const tornBody = `${ids.map((id) => JSON.stringify({ id, at: 1 })).join("\n")}\n{torn\n`;
      writeFileSync(harmedPath(dir), tornBody);
      let torn: unknown;
      expect(() => {
        torn = mem.inject(list);
      }).not.toThrow();
      const tornPkt = packetOf(torn as unknown[]);
      expect(JSON.stringify(torn)).not.toMatch(/403/);
      for (const id of ids) expect(tornPkt).not.toContain(id);
      expect(tornPkt).not.toMatch(/sqlite/i);

      writeFileSync(harmedPath(dir), "{not-json");
      expect(() => mem.inject(list)).not.toThrow();
      try {
        chmodSync(harmedPath(dir), 0o000);
      } catch {}
      expect(() => mem.inject(list)).not.toThrow();
      expect(JSON.stringify(mem.inject(list))).not.toMatch(/403/);
    });
  });

  test("injectBody, withKnowFacts, and withKnowFactsAnthropic omit the harmed id", async () => {
    await withSession("eden-m47-wrap-", SESSION, async (mem) => {
      mem.observe(user(SQLITE));
      const marked = new Set(idsFor(mem, SQLITE_Q, /sqlite/i));
      mem.markHarmed(marked);
      const body = { model: "gpt-4o", messages: user(SQLITE_Q) };
      const injected = mem.injectBody(body);
      const bodyPkt = packetOf((injected.messages ?? []) as unknown[]);
      for (const id of marked) expect(bodyPkt).not.toContain(id);
      expect(bodyPkt).not.toMatch(/sqlite/i);
      assertNoChrome(bodyPkt);
      for (const row of mem.notesFor(SQLITE_Q)) if (row.id && /sqlite/i.test(row.text)) marked.add(row.id);
      mem.markHarmed(marked);
      await withProcessMem(mem, () => {
        const know = withKnowFacts({ model: "gpt-4o", messages: user(SQLITE_Q) });
        const knowPkt = packetOf((know.messages ?? []) as unknown[]);
        for (const id of marked) expect(JSON.stringify(know)).not.toContain(id);
        expect(knowPkt).not.toMatch(/sqlite/i);
        assertNoChrome(knowPkt);
        for (const row of mem.notesFor(SQLITE_Q)) if (row.id && /sqlite/i.test(row.text)) marked.add(row.id);
        mem.markHarmed(marked);
        const anth = withKnowFactsAnthropic({ system: "be brief", messages: user(SQLITE_Q) });
        const system = JSON.stringify(anth.system ?? "");
        for (const id of marked) expect(system).not.toContain(id);
        expect(system).not.toMatch(/sqlite/i);
        assertNoChrome(system);
      });
    });
  });

  test("UserPromptSubmit omits the harmed id", async () => {
    await withSession("eden-m47-hook-", SESSION, async (mem) => {
      mem.observe(user(SQLITE));
      const ids = idsFor(mem, SQLITE_Q, /sqlite/i);
      mem.markHarmed(ids);
      await withProcessMem(mem, () => {
        const submit = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION,
          prompt: SQLITE_Q,
        });
        const hay = hookContext(submit);
        for (const id of ids) expect(`${hay}\n${JSON.stringify(submit)}`).not.toContain(id);
        expect(hay).not.toMatch(/sqlite/i);
        assertNoChrome(hay);
      });
    });
  });

  test("no memory_search; harmed.jsonl has no cwd, email, or session_id", async () => {
    const src = readFileSync(HARM_SRC, "utf8");
    expect(src).not.toMatch(/\bmemory_search\b/);
    await withSession("eden-m47-scrub-", SESSION, async (mem, dir) => {
      mem.observe(user(`Kai ${EMAIL} uses sqlite. api_key is ${SECRET}.`));
      const ids = idsFor(mem, SQLITE_Q, /sqlite/i);
      mem.markHarmed([...ids, EMAIL, process.cwd()]);
      const raw = harmedRaw(dir);
      expect(ids.some((id) => raw.includes(id))).toBe(true);
      assertIdsOnly(raw, [EMAIL, SECRET, SESSION, process.cwd(), "session_id", "api_key"]);
    });
  });

  test("sleep does not resurrect the omitted id", async () => {
    await withSession("eden-m47-sleep-", SESSION, async (mem, dir) => {
      mem.observe(user(SQLITE));
      const ids = idsFor(mem, SQLITE_Q, /sqlite/i);
      mem.markHarmed(ids);
      await sleep({ dir, mem, session: SESSION });
      for (const id of ids) expect(loadHarmedIds(dir).has(id)).toBe(true);
      const pkt = packetOf(mem.inject(user(SQLITE_Q)) as unknown[]);
      for (const id of ids) expect(pkt).not.toContain(id);
      expect(pkt).not.toMatch(/sqlite/i);
      assertNoChrome(pkt);
    });
  });

  test("after sleep, SessionStart peels the harmed pin and still briefs the other", async () => {
    await withSession("eden-m47-gist-", SESSION, async (mem) => {
      mem.remember("Always use sqlite.", { kind: "constraint", pin: true });
      mem.remember("Auth is Clerk.", { kind: "constraint", pin: true });
      const ids = idsFor(mem, SQLITE_Q, /sqlite/i);
      await sleep({ dir: mem.dir, mem, session: SESSION });
      mem.markHarmed(ids);
      const mathPkt = packetOf(mem.inject(user("What is 17 times 23?")) as unknown[]);
      expect(mathPkt).toBe("");
      assertNoChrome(mathPkt);
      await withProcessMem(mem, () => {
        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: SESSION });
        const hay = hookContext(start);
        for (const id of ids) expect(`${hay}\n${JSON.stringify(start)}`).not.toContain(id);
        expect(hay).not.toMatch(/sqlite/i);
        expect(hay).toMatch(/Clerk/);
        expect(hay).toContain(MEMORY_MARK);
      });
    });
  });

  test("SessionStart briefing omits a harmed pin id", async () => {
    await withSession("eden-m47-start-", SESSION, async (mem) => {
      mem.remember("Always use sqlite.", { kind: "constraint", pin: true });
      const ids = idsFor(mem, SQLITE_Q, /sqlite/i);
      mem.markHarmed(ids);
      await withProcessMem(mem, () => {
        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: SESSION });
        const hay = hookContext(start);
        for (const id of ids) expect(`${hay}\n${JSON.stringify(start)}`).not.toContain(id);
        expect(hay).not.toMatch(/sqlite/i);
      });
    });
  });
});
