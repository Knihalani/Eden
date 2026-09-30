/**
 * M25.4 Experience sleep tests. Pins M25.1 replay, M25.2 procedure from success,
 * dead-end stays episodic, M25.4 corrupt fail-open, consent, identifier scrub.
 * D owns product; this file only asserts the locked API.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { injectBodyThenObserveTools, observeToolTraces } from "../packages/wrap/src/tool-observe";
import {
  EXPERIENCE_DIRNAME,
  ExperienceStore,
  putExperience,
  putExperienceFromTool,
  type ExperienceState,
  type ExperienceTraj,
} from "./experience-store";
import * as experienceStore from "./experience-store";
import { GistStore } from "./gist-store";
import { HowToStore } from "./howto-store";
import { AgentMemory, MEMORY_MARK, memoryInjectSwallows, openMemory, sleep } from "./index";
import * as edenMem from "./index";
import * as sleepMod from "./sleep";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/47

const GOLD_REPLAY = "UNIQUE_M25_GOLD_PHRASE_REPLAY";
const GOLD_OK = "UNIQUE_M25_GOLD_PHRASE_SUCCESS";
const GOLD_DEAD = "UNIQUE_M25_GOLD_PHRASE_DEADEND";
const GOLD_CORRUPT = "UNIQUE_M25_GOLD_PHRASE_CORRUPT";
const VERIFY_OK = "bun test src/auth.test.ts";
const VERIFY_DEAD = "bun test src/deadend-m25.test.ts";
const EMAIL = "kai-m25@example.com";
const SESSION = "sess-m25-very-long-session-id";
const FAKE_CWD = "/tmp/eden-m25-unique-cwd";
const SQLITE_CHAT = "What's 2+2? Use sqlite in this project.";
const HOST_FILES = [
  join(import.meta.dir, "../packages/wrap/src/know-inject.ts"),
  join(import.meta.dir, "../packages/wrap/src/tool-observe.ts"),
  join(import.meta.dir, "../packages/cli/src/memory-hook.ts"),
  join(import.meta.dir, "../packages/cli/src/setup.ts"),
  join(import.meta.dir, "../packages/cli/src/doctor.ts"),
];

type ExtraState = ExperienceState & {
  exit?: number;
  verify?: string;
  files?: string[];
  goal?: string;
  outcome?: string;
};

type ExtraTraj = ExperienceTraj & {
  exit?: number;
  verify?: string;
  files?: string[];
  goal?: string;
  outcome?: string;
  states: ExtraState[];
};

function tmpDir(prefix = "eden-m25-"): string {
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
  cwd?: string,
): Promise<T> {
  const dir = tmpDir(prefix);
  return withEnv({ EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_MEMORY: "on" }, async () => {
    try {
      const mem = openMemory({ dir, session, cwd });
      return await fn(mem, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

function fileHay(paths: string[]): string {
  const chunks: string[] = [];
  for (const p of paths) {
    try {
      chunks.push(readFileSync(p, "utf8"));
    } catch {}
  }
  return chunks.join("\n");
}

function experienceDir(root: string): string {
  return join(root, EXPERIENCE_DIRNAME);
}

function trajPath(root: string, id: string): string {
  return join(experienceDir(root), `${id}.jsonl`);
}

function experienceHay(root: string): string {
  return fileHay(walkFiles(experienceDir(root)).filter((p) => !p.endsWith(".lock")));
}

function howtoPath(root: string): string {
  return join(root, "howto.jsonl");
}

function howtoHay(root: string): string {
  const p = howtoPath(root);
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  } catch {
    return "";
  }
}

function howtoEmpty(root: string): boolean {
  return !howtoHay(root).trim();
}

function gistTexts(root: string): string[] {
  return new GistStore(root).latest("", 20).map((g) => g.text);
}

function gistHay(root: string): string {
  return gistTexts(root).join("\n");
}

function packetOf(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m === "object" ? (m as { role?: string; content?: unknown }) : {}))
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

/**
 * Disk fixture in ExperienceStore jsonl shape.
 * Extra keys (exit/verify/files/goal/outcome) stay on disk for D's sleep pass.
 */
function writeTraj(dir: string, traj: ExtraTraj): string {
  const exp = experienceDir(dir);
  mkdirSync(exp, { recursive: true });
  const path = trajPath(dir, traj.id);
  const meta: Record<string, unknown> = { id: traj.id };
  if (traj.session) meta.session = traj.session;
  if (typeof traj.goal === "string") meta.goal = traj.goal;
  if (typeof traj.outcome === "string") meta.outcome = traj.outcome;
  if (typeof traj.exit === "number") meta.exit = traj.exit;
  if (typeof traj.verify === "string") meta.verify = traj.verify;
  if (traj.files?.length) meta.files = traj.files;
  const lines = [JSON.stringify(meta), ...traj.states.map((s) => JSON.stringify(s))];
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

function seedTraj(dir: string, traj: ExtraTraj): string {
  putExperience(dir, {
    id: traj.id,
    session: traj.session,
    cwd: traj.cwd,
    states: traj.states.map((s) => ({
      url: s.url,
      action: s.action,
      thought: s.thought,
      tree: s.tree,
      t: s.t,
    })),
  });
  return writeTraj(dir, traj);
}

/** Sleep only — never mint how-to in the test helper (that hid a missing sleep call). */
async function sleepReplay(mem: AgentMemory, dir: string, _traj?: ExtraTraj, session?: string): Promise<void> {
  await sleep({ dir, mem, session });
}

function pytestWindow(): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_pytest_m25",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: "pytest tests/auth/session.test.ts -q" }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_pytest_m25", content: "collected 1 item\nauth.ts touched\nexit 0" },
  ];
}

function anthropicPytestWindow(): unknown[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu_py_m25", name: "Bash", input: { command: "pytest tests/auth/session.test.ts -q" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_py_m25", content: "collected 1 item\nauth.ts touched\nexit 0" },
      ],
    },
  ];
}

function experienceJsonlFiles(root: string): string[] {
  return walkFiles(experienceDir(root)).filter((p) => p.endsWith(".jsonl") && !p.endsWith(".lock"));
}

describe("M25.1 Replay files — experience jsonl remains; gist from goal/outcome", () => {
  test("sleep keeps the traj file and gists the unique goal/outcome marker", async () => {
    const session = "s-m25-replay";
    await withMem(
      "eden-m25-replay-",
      async (mem, dir) => {
        const id = "traj-m25-replay";
        const goal = `Goal: ship ${GOLD_REPLAY} to staging`;
        const outcome = `Outcome: ${GOLD_REPLAY} deployed`;
        const path = seedTraj(dir, {
          id,
          session,
          states: [
            {
              thought: goal,
              action: outcome,
              goal,
              outcome,
              t: 1,
            },
          ],
          goal,
          outcome,
        });
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, "utf8")).toContain(GOLD_REPLAY);

        await sleepReplay(mem, dir, undefined, session);

        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, "utf8")).toContain(GOLD_REPLAY);
        expect(experienceHay(dir)).toContain(GOLD_REPLAY);
        const got = new ExperienceStore(dir).get(id);
        expect(got).toBeTruthy();
        expect(JSON.stringify(got)).toContain(GOLD_REPLAY);

        const gists = gistTexts(dir);
        expect(gists.length).toBeGreaterThan(0);
        const hay = gistHay(dir);
        expect(hay.length).toBeGreaterThan(0);
        expect(hay).toContain(GOLD_REPLAY);
      },
      session,
    );
  });
});

describe("M25.2 Procedure from success — exit 0 + verify becomes how-to; chat-only zero", () => {
  test("exit 0 + verify + files: after sleep, HowToStore has that verify", async () => {
    const session = "s-m25-ok";
    await withMem(
      "eden-m25-ok-",
      async (mem, dir) => {
        const traj: ExtraTraj = {
          id: "traj-m25-ok",
          session,
          states: [
            {
              thought: `fix auth login ${GOLD_OK}`,
              action: "wrote src/auth.ts then verified",
              goal: `fix auth ${GOLD_OK}`,
              outcome: `${GOLD_OK} tests passed`,
              exit: 0,
              verify: VERIFY_OK,
              files: ["src/auth.ts", "src/auth.test.ts"],
              t: 2,
            },
          ],
          exit: 0,
          verify: VERIFY_OK,
          files: ["src/auth.ts", "src/auth.test.ts"],
          goal: `fix auth ${GOLD_OK}`,
          outcome: `${GOLD_OK} tests passed`,
        };
        seedTraj(dir, traj);
        await sleepReplay(mem, dir, traj, session);

        expect(howtoEmpty(dir)).toBe(false);
        expect(howtoHay(dir)).toContain(VERIFY_OK);
        const rows = new HowToStore(dir).latest(VERIFY_OK, 10);
        expect(rows.length).toBeGreaterThan(0);
        expect(
          rows.some(
            (r) =>
              String(r.verify ?? "").includes(VERIFY_OK) || `${r.cue} ${JSON.stringify(r.steps)}`.includes(VERIFY_OK),
          ),
        ).toBe(true);
      },
      session,
    );
  });

  test("chat-only observe then sleep: zero how-to (howto.jsonl missing or empty)", async () => {
    await withMem("eden-m25-chat-", async (mem, dir) => {
      expect(() => {
        mem.observe([{ role: "user", content: SQLITE_CHAT }]);
      }).not.toThrow();
      expect(new ExperienceStore(dir).ids()).toEqual([]);
      await sleep({ dir, mem });
      expect(howtoEmpty(dir)).toBe(true);
      expect(new HowToStore(dir).latest("sqlite", 5)).toEqual([]);
      expect(new HowToStore(dir).latest(VERIFY_OK, 5)).toEqual([]);
    });
  });
});

describe("M25.2 Dead-end stays episodic — exit ≠ 0 does not mint a procedure", () => {
  test("exit 1 + verify: experience file remains; HowToStore does not contain that verify", async () => {
    const session = "s-m25-dead";
    await withMem(
      "eden-m25-dead-",
      async (mem, dir) => {
        const traj: ExtraTraj = {
          id: "traj-m25-dead",
          session,
          states: [
            {
              thought: `try auth patch ${GOLD_DEAD}`,
              action: "tests failed",
              goal: `fix auth ${GOLD_DEAD}`,
              outcome: `${GOLD_DEAD} still failing`,
              exit: 1,
              verify: VERIFY_DEAD,
              files: ["src/auth.ts"],
              t: 3,
            },
          ],
          exit: 1,
          verify: VERIFY_DEAD,
          files: ["src/auth.ts"],
        };
        const path = seedTraj(dir, traj);
        await sleepReplay(mem, dir, traj, session);

        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, "utf8")).toContain(GOLD_DEAD);
        expect(experienceHay(dir)).toContain(VERIFY_DEAD);
        expect(howtoHay(dir)).not.toContain(VERIFY_DEAD);
        const rows = new HowToStore(dir).latest(VERIFY_DEAD, 10);
        expect(rows.some((r) => String(r.verify ?? "").includes(VERIFY_DEAD))).toBe(false);
      },
      session,
    );
  });
});

describe("M25.4 Corrupt file fail-open — torn jsonl does not throw out of sleep", () => {
  test("good traj + experience/bad.jsonl torn JSON: sleep does not throw; inject returns array; good gist appears", async () => {
    const session = "s-m25-corrupt";
    await withMem(
      "eden-m25-corrupt-",
      async (mem, dir) => {
        const id = "traj-m25-good";
        const goal = `Goal: recover ${GOLD_CORRUPT}`;
        const outcome = `Outcome: ${GOLD_CORRUPT} kept`;
        const goodPath = seedTraj(dir, {
          id,
          session,
          states: [{ thought: goal, action: outcome, goal, outcome, t: 4 }],
          goal,
          outcome,
        });
        mkdirSync(experienceDir(dir), { recursive: true });
        writeFileSync(join(experienceDir(dir), "bad.jsonl"), "{{{not-json\n");

        let threw = false;
        try {
          await sleep({ dir, mem, session });
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
        expect(existsSync(goodPath)).toBe(true);
        expect(readFileSync(goodPath, "utf8")).toContain(GOLD_CORRUPT);
        expect(existsSync(join(experienceDir(dir), "bad.jsonl"))).toBe(true);

        const gists = gistTexts(dir);
        expect(gists.length).toBeGreaterThan(0);
        expect(gistHay(dir)).toContain(GOLD_CORRUPT);

        const before = memoryInjectSwallows.n;
        const list = [{ role: "user", content: `what happened to ${GOLD_CORRUPT}` }];
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
        expect(memoryInjectSwallows.n).toBe(before);
      },
      session,
    );
  });

  test("inject catch still pass-through if sleep internals throw; swallows unchanged", async () => {
    await withMem("eden-m25-inject-spy-", async (mem) => {
      mem.remember("Auth is Clerk");
      const list = [{ role: "user", content: "what is auth" }];
      const before = memoryInjectSwallows.n;
      const consSpy = spyOn(sleepMod, "consolidate").mockImplementation(() => {
        throw new Error("m25 consolidate boom");
      });
      const sleepSpy = spyOn(sleepMod, "sleep").mockImplementation(async () => {
        throw new Error("m25 sleep boom");
      });
      const memSleep = spyOn(AgentMemory.prototype, "sleep").mockImplementation(async () => {
        throw new Error("m25 AgentMemory.sleep boom");
      });
      try {
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
        expect(packetOf(out as unknown[])).toMatch(/Clerk/);
        expect(memoryInjectSwallows.n).toBe(before);
        expect(consSpy).not.toHaveBeenCalled();
        expect(sleepSpy).not.toHaveBeenCalled();
        expect(memSleep).not.toHaveBeenCalled();
      } finally {
        consSpy.mockRestore();
        sleepSpy.mockRestore();
        memSleep.mockRestore();
      }
    });
  });
});

describe("M25 locks — consent, identifiers, no memory_search, chat observe independent", () => {
  test("wrap/hook/setup/doctor still have 0 memory_search", () => {
    for (const p of HOST_FILES) {
      const src = readFileSync(p, "utf8");
      expect(src, p).not.toMatch(/\bmemory_search\b/);
      expect(src, p).not.toMatch(/\bBrainMemory\b/);
    }
  });

  test("chat observe still does not require ExperienceStore", async () => {
    await withMem("eden-m25-chat-obs-", (mem, dir) => {
      expect(() => {
        mem.observe([{ role: "user", content: SQLITE_CHAT }]);
      }).not.toThrow();
      expect(walkFiles(experienceDir(dir)).filter((p) => !p.endsWith(".lock")).length).toBe(0);
      expect(new ExperienceStore(dir).ids()).toEqual([]);
    });
  });

  test("EDEN_MEMORY=0 sleep is no-op (consent)", async () => {
    const session = "s-m25-off";
    await withMem(
      "eden-m25-off-",
      async (mem, dir) => {
        const id = "traj-m25-off";
        const path = seedTraj(dir, {
          id,
          session,
          states: [
            {
              thought: `Goal: ${GOLD_REPLAY} while consent on`,
              action: `Outcome: ${GOLD_REPLAY} parked`,
              t: 5,
            },
          ],
        });
        expect(existsSync(path)).toBe(true);
        await withEnv({ EDEN_MEMORY: "0" }, async () => {
          await sleep({ dir, mem, session });
        });
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, "utf8")).toContain(GOLD_REPLAY);
        expect(gistHay(dir)).not.toContain(GOLD_REPLAY);
        expect(howtoEmpty(dir)).toBe(true);
      },
      session,
    );
  });

  test("EDEN_MEMORY=readonly sleep writes no experience gist/how-to", async () => {
    const session = "s-m25-ro";
    await withMem(
      "eden-m25-ro-",
      async (mem, dir) => {
        const path = seedTraj(dir, {
          id: "traj-m25-ro",
          session,
          states: [
            {
              thought: `Goal: ${GOLD_REPLAY} parked readonly`,
              action: `Outcome: ${GOLD_REPLAY} still episodic`,
              exit: 0,
              verify: VERIFY_OK,
              t: 7,
            },
          ],
          exit: 0,
          verify: VERIFY_OK,
        });
        await withEnv({ EDEN_MEMORY: "readonly" }, async () => {
          await sleep({ dir, mem, session });
          putExperienceFromTool(dir, {
            name: "Bash",
            args: { command: VERIFY_OK },
            result: "exit 0",
          });
        });
        expect(existsSync(path)).toBe(true);
        expect(gistHay(dir)).not.toContain(GOLD_REPLAY);
        expect(howtoHay(dir)).not.toContain(VERIFY_OK);
        expect(new ExperienceStore(dir).ids()).toEqual(["traj-m25-ro"]);
      },
      session,
    );
  });

  test("identifiers (cwd/email/session_id) are not in gist/howto after sleep", async () => {
    await withMem(
      "eden-m25-ids-",
      async (mem, dir) => {
        putExperience(dir, {
          id: "traj-m25-ids",
          session: SESSION,
          cwd: FAKE_CWD,
          states: [
            {
              thought: `goal for ${EMAIL} session ${SESSION} cwd ${FAKE_CWD} ${GOLD_OK}`,
              action: `outcome ${EMAIL} ${GOLD_OK}`,
              t: 6,
            },
          ],
        });
        await sleep({ dir, mem, session: SESSION });
        const hay = `${gistHay(dir)}\n${howtoHay(dir)}\n${experienceHay(dir)}`;
        expect(hay).not.toContain(EMAIL);
        expect(hay).not.toContain(SESSION);
        expect(hay).not.toContain(FAKE_CWD);
      },
      SESSION,
      FAKE_CWD,
    );
  });
});

describe("M25 named promoteExperienceHowTo — sleep must call the export, not a probe", () => {
  test("sleep.ts imports promoteExperienceHowTo by name", () => {
    const src = readFileSync(join(import.meta.dir, "sleep.ts"), "utf8");
    expect(src).toMatch(/import\s*\{[\s\S]*\bpromoteExperienceHowTo\b[\s\S]*\}\s*from\s*["']\.\/experience-store["']/);
    expect(src).not.toMatch(/promoteExperienceHowToIfPresent/);
    expect(src).not.toMatch(/import \* as experienceStore/);
    expect(src).not.toMatch(/experienceStore as \{[^}]*promoteExperienceHowTo/);
    expect(typeof experienceStore.promoteExperienceHowTo).toBe("function");
  });

  test("sleep alone (no test-helper mint) writes how-to from disk traj; file remains", async () => {
    await withMem("eden-m25-named-sleep-", async (mem, dir) => {
      const id = "traj-m25-named";
      const path = writeTraj(dir, {
        id,
        states: [
          {
            thought: `fix auth ${GOLD_OK}`,
            action: "wrote src/auth.ts then verified",
            exit: 0,
            verify: VERIFY_OK,
            files: ["src/auth.ts"],
            t: 8,
          },
        ],
        exit: 0,
        verify: VERIFY_OK,
        files: ["src/auth.ts"],
        goal: `fix auth ${GOLD_OK}`,
      });
      expect(howtoEmpty(dir)).toBe(true);
      await sleep({ dir, mem });
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(GOLD_OK);
      expect(howtoHay(dir)).toContain(VERIFY_OK);
    });
  });
});

describe("M25 wrap/hook: sleep then inject; experience files remain; pytest how-to", () => {
  test("OpenAI injectBodyThenObserveTools pytest → sleep: file remains, how-to exists, inject has no memory_search", async () => {
    await withMem("eden-m25-wrap-oa-", async (mem, dir) => {
      injectBodyThenObserveTools(mem, { messages: pytestWindow() });
      const before = experienceJsonlFiles(dir);
      expect(before.length).toBeGreaterThan(0);
      const beforeHay = before.map((p) => readFileSync(p, "utf8")).join("\n");
      expect(beforeHay.toLowerCase()).toMatch(/pytest/);

      await sleep({ dir, mem });

      const after = experienceJsonlFiles(dir);
      expect(after.length).toBeGreaterThanOrEqual(before.length);
      for (const p of before) {
        expect(existsSync(p)).toBe(true);
        expect(readFileSync(p, "utf8").length).toBeGreaterThan(0);
      }
      expect(howtoHay(dir).toLowerCase()).toMatch(/pytest/);

      const out = mem.inject([{ role: "user", content: "how do I run the auth session tests" }]);
      expect(Array.isArray(out)).toBe(true);
      expect(JSON.stringify(out)).not.toMatch(/\bmemory_search\b/);
      const body = mem.injectBody({ messages: [{ role: "user", content: "auth pytest flake" }] });
      expect(JSON.stringify(body)).not.toMatch(/\bmemory_search\b/);
    });
  });

  test("Anthropic withKnowFactsAnthropic pytest → sleep: file remains, how-to exists", async () => {
    await withMem("eden-m25-wrap-anth-", async (mem, dir) => {
      const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
      try {
        observeToolTraces(mem, anthropicPytestWindow());
        withKnowFactsAnthropic({ messages: anthropicPytestWindow() });
        const before = experienceJsonlFiles(dir);
        expect(before.length).toBeGreaterThan(0);

        await sleep({ dir, mem });

        for (const p of before) expect(existsSync(p)).toBe(true);
        expect(howtoHay(dir).toLowerCase()).toMatch(/pytest/);
        const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: "auth pytest flake" }] });
        expect(JSON.stringify(anth)).not.toMatch(/\bmemory_search\b/);
      } finally {
        procSpy.mockRestore();
      }
    });
  });

  test.failing("hook PostToolUse pytest + Stop keeps files; SessionStart does not dump traj", async () => {
    await withMem("eden-m25-hook-", async (mem, dir) => {
      void mem;
      memoryHookResponse({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "pytest tests/auth/session.test.ts -q" },
        tool_response: "collected 1 item\nauth.ts touched\nexit 0",
        session_id: "s-m25-hook",
      });
      const before = experienceJsonlFiles(dir);
      expect(before.length).toBeGreaterThan(0);

      expect(memoryHookResponse({ hook_event_name: "Stop", session_id: "s-m25-hook" })).toBeNull();
      for (const p of before) expect(existsSync(p)).toBe(true);
      expect(howtoHay(dir).toLowerCase()).toMatch(/pytest/);

      const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: "s-m25-hook" });
      const startHay = JSON.stringify(start ?? {});
      expect(startHay).not.toMatch(/\bmemory_search\b/);
      expect(startHay).not.toContain("collected 1 item");
      const exp = experienceHay(dir);
      if (exp.includes("RootWebArea")) expect(startHay).not.toContain("RootWebArea");
    });
  });

  test("injectBodyThenObserveTools throw returns original body", () => {
    const body = { messages: pytestWindow() };
    const out = injectBodyThenObserveTools(
      {
        injectBody() {
          throw new Error("m25 injectBody boom");
        },
        observe() {
          throw new Error("m25 observe boom");
        },
        dir: "/tmp/eden-m25-missing-inject-host",
      },
      body,
    );
    expect(out).toBe(body);
    expect(out.messages).toEqual(body.messages);
  });
});

describe("M25 GistStore LWW — experience gist must not clobber Clerk/sqlite", () => {
  test("fact gist survives a later experience replay gist", async () => {
    await withMem("eden-m25-lww-", async (mem, dir) => {
      mem.remember("Auth is Clerk");
      mem.observe([{ role: "user", content: "Auth is Clerk. We use sqlite in this project." }]);
      await sleep({ dir, mem, session: "s-m25-lww" });
      const afterFact = gistHay(dir);
      expect(afterFact).toMatch(/Clerk|sqlite/i);

      putExperience(dir, {
        id: "traj-m25-lww-exp",
        states: [
          {
            thought: `Goal: ${GOLD_REPLAY} only in experience gist`,
            action: `Outcome: ${GOLD_REPLAY} done`,
            goal: GOLD_REPLAY,
            outcome: `${GOLD_REPLAY} done`,
            t: Date.now() + 50_000,
          },
        ],
      });
      await sleep({ dir, mem, session: "s-m25-lww" });
      const afterExp = gistHay(dir);
      expect(afterExp).toMatch(/Clerk|sqlite/i);
      expect(afterExp).toContain(GOLD_REPLAY);
      expect(new GistStore(dir).latest("s-m25-lww", 8).some((g) => /Clerk|sqlite/i.test(g.text))).toBe(true);
    });
  });
});

describe("M25 screenshots/binary are not stored as how-to", () => {
  test("screenshot tool with PNG payload: sleep writes no how-to and no PNG magic", async () => {
    await withMem("eden-m25-shot-", async (mem, dir) => {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      putExperienceFromTool(dir, {
        name: "screenshot",
        args: { screenshot: png, alt: "login page caption UNIQUE_M25_CAPTION" },
        result: { screenshot: png, image: png, exit: 0 },
      });
      await sleep({ dir, mem });
      const howto = howtoHay(dir);
      const exp = experienceHay(dir);
      expect(howto).not.toContain("iVBORw0KGgo");
      expect(exp).not.toContain("iVBORw0KGgo");
      expect(howto.trim()).toBe("");
    });
  });

  test("pytest + nested screenshot still mints how-to without PNG bytes", async () => {
    await withMem("eden-m25-shot-py-", async (mem, dir) => {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      putExperienceFromTool(dir, {
        name: "Bash",
        args: { command: "pytest tests/ui.test.ts -q", screenshot: png },
        result: { stdout: "exit 0", screenshot: png, image_data: png },
      });
      await sleep({ dir, mem });
      expect(howtoHay(dir).toLowerCase()).toMatch(/pytest/);
      expect(howtoHay(dir)).not.toContain("iVBORw0KGgo");
      expect(experienceHay(dir)).not.toContain("iVBORw0KGgo");
    });
  });
});
