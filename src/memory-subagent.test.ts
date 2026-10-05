/**
 * M45.3: subagent share isolation.
 * Child reads root semantic/gist. Episodes stay under parent--child.
 * Child “forget X” does not tombstone root. Parent forget still does.
 * “don’t forget …” is still not a tombstone.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { HowToStore } from "./howto-store";
import { childSessionName, MEMORY_MARK, memoryInjectSwallows, openMemory } from "./index";
import { SemanticStore } from "./semantic-store";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/64

const INDEX = join(import.meta.dir, "index.ts");
const KNOW = join(import.meta.dir, "../packages/wrap/src/know-inject.ts");

const PARENT = "parent";
const AGENT = "agent-1";
const CHILD = `${PARENT}--${AGENT}`;
const DB_CUE = "what database do we use";
const SQLITE = "The database is sqlite.";
const CLERK = "Auth is Clerk.";
const USE_PG = "Use postgres.";
const USE_SQLITE = "Use sqlite.";
const FORGET_PG = "forget postgres";
const DONT_FORGET = "don't forget to run tests";
const CHILD_CHATTER = "We shipped the m45child widget.";
const SUB_NOTE = "We shipped the m45sub stop note.";
const AGENT_NOTE = "We shipped the m45agent9 stop note.";
const FACT_OR_GIST = /\[(?:fact|gist)(?:\s*[·|][^\]]*)?\]/i;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "eden-m45-"));
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
  EDEN_MEMORY_PARENT: undefined,
  EDEN_MEMORY_SESSION: undefined,
  EDEN_MEMORY_CHILD: undefined,
  EDEN_MEMORY_AGENT: undefined,
  EDEN_MEMORY_PROJECT: undefined,
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

function parentStop(messages: { role: string; content: string }[]): void {
  memoryHookResponse({
    hook_event_name: "Stop",
    session_id: PARENT,
    messages,
  });
}

function childSubmit(prompt: string, messages?: { role: string; content: string }[]): Record<string, unknown> | null {
  return memoryHookResponse({
    hook_event_name: "UserPromptSubmit",
    session_id: PARENT,
    agent_id: AGENT,
    prompt,
    ...(messages ? { messages } : {}),
  });
}

function parentInject(): string {
  const raw = memoryHookResponse({
    hook_event_name: "UserPromptSubmit",
    session_id: PARENT,
    prompt: DB_CUE,
  });
  return hookContext(raw);
}

function liveObjects(dir: string): string[] {
  return new SemanticStore(dir).live().map((row) => row.o);
}

describe("M45 subagent share", () => {
  test("childSessionName suffixes with --", () => {
    expect(childSessionName(PARENT, AGENT)).toBe(CHILD);
    expect(childSessionName("s-parent")).toBe("s-parent");
  });

  test.failing(
    "parent Stop sqlite+Clerk: child injects sqlite [fact]/[gist]; episodes stay on parent--agent-1",
    async () => {
      const dir = tmpDir();
      try {
        await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, () => {
          parentStop([
            { role: "user", content: SQLITE },
            { role: "user", content: CLERK },
          ]);
          const db = childSubmit(DB_CUE, [{ role: "user", content: CHILD_CHATTER }]);
          const dbCtx = hookContext(db);
          expect(dbCtx).toContain(MEMORY_MARK);
          expect(dbCtx).toMatch(/sqlite/i);
          expect(dbCtx).toMatch(FACT_OR_GIST);

          memoryHookResponse({
            hook_event_name: "SubagentStop",
            session_id: "s-parent",
            messages: [{ role: "user", content: SUB_NOTE }],
          });
          memoryHookResponse({
            hook_event_name: "SubagentStop",
            session_id: "s-parent",
            agent_id: "agent-9",
            messages: [{ role: "user", content: AGENT_NOTE }],
          });
        });

        const childJsonl = join(dir, CHILD, "memories.jsonl");
        expect(existsSync(childJsonl)).toBe(true);
        expect(readFileSync(childJsonl, "utf8")).toContain("m45child widget");

        const parentJsonl = join(dir, PARENT, "memories.jsonl");
        expect(existsSync(parentJsonl)).toBe(true);
        const parentText = readFileSync(parentJsonl, "utf8");
        expect(parentText).not.toContain(CHILD_CHATTER);
        expect(parentText).toMatch(/sqlite/i);

        expect(existsSync(join(dir, "memories.jsonl"))).toBe(false);
        expect(existsSync(join(dir, "semantic.jsonl"))).toBe(true);
        expect(readFileSync(join(dir, "semantic.jsonl"), "utf8")).toMatch(/sqlite/i);
        expect(existsSync(join(dir, CHILD, "semantic.jsonl"))).toBe(false);
        expect(existsSync(join(dir, CHILD, "gists.jsonl"))).toBe(false);
        expect(existsSync(join(dir, "s-parent--sub", "memories.jsonl"))).toBe(true);
        expect(existsSync(join(dir, "s-parent--agent-9", "memories.jsonl"))).toBe(true);
        expect(readFileSync(join(dir, PARENT, "memories.jsonl"), "utf8")).not.toContain("m45sub");
        expect(readFileSync(join(dir, PARENT, "memories.jsonl"), "utf8")).not.toContain("m45agent9");
        expect(readFileSync(join(dir, "s-parent--sub", "memories.jsonl"), "utf8")).toContain("m45sub");
        expect(readFileSync(join(dir, "s-parent--agent-9", "memories.jsonl"), "utf8")).toContain("m45agent9");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.failing("child forget postgres does not tombstone root sqlite", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, () => {
        parentStop([
          { role: "user", content: USE_PG },
          { role: "user", content: USE_SQLITE },
        ]);
        const before = parentInject();
        expect(before).toMatch(/sqlite/i);
        expect(liveObjects(dir).some((o) => /sqlite/i.test(o))).toBe(true);

        childSubmit(FORGET_PG, [
          { role: "user", content: FORGET_PG },
          { role: "user", content: CHILD_CHATTER },
        ]);

        const after = parentInject();
        expect(after).toContain(MEMORY_MARK);
        expect(after).toMatch(/sqlite/i);
        expect(liveObjects(dir).some((o) => /sqlite/i.test(o))).toBe(true);
        expect(liveObjects(dir).some((o) => /postgres/i.test(o))).toBe(false);
      });
      const parentText = readFileSync(join(dir, PARENT, "memories.jsonl"), "utf8");
      expect(parentText).not.toMatch(/forget postgres/i);
      expect(parentText).not.toContain("m45child");
      const childJsonl = join(dir, CHILD, "memories.jsonl");
      expect(existsSync(childJsonl)).toBe(true);
      expect(readFileSync(childJsonl, "utf8")).toContain("m45child");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing("parent transcript already forgot postgres: child forget does not resurrect it", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, () => {
        parentStop([
          { role: "user", content: USE_PG },
          { role: "user", content: SQLITE },
        ]);
        expect(liveObjects(dir).some((o) => /postgres/i.test(o))).toBe(true);
        expect(liveObjects(dir).some((o) => /sqlite/i.test(o))).toBe(true);

        memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: PARENT,
          prompt: FORGET_PG,
          messages: [{ role: "user", content: FORGET_PG }],
        });
        expect(liveObjects(dir).some((o) => /postgres/i.test(o))).toBe(false);
        expect(liveObjects(dir).some((o) => /sqlite/i.test(o))).toBe(true);

        childSubmit(FORGET_PG, [{ role: "user", content: FORGET_PG }]);

        expect(liveObjects(dir).some((o) => /postgres/i.test(o))).toBe(false);
        expect(liveObjects(dir).some((o) => /sqlite/i.test(o))).toBe(true);
        const parent = openMemory({ dir, session: PARENT });
        const after = packet(parent.inject([{ role: "user", content: DB_CUE }]));
        parent.close();
        expect(after).toMatch(/sqlite/i);
        expect(after).not.toMatch(/postgres/i);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing("child don't forget to run tests does not tombstone sqlite", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, () => {
        parentStop([
          { role: "user", content: USE_PG },
          { role: "user", content: USE_SQLITE },
        ]);
        childSubmit(DONT_FORGET, [{ role: "user", content: DONT_FORGET }]);
        const after = parentInject();
        expect(after).toContain(MEMORY_MARK);
        expect(after).toMatch(/sqlite/i);
        expect(liveObjects(dir).some((o) => /sqlite/i.test(o))).toBe(true);
      });
      expect(readFileSync(join(dir, CHILD, "memories.jsonl"), "utf8")).toMatch(/don't forget to run tests/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing("wrap child openMemory injects parent sqlite; inject throw is pass-through", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, async () => {
        const parent = openMemory({ dir, session: "wrap-a" });
        parent.observe([
          { role: "user", content: USE_PG },
          { role: "user", content: SQLITE },
        ]);
        await parent.sleep({ session: "wrap-a" });
        parent.close();

        const session = childSessionName("wrap-a", "child-1");
        expect(session).toBe("wrap-a--child-1");
        const child = openMemory({ dir, session, child: true });
        expect(child.child).toBe(true);
        const pkt = packet(child.inject([{ role: "user", content: DB_CUE }]));
        expect(pkt).toContain(MEMORY_MARK);
        expect(pkt).toMatch(/sqlite/i);
        expect(pkt).toMatch(FACT_OR_GIST);
        expect(existsSync(join(dir, "wrap-a--child-1", "semantic.jsonl"))).toBe(false);
        expect(existsSync(join(dir, "semantic.jsonl"))).toBe(true);

        const list = [{ role: "user", content: DB_CUE }];
        const before = memoryInjectSwallows.n;
        child.notesFor = (() => {
          throw new Error("m45 inject notesFor");
        }) as typeof child.notesFor;
        let out: unknown;
        expect(() => {
          out = child.inject(list);
        }).not.toThrow();
        expect(out).toBe(list);
        expect(memoryInjectSwallows.n).toBe(before + 1);
        child.close();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing(
    "wrap processMemory EDEN_MEMORY_CHILD injects parent sqlite from a subprocess",
    async () => {
      const dir = tmpDir();
      const cwd = process.cwd();
      const src = `
      import { processMemory } from ${JSON.stringify(INDEX)};
      const mem = processMemory();
      const out = mem.inject([{ role: "user", content: ${JSON.stringify(DB_CUE)} }]);
      process.stdout.write(JSON.stringify({ child: mem.child, session: mem.session, packet: out }));
      mem.close();
    `;
      try {
        const parent = openMemory({ dir, session: "wrap-a" });
        parent.observe([{ role: "user", content: SQLITE }]);
        await parent.sleep({ session: "wrap-a" });
        parent.close();

        const env: Record<string, string | undefined> = {
          ...process.env,
          EDEN_MEMORY: "on",
          EDEN_MEMORY_DIR: dir,
          EDEN_KNOW: "0",
          EDEN_SLEEP_EVERY: "0",
          EDEN_SLEEP_IDLE: "0",
          EDEN_MEMORY_PARENT: "wrap-a",
          EDEN_MEMORY_CHILD: "child-1",
        };
        delete env.EDEN_HOME;
        delete env.EDEN_MEMORY_MIN;
        delete env.EDEN_MEMORY_SESSION;
        const proc = Bun.spawn(["bun", "-e", src], { cwd, env, stdout: "pipe", stderr: "pipe" });
        const code = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        if (code !== 0) {
          throw new Error(`wrap child ${code}: ${await new Response(proc.stderr).text()}\n${stdout}`);
        }
        const parsed = JSON.parse(stdout) as { child?: boolean; session?: string; packet?: unknown };
        expect(parsed.child).toBe(true);
        expect(parsed.session).toBe("wrap-a--child-1");
        expect(JSON.stringify(parsed.packet)).toContain(MEMORY_MARK);
        expect(JSON.stringify(parsed.packet)).toMatch(/sqlite/i);
        expect(existsSync(join(dir, "wrap-a--child-1", "semantic.jsonl"))).toBe(false);
        expect(existsSync(join(dir, "semantic.jsonl"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test("EDEN_MEMORY_PARENT alone does not suffix a parent Submit into parent--sub", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir, EDEN_MEMORY_PARENT: PARENT }, () => {
        parentStop([{ role: "user", content: SQLITE }]);
        const hit = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: PARENT,
          prompt: DB_CUE,
        });
        expect(hookContext(hit)).toMatch(/sqlite/i);
      });
      expect(existsSync(join(dir, PARENT, "memories.jsonl"))).toBe(true);
      expect(existsSync(join(dir, `${PARENT}--sub`, "memories.jsonl"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing("parent session foo--bar forgets sqlite; child:true on that name does not tombstone root", async () => {
    const dir = tmpDir();
    try {
      const parent = openMemory({ dir, session: "foo--bar" });
      expect(parent.child).toBe(false);
      parent.observe([{ role: "user", content: SQLITE }]);
      await parent.sleep({ session: "foo--bar" });
      parent.close();
      expect(liveObjects(dir).some((o) => /sqlite/i.test(o))).toBe(true);

      const named = openMemory({ dir, session: "foo--bar" });
      expect(named.child).toBe(false);
      named.observe([{ role: "user", content: "forget sqlite" }]);
      named.close();
      expect(liveObjects(dir).some((o) => /sqlite/i.test(o))).toBe(false);

      const again = openMemory({ dir, session: "foo--bar" });
      again.observe([{ role: "user", content: SQLITE }]);
      await again.sleep({ session: "foo--bar" });
      again.close();
      expect(liveObjects(dir).some((o) => /sqlite/i.test(o))).toBe(true);

      const child = openMemory({ dir, session: "foo--bar", child: true });
      expect(child.child).toBe(true);
      child.observe([{ role: "user", content: "forget sqlite" }]);
      child.close();
      expect(liveObjects(dir).some((o) => /sqlite/i.test(o))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two batched semantic writers keep both parent facts", () => {
    const dir = tmpDir();
    try {
      const a = new SemanticStore(dir);
      const b = new SemanticStore(dir);
      a.beginBatch();
      b.beginBatch();
      a.put("database", "is", "sqlite", 10);
      b.put("auth", "is", "Clerk", 11);
      a.endBatch();
      b.endBatch();
      const live = new SemanticStore(dir).live().map((row) => row.o);
      expect(live.some((o) => /sqlite/i.test(o))).toBe(true);
      expect(live.some((o) => /clerk/i.test(o))).toBe(true);
      const raw = readFileSync(join(dir, "semantic.jsonl"), "utf8");
      for (const line of raw.split("\n")) {
        if (!line) continue;
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two howto writers keep both exit-0 rows", () => {
    const dir = tmpDir();
    try {
      const a = new HowToStore(dir);
      const b = new HowToStore(dir);
      const left = a.put({
        cue: "auth pytest flake",
        steps: [{ name: "Bash", exit: 0 }],
        files: ["auth.ts"],
        exit: 0,
        t: 1,
      });
      const right = b.put({
        cue: "lint the api",
        steps: [{ name: "Bash", exit: 0 }],
        files: ["api.ts"],
        exit: 0,
        t: 2,
      });
      expect(left?.id).toBeTruthy();
      expect(right?.id).toBeTruthy();
      const ids = new HowToStore(dir).latest("auth api lint pytest", 10).map((r) => r.id);
      expect(ids).toContain(left!.id);
      expect(ids).toContain(right!.id);
      const raw = readFileSync(join(dir, "howto.jsonl"), "utf8");
      for (const line of raw.split("\n")) {
        if (!line) continue;
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("chat-only child injects no [procedure]", async () => {
    const dir = tmpDir();
    try {
      const child = openMemory({ dir, session: CHILD, child: true });
      child.observe([{ role: "user", content: CHILD_CHATTER }]);
      await child.sleep({ session: CHILD });
      const pkt = packet(child.inject([{ role: "user", content: "how do I fix the auth flake" }]));
      expect(pkt).not.toMatch(/\[procedure(?:\s*[·|][^\]]*)?\]/i);
      expect(existsSync(join(dir, "howto.jsonl"))).toBe(false);
      child.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SessionStart briefs the pin; child math cue stays silent", async () => {
    const dir = tmpDir();
    try {
      await withEnv({ ...QUIET, EDEN_MEMORY_DIR: dir }, () => {
        parentStop([
          { role: "user", content: "always use sqlite" },
          { role: "user", content: SQLITE },
        ]);
        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: PARENT });
        expect(hookContext(start)).toMatch(/sqlite/i);
        expect(JSON.stringify(start ?? {})).not.toMatch(/\b(?:verify|unknown): /);
        const math = childSubmit("what is 2 + 2");
        expect(hookContext(math)).not.toContain(MEMORY_MARK);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("child observe redacts secrets and does not store session or email", async () => {
    const dir = tmpDir();
    const secret = "sk-m45childsecretkeyvalue";
    try {
      const child = openMemory({ dir, session: CHILD, child: true, cwd: "/tmp/eden-m45-cwd" });
      child.observe([
        {
          role: "user",
          content: `The token is ${secret}. Mail me at ada@example.com about session ${CHILD}.`,
        },
      ]);
      child.close();
      const text = readFileSync(join(dir, CHILD, "memories.jsonl"), "utf8");
      expect(text).not.toContain(secret);
      expect(text).toMatch(/REDACTED/i);
      expect(text).not.toContain("ada@example.com");
      expect(text).not.toContain(CHILD);
      expect(text).not.toContain("/tmp/eden-m45-cwd");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing("torn semantic.jsonl is skipped and child inject still returns parent sqlite", async () => {
    const dir = tmpDir();
    try {
      const parent = openMemory({ dir, session: PARENT });
      parent.observe([{ role: "user", content: SQLITE }]);
      await parent.sleep({ session: PARENT });
      parent.close();
      const { appendFileSync } = await import("node:fs");
      appendFileSync(join(dir, "semantic.jsonl"), '{"s":"stack"\n');
      const child = openMemory({ dir, session: CHILD, child: true });
      let out: unknown;
      expect(() => {
        out = child.inject([{ role: "user", content: DB_CUE }]);
      }).not.toThrow();
      expect(packet(out as unknown[])).toMatch(/sqlite/i);
      child.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing(
    "wrap injectBody and Anthropic child env inject parent sqlite and fail open",
    async () => {
      const dir = tmpDir();
      const cwd = process.cwd();
      const src = `
      import { processMemory } from ${JSON.stringify(INDEX)};
      import { withKnowFactsAnthropic } from ${JSON.stringify(KNOW)};
      const mem = processMemory();
      const cue = ${JSON.stringify(DB_CUE)};
      const body = mem.injectBody({ model: "gpt-4o", messages: [{ role: "user", content: cue }] });
      const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: cue }] });
      const list = [{ role: "user", content: cue }];
      mem.notesFor = () => { throw new Error("m45 wrap notesFor"); };
      let pass = "threw";
      try { pass = mem.injectBody({ messages: list }); } catch { pass = "threw"; }
      let anthPass = "threw";
      try { anthPass = withKnowFactsAnthropic({ messages: list }); } catch { anthPass = "threw"; }
      process.stdout.write(JSON.stringify({ child: mem.child, session: mem.session, body, anth, pass, anthPass }));
      mem.close();
    `;
      try {
        const parent = openMemory({ dir, session: "wrap-a" });
        parent.observe([{ role: "user", content: SQLITE }]);
        await parent.sleep({ session: "wrap-a" });
        parent.close();
        const env: Record<string, string | undefined> = {
          ...process.env,
          EDEN_MEMORY: "on",
          EDEN_MEMORY_DIR: dir,
          EDEN_KNOW: "0",
          EDEN_SLEEP_EVERY: "0",
          EDEN_SLEEP_IDLE: "0",
          EDEN_MEMORY_PARENT: "wrap-a",
          EDEN_MEMORY_CHILD: "child-1",
        };
        delete env.EDEN_HOME;
        delete env.EDEN_MEMORY_MIN;
        delete env.EDEN_MEMORY_SESSION;
        const proc = Bun.spawn(["bun", "-e", src], { cwd, env, stdout: "pipe", stderr: "pipe" });
        const code = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        if (code !== 0) throw new Error(`wrap surfaces ${code}: ${await new Response(proc.stderr).text()}\n${stdout}`);
        const parsed = JSON.parse(stdout) as {
          child?: boolean;
          session?: string;
          body?: unknown;
          anth?: unknown;
          pass?: unknown;
          anthPass?: unknown;
        };
        expect(parsed.child).toBe(true);
        expect(parsed.session).toBe("wrap-a--child-1");
        expect(JSON.stringify(parsed.body)).toMatch(/sqlite/i);
        expect(JSON.stringify(parsed.anth)).toMatch(/sqlite/i);
        expect(parsed.pass).toEqual({ messages: [{ role: "user", content: DB_CUE }] });
        expect(JSON.stringify(parsed.anthPass)).not.toContain(MEMORY_MARK);
        expect(existsSync(join(dir, "wrap-a--child-1", "semantic.jsonl"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
