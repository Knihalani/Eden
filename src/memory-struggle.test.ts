/**
 * M6.3 struggle: fail-open inject + torn JSONL heal.
 * Ranking, hay, and fuse are not under test here.
 */
import { describe, expect, spyOn, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMemory, memoryInjectSwallows, openMemory } from "./index";
import { ExperienceStore, readExperience } from "./experience-store";
import { respondToHook } from "../packages/cli/src/hook";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { injectBodyThenObserveTools } from "../packages/wrap/src/tool-observe";

const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

const VALID_CI = {
  id: "m-ci",
  text: "CI is GitHub Actions",
  kind: "fact",
  tags: [] as string[],
  at: 1_700_000_000_000,
};
const VALID_AUTH = {
  id: "m-auth",
  text: "Auth is Clerk",
  kind: "fact",
  tags: [] as string[],
  at: 1_700_000_000_001,
};
const TORN = '{"id":"x","text":"torn';
const HEAL_FACT = "Deploy region is us-east-1 for every production cluster.";

function tmpDir(prefix = "eden-m63-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function jsonlPath(dir: string): string {
  return join(dir, "memories.jsonl");
}

function writeTornJsonl(dir: string, extras: object[] = [VALID_CI, VALID_AUTH]): void {
  const lines = extras.map((r) => JSON.stringify(r));
  writeFileSync(jsonlPath(dir), `${lines.join("\n")}\n${TORN}`);
}

function parseAllLines(path: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    expect(line.startsWith("{") && !line.includes("\n")).toBe(true);
    rows.push(JSON.parse(line));
  }
  return rows;
}

function withMem(fn: (mem: AgentMemory, dir: string) => void): void {
  const dir = tmpDir();
  try {
    fn(openMemory({ dir }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withHookDir(fn: (dir: string) => void | Promise<void>): Promise<void> | void {
  const dir = tmpDir("eden-m63-hook-");
  // respondToHook records the stretch under EDEN_HOME; unset, that is the real ~/.eden (#67).
  const home = tmpDir("eden-m63-home-");
  const prevDir = process.env.EDEN_MEMORY_DIR;
  const prevHome = process.env.EDEN_HOME;
  process.env.EDEN_MEMORY_DIR = dir;
  process.env.EDEN_HOME = home;
  const finish = () => {
    if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
    else process.env.EDEN_MEMORY_DIR = prevDir;
    if (prevHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  };
  try {
    const out = fn(dir);
    if (out && typeof (out as Promise<void>).then === "function") {
      return (out as Promise<void>).finally(finish);
    }
  } catch (e) {
    finish();
    throw e;
  }
  finish();
}

describe("M6.3 fail-open catch stays pass-through", () => {
  test("inject catch swallows and returns the original list (source pin)", () => {
    expect(INDEX_SRC).toMatch(/inject\(messages[\s\S]*catch \{\s*memoryInjectSwallows\.n\+\+/);
    expect(INDEX_SRC).toMatch(/injectBody\(body[\s\S]*catch \{\s*memoryInjectSwallows\.n\+\+/);
  });
});

describe("M6.3 inject / injectBody notesFor throw", () => {
  test("inject: notesFor throw → original messages identity, swallows +1", () => {
    withMem((mem) => {
      const list = [{ role: "user", content: "What GitHub Actions CI do we use?" }];
      const before = memoryInjectSwallows.n;
      mem.notesFor = (() => {
        throw new Error("m6.3 inject notesFor");
      }) as typeof mem.notesFor;
      let out: unknown;
      expect(() => {
        out = mem.inject(list);
      }).not.toThrow();
      expect(out).toBe(list);
      expect(out).toEqual([{ role: "user", content: "What GitHub Actions CI do we use?" }]);
      expect(memoryInjectSwallows.n).toBe(before + 1);
    });
  });

  test("injectBody: throw inside inject path → original body identity, swallows +1", () => {
    withMem((mem) => {
      const body = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "What GitHub Actions CI do we use?" }],
      };
      const before = memoryInjectSwallows.n;
      mem.notesFor = (() => {
        throw new Error("m6.3 injectBody notesFor");
      }) as typeof mem.notesFor;
      let out: unknown;
      expect(() => {
        out = mem.injectBody(body);
      }).not.toThrow();
      expect(out).toBe(body);
      expect((out as typeof body).messages).toBe(body.messages);
      expect(memoryInjectSwallows.n).toBe(before + 1);
    });
  });
});

describe("M6.3 wrap OpenAI + Anthropic fail-open", () => {
  test("withKnowFacts / injectBody: notesFor throw returns original body", () => {
    const body = {
      messages: [{ role: "user", content: "What GitHub Actions CI do we use?" }],
    };
    const boom = spyOn(AgentMemory.prototype, "notesFor").mockImplementation(() => {
      throw new Error("m6.3 wrap openai notesFor");
    });
    try {
      let out: unknown;
      expect(() => {
        out = withKnowFacts(body);
      }).not.toThrow();
      expect(out).toBe(body);
      expect((out as typeof body).messages).toBe(body.messages);

      const viaHelper = injectBodyThenObserveTools(
        {
          injectBody() {
            throw new Error("m6.3 helper injectBody");
          },
          observe() {},
        },
        body,
      );
      expect(viaHelper).toBe(body);
    } finally {
      boom.mockRestore();
    }
  });

  test("withKnowFactsAnthropic: notesFor throw returns original body", () => {
    const body = {
      system: "be brief",
      messages: [{ role: "user", content: "What GitHub Actions CI do we use?" }],
    };
    const boom = spyOn(AgentMemory.prototype, "notesFor").mockImplementation(() => {
      throw new Error("m6.3 wrap anthropic notesFor");
    });
    try {
      let out: unknown;
      expect(() => {
        out = withKnowFactsAnthropic(body);
      }).not.toThrow();
      expect(out).toBe(body);
      expect((out as typeof body).system).toBe("be brief");
    } finally {
      boom.mockRestore();
    }
  });

  test("withKnowFactsAnthropic junk body stays put (existing dialect pin)", () => {
    const body = { system: 1 as unknown as string, messages: [{ role: "user", content: "Auth is Clerk" }] };
    expect(withKnowFactsAnthropic(body)).toBe(body);
  });
});

describe("M6.3 hook fail-open", () => {
  test("memoryHookResponse junk getter does not throw and returns null", () => {
    withHookDir(() => {
      const raw = {
        hook_event_name: "UserPromptSubmit",
        get prompt(): string {
          throw new Error("m6.3 hook junk prompt");
        },
      };
      let out: unknown;
      expect(() => {
        out = memoryHookResponse(raw);
      }).not.toThrow();
      expect(out).toBeNull();
    });
  });

  test("memoryHookResponse inject throw still returns null", () => {
    withHookDir(() => {
      const boom = spyOn(AgentMemory.prototype, "inject").mockImplementation(() => {
        throw new Error("m6.3 hook inject");
      });
      try {
        expect(memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "What GitHub Actions CI do we use?" })).toBeNull();
        expect(memoryHookResponse({ hook_event_name: "PreCompact", prompt: "What GitHub Actions CI do we use?" })).toBeNull();
        expect(memoryHookResponse({ hook_event_name: "SessionStart" })).toBeNull();
      } finally {
        boom.mockRestore();
      }
    });
  });

  test("respondToHook inject throw still resolves { ok: true }", async () => {
    await withHookDir(async () => {
      const boom = spyOn(AgentMemory.prototype, "inject").mockImplementation(() => {
        throw new Error("m6.3 respondToHook inject");
      });
      try {
        await expect(
          respondToHook({ hook_event_name: "UserPromptSubmit", prompt: "What GitHub Actions CI do we use?" }),
        ).resolves.toEqual({ ok: true });
      } finally {
        boom.mockRestore();
      }
    });
  });
});

describe("M6.3 torn JSONL: load swallows, next write heals", () => {
  test("openMemory skips truncated last line; remember heals the file", () => {
    const dir = tmpDir("eden-m63-torn-");
    try {
      writeTornJsonl(dir);
      let mem: AgentMemory | undefined;
      expect(() => {
        mem = openMemory({ dir });
      }).not.toThrow();
      const loaded = mem!.memories();
      expect(loaded.map((r) => r.id).sort()).toEqual(["m-auth", "m-ci"]);
      expect(loaded.every((r) => r.id !== "x")).toBe(true);
      expect(loaded.some((r) => r.text.includes("torn"))).toBe(false);

      mem!.remember(HEAL_FACT);
      mem!.close();

      const rows = parseAllLines(jsonlPath(dir));
      const blob = readFileSync(jsonlPath(dir), "utf8");
      expect(blob).not.toContain(TORN);
      expect(rows.length).toBe(3);
      const ids = rows.map((r) => (r as { id: string }).id);
      expect(ids).toContain("m-ci");
      expect(ids).toContain("m-auth");
      expect(ids).not.toContain("x");
      expect(rows.some((r) => /us-east-1/i.test(String((r as { text: string }).text)))).toBe(true);

      const again = openMemory({ dir });
      expect(again.memories().length).toBe(3);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inject of a durable fact also heals truncated JSONL", () => {
    const dir = tmpDir("eden-m63-torn-inject-");
    try {
      writeTornJsonl(dir);
      const mem = openMemory({ dir });
      const list = [{ role: "user", content: HEAL_FACT }];
      expect(() => mem.inject(list)).not.toThrow();
      mem.close();
      const rows = parseAllLines(jsonlPath(dir));
      expect(readFileSync(jsonlPath(dir), "utf8")).not.toContain(TORN);
      expect(rows.some((r) => /us-east-1/i.test(String((r as { text: string }).text)))).toBe(true);
      expect(rows.some((r) => (r as { id: string }).id === "m-ci")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M6.3 leftover tmp", () => {
  test("same-pid leftover tmp: persist succeeds and jsonl heals", () => {
    const dir = tmpDir("eden-m63-tmp-");
    try {
      writeTornJsonl(dir);
      const jsonl = jsonlPath(dir);
      const leftover = `${jsonl}.${process.pid}.tmp`;
      writeFileSync(leftover, TORN);
      const mem = openMemory({ dir });
      expect(mem.memories().map((r) => r.id).sort()).toEqual(["m-auth", "m-ci"]);
      mem.remember(HEAL_FACT);
      mem.close();
      expect(existsSync(leftover)).toBe(false);
      const rows = parseAllLines(jsonl);
      expect(readFileSync(jsonl, "utf8")).not.toContain(TORN);
      expect(rows.some((r) => /us-east-1/i.test(String((r as { text: string }).text)))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("foreign-pid leftover tmp does not block persist", () => {
    const dir = tmpDir("eden-m63-tmp-foreign-");
    try {
      writeTornJsonl(dir);
      const jsonl = jsonlPath(dir);
      const leftover = `${jsonl}.999999.tmp`;
      writeFileSync(leftover, "half-written garbage");
      const mem = openMemory({ dir });
      mem.remember(HEAL_FACT);
      mem.close();
      const rows = parseAllLines(jsonl);
      expect(rows.some((r) => /us-east-1/i.test(String((r as { text: string }).text)))).toBe(true);
      expect(readFileSync(jsonl, "utf8")).not.toContain(TORN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M6.3 kill -9 mid-write analogue", () => {
  test("half tmp + truncated jsonl: parent load+write heals", () => {
    const dir = tmpDir("eden-m63-kill-analogue-");
    try {
      const jsonl = jsonlPath(dir);
      writeTornJsonl(dir);
      writeFileSync(`${jsonl}.${process.pid}.tmp`, `${JSON.stringify(VALID_CI)}\n{"id":"half"`);
      const mem = openMemory({ dir });
      expect(mem.memories().map((r) => r.id).sort()).toEqual(["m-auth", "m-ci"]);
      mem.remember(HEAL_FACT);
      mem.close();
      const rows = parseAllLines(jsonl);
      expect(readFileSync(jsonl, "utf8")).not.toContain(TORN);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(rows.every((r) => typeof (r as { id?: string }).id === "string" && typeof (r as { text?: string }).text === "string")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SIGKILL child holding lock + torn jsonl: parent persist heals", async () => {
    const dir = tmpDir("eden-m63-sigkill-");
    const jsonl = jsonlPath(dir);
    const lock = `${jsonl}.lock`;
    try {
      const readyPath = join(dir, "READY");
      const src = `
        import { openSync, writeFileSync, writeSync } from "node:fs";
        import { hostname } from "node:os";
        import { join } from "node:path";
        const dir = process.env.EDEN_M63_DIR;
        const jsonl = join(dir, "memories.jsonl");
        const valid = ${JSON.stringify([VALID_CI, VALID_AUTH])};
        writeFileSync(jsonl, valid.map((r) => JSON.stringify(r)).join("\\n") + "\\n" + ${JSON.stringify(TORN)});
        writeFileSync(jsonl + "." + process.pid + ".tmp", "partial-body");
        const fd = openSync(jsonl + ".lock", "wx");
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now() }));
        writeFileSync(join(dir, "READY"), "1");
        await Bun.sleep(120_000);
      `;
      const proc = Bun.spawn(["bun", "-e", src], {
        env: { ...process.env, EDEN_M63_DIR: dir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const deadline = Date.now() + 8_000;
      while (!existsSync(readyPath) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(readyPath)).toBe(true);
      proc.kill("SIGKILL");
      await Promise.race([proc.exited, Bun.sleep(5_000)]);

      let mem: AgentMemory | undefined;
      expect(() => {
        mem = openMemory({ dir });
      }).not.toThrow();
      expect(mem!.memories().map((r) => r.id).sort()).toEqual(["m-auth", "m-ci"]);
      expect(() => mem!.remember(HEAL_FACT)).not.toThrow();
      mem!.close();
      const rows = parseAllLines(jsonl);
      expect(readFileSync(jsonl, "utf8")).not.toContain(TORN);
      expect(rows.some((r) => /us-east-1/i.test(String((r as { text: string }).text)))).toBe(true);
      try { unlinkSync(lock); } catch {}
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("abandoned lock file from a dead pid does not throw into inject", () => {
    const dir = tmpDir("eden-m63-dead-lock-");
    const lock = `${jsonlPath(dir)}.lock`;
    let fd: number | undefined;
    try {
      writeTornJsonl(dir);
      fd = openSync(lock, "wx");
      writeSync(fd, JSON.stringify({ pid: 999_999_999, host: hostname(), ts: Date.now() - 60_000 }));
      closeSync(fd);
      fd = undefined;
      const mem = openMemory({ dir });
      const list = [{ role: "user", content: HEAL_FACT }];
      expect(() => mem.inject(list)).not.toThrow();
      mem.close();
      parseAllLines(jsonlPath(dir));
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch {}
      try { unlinkSync(lock); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M6.3 probe wrap + hook fail-open true", () => {
  test("OpenAI inject/injectBody, Anthropic wrap, hook: throw does not escape", () => {
    withMem((mem) => {
      mem.remember("CI is GitHub Actions");
      const list = [{ role: "user", content: "What GitHub Actions CI do we use?" }];
      expect(() => mem.inject(list)).not.toThrow();
      expect(() => mem.injectBody({ messages: list })).not.toThrow();
    });

    const anthropic = { messages: [{ role: "user", content: "What GitHub Actions CI do we use?" }] };
    expect(() => withKnowFactsAnthropic(anthropic)).not.toThrow();
    expect(() => withKnowFacts({ messages: [{ role: "user", content: "What GitHub Actions CI do we use?" }] })).not.toThrow();

    withHookDir(() => {
      expect(() => memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "What GitHub Actions CI do we use?" })).not.toThrow();
      expect(() => memoryHookResponse({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { stdout: "ok" } })).not.toThrow();
    });
  });
});

const AX_TREE = "RootWebArea [landmark] role: WebArea AX Welcome to example";

describe("M23.3 experience ENOENT", () => {
  test("missing dir: constructor / ids / get / readExperience never throw", () => {
    const missing = "/definitely/not/a/real/eden-experience-" + Math.random().toString(36).slice(2);
    let store: ExperienceStore | undefined;
    expect(() => {
      store = new ExperienceStore(missing);
    }).not.toThrow();
    let ids: unknown;
    let got: unknown;
    let read: unknown;
    expect(() => {
      ids = store!.ids();
      got = store!.get("x");
      read = readExperience(missing, "x");
    }).not.toThrow();
    expect(ids).toEqual([]);
    expect(got).toBeNull();
    expect(read).toBeNull();
  });

  test("openMemory with no experience/ subdir: inject does not throw, returns array", () => {
    withMem((mem, dir) => {
      expect(existsSync(join(dir, "experience"))).toBe(false);
      const list = [{ role: "user", content: "what's 2+2?" }];
      let out: unknown;
      expect(() => {
        out = mem.inject(list);
      }).not.toThrow();
      expect(Array.isArray(out)).toBe(true);
    });
  });

  test("wrap: injectBodyThenObserveTools / withKnowFactsAnthropic tool payload when dir is gone", () => {
    const dir = tmpDir("eden-m233-gone-");
    const mem = openMemory({ dir });
    rmSync(dir, { recursive: true, force: true });
    const openaiBody = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "c-ax",
              type: "function",
              function: { name: "browser_snapshot", arguments: JSON.stringify({ url: "https://example.com" }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "c-ax", content: AX_TREE },
      ],
    };
    let viaHelper: unknown;
    expect(() => {
      viaHelper = injectBodyThenObserveTools(mem, openaiBody);
    }).not.toThrow();
    expect(viaHelper).toBeTruthy();
    expect(Array.isArray((viaHelper as { messages?: unknown[] }).messages)).toBe(true);

    const anth = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-ax", name: "browser_snapshot", input: { url: "https://example.com" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-ax", content: AX_TREE }],
        },
      ],
    };
    let anthOut: unknown;
    expect(() => {
      anthOut = withKnowFactsAnthropic(anth);
    }).not.toThrow();
    expect(anthOut).toBeTruthy();
    expect((anthOut as typeof anth).messages).toEqual(anth.messages);
  });

  test("hook PostToolUse AX payload: missing experience path does not throw", () => {
    withHookDir(() => {
      let out: unknown;
      expect(() => {
        out = memoryHookResponse({
          hook_event_name: "PostToolUse",
          tool_name: "browser_snapshot",
          tool_response: { accessibility_tree: AX_TREE },
        });
      }).not.toThrow();
      expect(out).toBeNull();
    });
    const missing = "/definitely/not/a/real/eden-experience-" + Math.random().toString(36).slice(2);
    expect(() => new ExperienceStore(missing).ids()).not.toThrow();
    expect(new ExperienceStore(missing).ids()).toEqual([]);
    expect(new ExperienceStore(missing).get("x")).toBeNull();
  });

  test("corrupt jsonl line skipped; get does not throw", () => {
    const dir = tmpDir("eden-m233-torn-exp-");
    try {
      mkdirSync(join(dir, "experience"), { recursive: true });
      writeFileSync(
        join(dir, "experience", "t1.jsonl"),
        `${JSON.stringify({ id: "t1" })}\n${JSON.stringify({ url: "https://example.com", t: 1 })}\n{"torn\n`,
      );
      const store = new ExperienceStore(dir);
      let got: ReturnType<ExperienceStore["get"]> | undefined;
      expect(() => {
        got = store.get("t1");
      }).not.toThrow();
      expect(got).not.toBeNull();
      expect(got!.id).toBe("t1");
      expect(got!.states.some((s) => s.url === "https://example.com")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M35.4 fail-open wrap+hook+inject", () => {
  const CUE = "What GitHub Actions CI do we use?";

  test("inject catch stays pass-through (memoryInjectSwallows.n++)", () => {
    expect(INDEX_SRC).toMatch(/inject\(messages[\s\S]*catch \{\s*memoryInjectSwallows\.n\+\+/);
    expect(INDEX_SRC).toMatch(/injectBody\(body[\s\S]*catch \{\s*memoryInjectSwallows\.n\+\+/);
    expect(INDEX_SRC).toMatch(/return list;/);
    expect(INDEX_SRC).toMatch(/return body;/);
  });

  test("notesFor throw → original messages on inject, OpenAI withKnowFacts, Anthropic, hook Submit", async () => {
    const list = [{ role: "user", content: CUE }];
    const body = { model: "gpt-4o", messages: [{ role: "user", content: CUE }] };
    const wrapBody = { messages: [{ role: "user", content: CUE }] };
    const anth = { system: "be brief", messages: [{ role: "user", content: CUE }] };
    const boom = spyOn(AgentMemory.prototype, "notesFor").mockImplementation(() => {
      throw new Error("m35.4 notesFor");
    });
    try {
      withMem((mem) => {
        const before = memoryInjectSwallows.n;
        let injected: unknown;
        expect(() => {
          injected = mem.inject(list);
        }).not.toThrow();
        expect(injected).toBe(list);
        expect(injected).toEqual([{ role: "user", content: CUE }]);
        expect(memoryInjectSwallows.n).toBe(before + 1);

        const beforeBody = memoryInjectSwallows.n;
        let injectedBody: unknown;
        expect(() => {
          injectedBody = mem.injectBody(body);
        }).not.toThrow();
        expect(injectedBody).toBe(body);
        expect((injectedBody as typeof body).messages).toBe(body.messages);
        expect(memoryInjectSwallows.n).toBe(beforeBody + 1);
      });

      const beforeWrap = memoryInjectSwallows.n;
      let openai: unknown;
      expect(() => {
        openai = withKnowFacts(wrapBody);
      }).not.toThrow();
      expect(openai).toBe(wrapBody);
      expect((openai as typeof wrapBody).messages).toBe(wrapBody.messages);
      expect(memoryInjectSwallows.n).toBe(beforeWrap + 1);

      const beforeAnth = memoryInjectSwallows.n;
      let anthOut: unknown;
      expect(() => {
        anthOut = withKnowFactsAnthropic(anth);
      }).not.toThrow();
      expect(anthOut).toBe(anth);
      expect((anthOut as typeof anth).system).toBe("be brief");
      expect((anthOut as typeof anth).messages).toBe(anth.messages);
      expect(memoryInjectSwallows.n).toBe(beforeAnth + 1);

      await withHookDir(async () => {
        const beforeHook = memoryInjectSwallows.n;
        let hookOut: unknown;
        expect(() => {
          hookOut = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: CUE });
        }).not.toThrow();
        expect(hookOut).toBeNull();
        expect(JSON.stringify(hookOut)).not.toMatch(/\b403\b/);
        expect(memoryInjectSwallows.n).toBe(beforeHook + 1);

        const submitted = await respondToHook({ hook_event_name: "UserPromptSubmit", prompt: CUE });
        expect(submitted).toEqual({ ok: true });
        expect(JSON.stringify(submitted)).not.toMatch(/\b403\b/);
      });
    } finally {
      boom.mockRestore();
    }
  });
});
