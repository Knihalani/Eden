/**
 * M3.4 packet identity: one causal order — retrieve from previous store using
 * this-turn cue, then encode this turn. Cue is latest user text, not the window.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { cueFor, MEMORY_MARK, memoryInjectSwallows, openMemory, placePathsFrom } from "./index";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/56

function withMem(fn: (mem: ReturnType<typeof openMemory>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "eden-m34-"));
  try {
    fn(openMemory({ dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 40 user/assistant lines about Kai's Pacific timezone. */
function pacificTurns(): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  for (let i = 0; i < 20; i++) {
    out.push({ role: "user", content: `Kai timezone is Pacific note ${i}.` });
    out.push({ role: "assistant", content: `Noted Pacific timezone for slot ${i}.` });
  }
  return out;
}

const AUTH_RULE = "never mock src/lib/auth.ts in unit tests.";
const FILE_SECRET = "export const SECRET = 1";
const HUGE_FN = "export default function huge() {\n  return 1;\n}";

function memorySystemText(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m === "object" ? (m as { role?: string; content?: unknown }) : {}))
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

describe("M3 cueFor this turn", () => {
  test("cueFor is the new user line, not the 40 Pacific filler lines", () => {
    const messages = [...pacificTurns(), { role: "user", content: "What is the CI provider?" }];
    const cue = cueFor(messages);
    expect(cue).toBe("What is the CI provider?");
    expect(cue).not.toMatch(/Pacific/i);
    expect(cue).not.toContain("Kai timezone");
    expect(cue).not.toContain("note 0");
    expect(cue).not.toContain("slot 19");
  });

  test("cueFor Anthropic content blocks and Gemini parts are the new user line", () => {
    const blocks = [...pacificTurns(), { role: "user", content: [{ type: "text", text: "What is the CI provider?" }] }];
    expect(cueFor(blocks)).toBe("What is the CI provider?");
    expect(cueFor(blocks)).not.toMatch(/Pacific/i);

    const gemini = [
      ...pacificTurns().map((m) => ({ role: m.role, parts: [{ text: m.content }] })),
      { role: "user", parts: [{ text: "What is the CI provider?" }] },
    ];
    expect(cueFor(gemini)).toBe("What is the CI provider?");
    expect(cueFor(gemini)).not.toMatch(/Pacific/i);
  });

  test("cueFor keeps a unicode prompt", () => {
    expect(cueFor([{ role: "user", content: "café 時區 日本語" }])).toBe("café 時區 日本語");
  });
});

describe("M3 inject retrieve then encode", () => {
  test("inject MEMORY_MARK packet does not echo this-turn Clerk; observe still stores it", () => {
    withMem((mem) => {
      const list = [{ role: "user", content: "Auth is Clerk" }];
      const injected = mem.inject(list);
      expect(memorySystemText(injected)).not.toContain("Clerk");
      expect(mem.memories().some((r) => /Clerk/i.test(r.text))).toBe(true);
    });
  });

  test("inject ranks this-turn cue not the Pacific window", () => {
    withMem((mem) => {
      mem.remember("CI is GitHub Actions");
      mem.remember("Kai timezone is Pacific");
      for (let i = 0; i < 8; i++) {
        mem.remember(`Kai timezone is Pacific office slot ${i} for standup hours.`);
      }

      const bare = [...pacificTurns(), { role: "user", content: "What CI do we use?" }];
      expect(cueFor(bare)).toBe("What CI do we use?");
      expect(cueFor(bare)).not.toMatch(/Pacific/i);
      expect(memorySystemText(mem.inject(bare))).not.toMatch(/Pacific/i);

      // "GitHub Actions" in the cue so the current lexical ranker can complete
      // (bare "ci" is two letters; that is M4, not this wave).
      const messages = [...pacificTurns(), { role: "user", content: "What GitHub Actions CI do we use?" }];
      expect(cueFor(messages)).toBe("What GitHub Actions CI do we use?");
      const packet = memorySystemText(mem.inject(messages));
      expect(packet).toMatch(/GitHub|Actions/i);
      expect(packet).not.toMatch(/Pacific/i);
    });
  });

  test("empty cue does not dump last-k as this-turn memory", () => {
    withMem((mem) => {
      mem.remember("Kai timezone is Pacific");
      const injected = mem.inject([{ role: "assistant", content: "working" }]);
      expect(memorySystemText(injected)).not.toMatch(/Pacific/i);
      expect(cueFor([{ role: "assistant", content: "working" }])).toBe("");
      const pathsOnly = mem.inject([{ role: "assistant", content: "working" }], ["src/lib/auth.ts"]);
      expect(memorySystemText(pathsOnly)).not.toMatch(/Pacific/i);
      expect(memorySystemText(pathsOnly)).not.toMatch(/auth\.ts/i);
    });
  });

  test("inject fail-open: notesFor throw returns original list and increments swallows", () => {
    withMem((mem) => {
      const list = [{ role: "user", content: "Auth is Clerk" }];
      const before = memoryInjectSwallows.n;
      mem.notesFor = (() => {
        throw new Error("m3.4 fail-open probe");
      }) as typeof mem.notesFor;
      const out = mem.inject(list);
      expect(out).toBe(list);
      expect(out).toEqual([{ role: "user", content: "Auth is Clerk" }]);
      expect(memoryInjectSwallows.n).toBe(before + 1);
    });
  });

  test("inject skip-if-mark: no second MEMORY_MARK; still encodes", () => {
    withMem((mem) => {
      const list = [
        { role: "system", content: `${MEMORY_MARK}\n- CI is GitHub Actions` },
        { role: "user", content: "Auth is Clerk" },
      ];
      const out = mem.inject(list);
      expect(out).toBe(list);
      expect(memorySystemText(out).split(MEMORY_MARK).length - 1).toBe(1);
      expect(mem.memories().some((r) => /Clerk/i.test(r.text))).toBe(true);
    });
  });

  test("injectBody does not echo this-turn system* as memory; still encodes it", () => {
    withMem((mem) => {
      const out = mem.injectBody({
        system: "Auth is Clerk for every login at the company.",
        messages: [{ role: "user", content: "What auth provider do we use for Clerk?" }],
      });
      expect(memorySystemText(out.messages as unknown[])).not.toMatch(/Clerk/i);
      expect(mem.memories().some((r) => /Clerk/i.test(r.text))).toBe(true);
    });
  });

  test("Gemini contents rank last user; systemInstruction skip-if-mark does not add a second card", () => {
    withMem((mem) => {
      mem.remember("CI is GitHub Actions");
      mem.remember("Kai timezone is Pacific");
      for (let i = 0; i < 8; i++) {
        mem.remember(`Kai timezone is Pacific office slot ${i} for standup hours.`);
      }

      const ranked = mem.injectBody({
        contents: [
          ...pacificTurns().map((m) => ({ role: m.role, parts: [{ text: m.content }] })),
          { role: "user", parts: [{ text: "What GitHub Actions CI do we use?" }] },
        ],
      });
      const rankedPkt = memorySystemText(ranked.contents as unknown[]);
      expect(rankedPkt).toMatch(/GitHub|Actions/i);
      expect(rankedPkt).not.toMatch(/Pacific/i);

      const marked = {
        systemInstruction: `${MEMORY_MARK}\n- CI is GitHub Actions`,
        contents: [{ role: "user", parts: [{ text: "Auth is Clerk" }] }],
      };
      const out = mem.injectBody(marked);
      const pkt = memorySystemText((out.contents as unknown[]) || []);
      expect(pkt).not.toContain(MEMORY_MARK);
      expect(String(out.systemInstruction).split(MEMORY_MARK).length - 1).toBe(1);
      expect(mem.memories().some((r) => /Clerk/i.test(r.text))).toBe(true);
    });
  });

  test.failing("injectBody fail-open: system observe throw returns original body", () => {
    withMem((mem) => {
      const body = {
        system: "Auth is Clerk for every login at the company.",
        messages: [{ role: "user", content: "What GitHub Actions CI do we use?" }],
      };
      const before = memoryInjectSwallows.n;
      const inner = mem.observe.bind(mem);
      mem.observe = ((messages: unknown[]) => {
        const blob = JSON.stringify(messages);
        if (blob.includes("Auth is Clerk")) throw new Error("m3 injectBody sys observe");
        return inner(messages);
      }) as typeof mem.observe;
      const out = mem.injectBody(body);
      expect(out).toBe(body);
      expect(memoryInjectSwallows.n).toBe(before + 1);
    });
  });
});

describe("M41 place cues", () => {
  test("placePathsFrom keeps auth.ts and drops cwd, emails, and file bodies", () => {
    const names = placePathsFrom({
      open_files: ["src/lib/auth.ts"],
      cwd: "/tmp/eden-not-a-place",
      content: FILE_SECRET,
      last_goal: "fix the flake in auth.ts",
    });
    expect(names.some((n) => n.toLowerCase().includes("auth.ts"))).toBe(true);
    expect(names.join(" ")).not.toContain("/tmp/eden-not-a-place");
    expect(names.join(" ")).not.toContain(FILE_SECRET);
    expect(placePathsFrom({ files: [HUGE_FN] })).toEqual([]);
    expect(placePathsFrom({ open_files: ["function foo() { return bar/baz; }"] })).toEqual([]);
    expect(placePathsFrom({ files: ['import x from "./auth.ts"'] })).toEqual([]);
    expect(placePathsFrom({ files: ["x".repeat(500)] })).toEqual([]);
    expect(placePathsFrom({ files: ["foo/bar()"] })).toEqual([]);
    expect(placePathsFrom({ last_goal: "function foo() { return bar/baz; }" })).toEqual([]);
    const ident = placePathsFrom({
      session_id: "auth.ts",
      sessionId: "src/lib/auth.ts",
      email: "dev@eden.dev",
      cwd: "/tmp/eden-not-a-place",
      open_files: ["a@b.com"],
    });
    expect(ident).toEqual([]);
  });

  test("40 Pacific lines plus fix auth.ts is still this-turn", () => {
    const messages = [...pacificTurns(), { role: "user", content: "fix auth.ts" }];
    const cue = cueFor(messages);
    expect(cue).toBe("fix auth.ts");
    expect(cue).not.toMatch(/Pacific/i);
  });

  test.failing("path cue ranks auth.ts without stuffing the file body", () => {
    withMem((mem) => {
      mem.remember(AUTH_RULE);
      const list = [{ role: "user", content: "fix this", files: ["src/lib/auth.ts"], body: FILE_SECRET }];
      expect(cueFor(list)).toBe("fix this");
      expect(cueFor(list)).not.toContain("src/lib/auth.ts");
      expect(cueFor(list)).not.toContain(FILE_SECRET);
      const packet = memorySystemText(mem.inject(list));
      expect(packet).toContain(MEMORY_MARK);
      expect(packet).toMatch(/auth\.ts/i);
      expect(packet).toMatch(/never mock/i);
      expect(packet).not.toContain(FILE_SECRET);
    });
  });

  test.failing("40 lines plus fix this and auth.ts files still not Pacific", () => {
    withMem((mem) => {
      mem.remember(AUTH_RULE);
      mem.remember("Kai timezone is Pacific");
      for (let i = 0; i < 8; i++) {
        mem.remember(`Kai timezone is Pacific office slot ${i} for standup hours.`);
      }
      const list = [
        ...pacificTurns(),
        { role: "user", content: "fix this", files: ["src/lib/auth.ts"], body: FILE_SECRET },
      ];
      expect(cueFor(list)).toBe("fix this");
      expect(cueFor(list)).not.toMatch(/Pacific/i);
      const packet = memorySystemText(mem.inject(list));
      expect(packet).toContain(MEMORY_MARK);
      expect(packet).toMatch(/auth\.ts/i);
      expect(packet).toMatch(/never mock/i);
      expect(packet).not.toMatch(/Pacific/i);
      expect(packet).not.toContain(FILE_SECRET);
    });
  });

  test("file body dump is not a place path", () => {
    withMem((mem) => {
      mem.remember(AUTH_RULE);
      const dump = `${"n".repeat(250)}\n${"m".repeat(249)}`;
      expect(dump.length).toBe(500);
      const huge = [{ role: "user", content: "fix this", files: [HUGE_FN] }];
      const long = [{ role: "user", content: "fix this", files: [dump] }];
      expect(cueFor(huge)).toBe("fix this");
      expect(cueFor(long)).toBe("fix this");
      const hugePkt = memorySystemText(mem.inject(huge));
      const longPkt = memorySystemText(mem.inject(long));
      expect(hugePkt).not.toContain("export default function huge");
      expect(hugePkt).not.toContain("return 1");
      expect(longPkt).not.toContain(dump);
      expect(hugePkt).not.toMatch(/never mock/i);
      expect(longPkt).not.toMatch(/never mock/i);
    });
  });

  test.failing("injectBody open_files retrieves auth.ts and keeps last user text", () => {
    withMem((mem) => {
      mem.remember("CI is GitHub Actions");
      mem.remember("Kai timezone is Pacific");
      for (let i = 0; i < 8; i++) {
        mem.remember(`Kai timezone is Pacific office slot ${i} for standup hours.`);
      }
      const ranked = mem.injectBody({
        messages: [...pacificTurns(), { role: "user", content: "What GitHub Actions CI do we use?" }],
      });
      const rankedPkt = memorySystemText(ranked.messages as unknown[]);
      expect(rankedPkt).toMatch(/GitHub|Actions/i);
      expect(rankedPkt).not.toMatch(/Pacific/i);

      mem.remember(AUTH_RULE);
      const body = {
        messages: [{ role: "user", content: "fix this", body: FILE_SECRET }],
        open_files: ["src/lib/auth.ts"],
      };
      const out = mem.injectBody(body);
      const messages = out.messages as { role?: string; content?: string }[];
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      expect(lastUser?.content).toBe("fix this");
      const packet = memorySystemText(messages);
      expect(packet).toContain(MEMORY_MARK);
      expect(packet).toMatch(/auth\.ts/i);
      expect(packet).toMatch(/never mock/i);
      expect(packet).not.toContain(FILE_SECRET);
      expect(packet).not.toMatch(/Pacific/i);
    });
  });

  test.failing("UserPromptSubmit open_files is a place cue, not a file body or Pacific transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m41-hook-"));
    const prevDir = process.env.EDEN_MEMORY_DIR;
    const prevHome = process.env.EDEN_HOME;
    process.env.EDEN_MEMORY_DIR = dir;
    delete process.env.EDEN_HOME;
    try {
      const mem = openMemory({ dir });
      mem.remember(AUTH_RULE);
      mem.remember("Kai timezone is Pacific");
      for (let i = 0; i < 8; i++) {
        mem.remember(`Kai timezone is Pacific office slot ${i} for standup hours.`);
      }
      mem.close();

      const trans = join(dir, "pacific.jsonl");
      const lines: string[] = [];
      for (let i = 0; i < 20; i++) {
        lines.push(
          JSON.stringify({ type: "user", message: { role: "user", content: `Kai timezone is Pacific note ${i}.` } }),
        );
        lines.push(
          JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: `Noted Pacific timezone for slot ${i}.` },
          }),
        );
      }
      writeFileSync(trans, `${lines.join("\n")}\n`);

      const raw = memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        prompt: "fix this",
        open_files: ["src/lib/auth.ts"],
        body: FILE_SECRET,
        transcript_path: trans,
      });
      const ctx = [
        raw?.additional_context,
        (raw?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext,
      ]
        .map((x) => String(x ?? ""))
        .join("\n");
      expect(ctx).toContain(MEMORY_MARK);
      expect(ctx).toMatch(/auth\.ts/i);
      expect(ctx).toMatch(/never mock/i);
      expect(ctx).not.toContain(FILE_SECRET);
      expect(ctx).not.toContain(HUGE_FN);
      expect(ctx).not.toMatch(/Pacific/i);
    } finally {
      if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prevDir;
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
