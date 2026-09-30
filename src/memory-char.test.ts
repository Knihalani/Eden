/**
 * M1.3 characterization. Documents today's product behavior so later waves cannot
 * silently "fix" extract/ranker/fuse/persist/wrap without flipping a test.
 * Red desired-behavior cases use Bun `test.failing` and stay tagged WAVE-FIX.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_MARK, openMemory, type AgentMemory } from "./index";
import { pathCues } from "./memory-sota";
import { withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/39

const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

function tmpDir(prefix = "eden-m13-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withMem(fn: (mem: AgentMemory, dir: string) => void): void {
  const dir = tmpDir();
  try {
    fn(openMemory({ dir }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function storedTexts(mem: AgentMemory): string[] {
  return mem.memories().map((r) => r.text);
}

function hasText(mem: AgentMemory, needle: string): boolean {
  const n = needle.toLowerCase();
  return storedTexts(mem).some((t) => t.toLowerCase().includes(n));
}

function memorySystemText(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m === "object" ? (m as { role?: string; content?: unknown }) : {}))
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

function anthropicMemoryText(body: { system?: unknown }): string {
  const sys = body.system;
  const parts = typeof sys === "string"
    ? [sys]
    : Array.isArray(sys)
      ? sys.map((b) => (typeof b === "string" ? b : String((b as { text?: string })?.text ?? "")))
      : [];
  return parts.filter((p) => p.includes(MEMORY_MARK)).join("\n");
}

function hookContext(raw: Record<string, unknown> | null): string {
  if (!raw) return "";
  const spec = raw.hookSpecificOutput;
  const extra = spec && typeof spec === "object" ? (spec as { additionalContext?: unknown }).additionalContext : "";
  return [raw.additional_context, extra].map((x) => String(x ?? "")).join("\n");
}

function withHookDir(fn: () => void): void {
  const dir = tmpDir("eden-m13-hook-");
  const prevDir = process.env.EDEN_MEMORY_DIR;
  const prevHome = process.env.EDEN_HOME;
  process.env.EDEN_MEMORY_DIR = dir;
  delete process.env.EDEN_HOME;
  try {
    fn();
  } finally {
    if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
    else process.env.EDEN_MEMORY_DIR = prevDir;
    if (prevHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("M1.3 (1) please / fix the / we need to dropped", () => {
  const please = "Please fix the flake in auth.test.ts";
  const fixThe = "fix the flake in auth.test.ts";
  const weNeed = "we need to bump the timeout in the worker.";

  test("today: CHAT/extractDurable stores please, fix the, we need to; secrets still redacted", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: please }]);
      mem.observe([{ role: "user", content: fixThe }]);
      mem.observe([{ role: "user", content: weNeed }]);
      expect(hasText(mem, "flake in auth.test.ts")).toBe(true);
      expect(hasText(mem, "timeout in the worker")).toBe(true);
      expect(storedTexts(mem).length).toBeGreaterThan(0);

      mem.observe([{ role: "user", content: "The deploy token is sk-abc123XYZ999" }]);
      mem.observe([{ role: "user", content: "The github token is ghp_abc123XYZ999" }]);
      const blob = storedTexts(mem).join("\n");
      expect(blob).not.toMatch(/\bsk-/);
      expect(blob).not.toMatch(/\bghp_/);
    });

    withHookDir(() => {
      memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: please });
      const start = memoryHookResponse({ hook_event_name: "SessionStart" });
      const ctx = hookContext(start).toLowerCase();
      expect(ctx).not.toMatch(/\bsk-/);
      expect(ctx).not.toMatch(/\bghp_/);
    });
  });

  // WAVE-FIX: M2.1
  test("desired: please / fix the / we need to are stored", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: please }]);
      mem.observe([{ role: "user", content: fixThe }]);
      mem.observe([{ role: "user", content: weNeed }]);
      expect(hasText(mem, "Please fix the flake in auth.test.ts")).toBe(true);
      expect(hasText(mem, "fix the flake in auth.test.ts")).toBe(true);
      expect(hasText(mem, "we need to bump the timeout in the worker")).toBe(true);
    });
  });
});

describe("M1.3 (2) auth.ts not a path cue", () => {
  test.failing("today: pathCues keeps dotted filenames and directory segments", () => {
    const cues = pathCues("never mock src/lib/auth.ts in unit tests.");
    expect(cues.has("auth.ts")).toBe(true);
    expect(cues.has("src")).toBe(true);
    expect(cues.has("lib")).toBe(true);
    expect(cues.has("src/lib")).toBe(true);

    withMem((mem) => {
      mem.observe([{ role: "user", content: "Never mock src/lib/auth.ts in unit tests." }]);
      expect(hasText(mem, "src/lib/auth.ts")).toBe(true);
      expect(mem.notesFor("auth.ts").some((r) => /auth\.ts/i.test(r.text))).toBe(true);
    });
  });

  test("desired: dotted filename auth.ts is a first-class path cue", () => {
    const slashed = pathCues("never mock src/lib/auth.ts in unit tests.");
    expect(slashed.has("auth.ts")).toBe(true);
    const bare = pathCues("the flake is in auth.ts");
    expect(bare.has("auth.ts")).toBe(true);
  });
});

describe("M1.3 (3) Auth is failing deletes Clerk", () => {
  test("today: status copula does not share the identity subject key", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      expect(hasText(mem, "Clerk")).toBe(true);
      mem.observe([{ role: "user", content: "Auth is failing" }]);
      expect(hasText(mem, "Clerk")).toBe(true);
      expect(hasText(mem, "failing")).toBe(true);
    });
  });

  test("desired: Clerk remains after Auth is failing", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      mem.observe([{ role: "user", content: "Auth is failing" }]);
      expect(hasText(mem, "Clerk")).toBe(true);
    });
  });
});

describe("M1.3 (4) Anthropic retrieve then observe", () => {
  const fact = "Auth is Clerk";

  test("Anthropic and OpenAI retrieve before observe (no this-turn echo)", () => {
    withMem((mem) => {
      const injected = mem.inject([{ role: "user", content: fact }]);
      expect(memorySystemText(injected)).not.toContain("Clerk");
      expect(hasText(mem, "Clerk")).toBe(true);
    });

    const anthropic = withKnowFactsAnthropic({ messages: [{ role: "user", content: fact }] });
    expect(anthropicMemoryText(anthropic)).not.toContain("Clerk");
  });
});

describe("M1.3 injectBody system observe", () => {
  test("today: injectBody still observes body.system as a user turn (after inject; fail-open catch wraps it)", () => {
    expect(INDEX_SRC).toMatch(/injectBody[\s\S]*observe\(typeof sys === "string" \? \[\{ role: "user"/);
    expect(INDEX_SRC).toMatch(/injectBody[\s\S]*catch \{\s*memoryInjectSwallows\.n\+\+/);
  });
});

describe("M1.3 (5) sal=0.6 pin + notesFor cues", () => {
  const weak = "We changed the timeout in the worker.";

  // WAVE-FIX: M5.3
  test.failing("sal=0.6 is persist-pinned through 2000 eviction-pressure remembers", () => {
    withMem((mem) => {
      const rec = mem.remember(weak);
      expect(rec.sal).toBe(0.6);
      mem.quiet(() => {
        for (let n = 1; n <= 2000; n++) {
          mem.remember(`Fact number ${n} is recorded here for eviction pressure.`);
        }
      });
      expect(mem.memories().length).toBe(2000);
      expect(mem.memories().some((r) => r.id === rec.id)).toBe(true);
      expect(hasText(mem, "timeout in the worker")).toBe(true);
    });
  }, 60_000);

  test.failing("notesFor clone keeps cues so intention text stays verbatim", () => {
    withMem((mem) => {
      mem.remember("Never console.log in production", { kind: "constraint" });
      const hit = mem.notesFor("console.log").find((r) => /console\.log/i.test(r.text));
      expect(hit).toBeTruthy();
      expect(hit!.text).toBe("[rule] Never console.log in production");
      expect(hit!.text).not.toMatch(/never no/i);
      expect(hit!.text).not.toMatch(/Never 0/);
    });
  });

  test.failing("close+reopen still treats intention as verbatim (deriveCues on load)", () => {
    const dir = tmpDir("eden-m53-reload-");
    try {
      const a = openMemory({ dir });
      a.remember("Never console.log in production", { kind: "constraint" });
      a.close();
      const b = openMemory({ dir });
      const hit = b.notesFor("console.log").find((r) => /console\.log/i.test(r.text));
      expect(hit).toBeTruthy();
      expect(hit!.text).toBe("[rule] Never console.log in production");
      expect(hit!.text).not.toMatch(/never no/i);
      expect(hit!.text).not.toMatch(/Never 0/);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
