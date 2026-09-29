/**
 * M2.1 encode: ordinary agent language, fences, git/bun lines are stored.
 * Secrets stay redacted. Chat fillers stay dropped.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "./index";

function withMem(fn: (mem: ReturnType<typeof openMemory>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "eden-m21-"));
  try {
    fn(openMemory({ dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stored(mem: ReturnType<typeof openMemory>): string {
  return mem.memories().map((r) => r.text).join("\n");
}

function has(mem: ReturnType<typeof openMemory>, needle: string): boolean {
  const n = needle.toLowerCase();
  return mem.memories().some((r) => r.text.toLowerCase().includes(n));
}

describe("M2.1 extractDurable stores agent language", () => {
  test("Please fix the flake in auth.test.ts is stored", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "Please fix the flake in auth.test.ts" }]);
      expect(has(mem, "Please fix the flake in auth.test.ts")).toBe(true);
    });
  });

  test("fix the flake in auth.test.ts is stored", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "fix the flake in auth.test.ts" }]);
      expect(has(mem, "fix the flake in auth.test.ts")).toBe(true);
    });
  });

  test("we need to bump the timeout in the worker is stored", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "we need to bump the timeout in the worker." }]);
      expect(has(mem, "we need to bump the timeout in the worker")).toBe(true);
    });
  });

  test("fenced test failure is stored", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "```\nFAIL src/auth.test.ts\n```" }]);
      expect(has(mem, "FAIL src/auth.test.ts")).toBe(true);
    });
  });

  test("git rev-parse line is stored", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "git rev-parse HEAD\nabc1234" }]);
      expect(has(mem, "git rev-parse HEAD")).toBe(true);
      expect(has(mem, "abc1234")).toBe(true);
    });
  });

  test("bun test line is stored", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "bun test src/auth.test.ts" }]);
      expect(has(mem, "bun test src/auth.test.ts")).toBe(true);
    });
  });

  test("secrets are not stored", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "The deploy token is sk-abc123XYZ999" }]);
      mem.observe([{ role: "user", content: "The github token is ghp_abc123XYZ999" }]);
      mem.observe([{ role: "user", content: "OAuth token gho_abc123XYZ999 stays private." }]);
      mem.observe([{ role: "user", content: "Fine-grained github_pat_abc123XYZ999 must not persist." }]);
      mem.observe([{ role: "user", content: "AWS key AKIAIOSFODNN7EXAMPLE is secret." }]);
      const blob = stored(mem);
      expect(blob).not.toMatch(/\bsk-/);
      expect(blob).not.toMatch(/\bghp_/);
      expect(blob).not.toMatch(/\bgho_/);
      expect(blob).not.toMatch(/\bgithub_pat_/);
      expect(blob).not.toMatch(/\bAKIA/);
    });
  });

  test("FAIL next to a secret is stored with the token redacted", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "FAIL src/auth.test.ts sk-abc123XYZ999 ghp_abc123XYZ999" }]);
      expect(has(mem, "FAIL src/auth.test.ts")).toBe(true);
      const blob = stored(mem);
      expect(blob).not.toMatch(/\bsk-/);
      expect(blob).not.toMatch(/\bghp_/);
    });
  });

  test("password is VALUE does not persist; Auth is Clerk still does", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "We decided the admin password is hunter2secret99" }]);
      mem.observe([{ role: "user", content: "Auth is Clerk." }]);
      const blob = stored(mem);
      expect(blob).not.toContain("hunter2secret99");
      expect(blob).toMatch(/password is \[REDACTED\]/i);
      expect(blob).toMatch(/Clerk/i);
      for (const r of mem.memories()) {
        expect(JSON.stringify(r.ctx ?? {})).not.toContain("hunter2secret99");
      }
    });
  });

  test("ok thanks chatter is not stored", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "ok thanks" }]);
      expect(has(mem, "ok thanks")).toBe(false);
      expect(mem.memories()).toEqual([]);
    });
  });

  test("Can you please fix the flake in auth.test.ts is stored", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "Can you please fix the flake in auth.test.ts" }]);
      expect(has(mem, "flake in auth.test.ts")).toBe(true);
    });
  });

  test("Please fix the flake in auth.test.ts? is stored", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "Please fix the flake in auth.test.ts?" }]);
      expect(has(mem, "Please fix the flake in auth.test.ts")).toBe(true);
    });
  });
});
