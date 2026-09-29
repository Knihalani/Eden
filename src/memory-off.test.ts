/**
 * M13.4: Honest off switch — core AgentMemory (inject identity / readonly sqlite / scrub).
 * Hook + wrap hosts are covered in their own test files; this isolates openMemory.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_MARK, openMemory } from "./index";

const SESSION = "sess-m132-abc";
const CWD = "/tmp/eden-m132-cwd";
const EMAIL = "kai@example.com";
const SQLITE = "Use sqlite.";
const SQLITE_Q = "What sqlite database do we use?";
const CLERK = "Auth is Clerk";

function tmpDir(prefix = "eden-m13-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function jsonlContents(root: string): string {
  const names = new Set(["memories.jsonl", "semantic.jsonl", "gists.jsonl", "howto.jsonl", "howtos.jsonl", "traces.jsonl"]);
  const chunks: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (names.has(ent.name) || /^howto.*\.jsonl$/i.test(ent.name)) {
        try {
          chunks.push(readFileSync(p, "utf8"));
        } catch {}
      }
    }
  };
  walk(root);
  return chunks.join("\n");
}

function packet(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m === "object" ? (m as { role?: string; content?: unknown }) : {}))
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

describe("M13 AgentMemory off / readonly / on", () => {
  test("off: inject and injectBody are identity; observe does not persist", () => {
    const dir = tmpDir("eden-m13-off-");
    try {
      for (const value of ["0", "off"]) {
        withEnv({ EDEN_MEMORY: value, EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
          const mem = openMemory({ dir });
          const list = [{ role: "user", content: SQLITE_Q }];
          let out: unknown;
          expect(() => {
            out = mem.inject(list);
          }).not.toThrow();
          expect(out).toBe(list);
          expect(out).toEqual([{ role: "user", content: SQLITE_Q }]);
          expect(packet(out as unknown[])).not.toContain(MEMORY_MARK);

          const body = { model: "gpt-4o", messages: list };
          let bodyOut: unknown;
          expect(() => {
            bodyOut = mem.injectBody(body);
          }).not.toThrow();
          expect(bodyOut).toBe(body);
          expect((bodyOut as typeof body).messages).toBe(list);
          expect(JSON.stringify(bodyOut)).not.toMatch(/403/);

          mem.observe([{ role: "user", content: SQLITE }]);
          expect(mem.memories().some((r) => /sqlite/i.test(r.text))).toBe(false);
          mem.close();
        });
      }
      expect(jsonlContents(dir)).not.toMatch(/sqlite/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readonly: existing sqlite [fact] injects; Auth is Clerk is not persisted", () => {
    const dir = tmpDir("eden-m13-ro-");
    try {
      withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
        const mem = openMemory({ dir });
        mem.remember(SQLITE);
        mem.close();
      });
      for (const value of ["readonly", "read-only", "ro"]) {
        withEnv({ EDEN_MEMORY: value, EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
          const mem = openMemory({ dir });
          const list = [{ role: "user", content: SQLITE_Q }];
          const out = mem.inject(list);
          const pkt = packet(out as unknown[]);
          expect(pkt).toContain(MEMORY_MARK);
          expect(pkt).toMatch(/sqlite/i);
          expect(pkt).toMatch(/\[fact(?:\s*·[^\]]*)?\]/);

          mem.observe([{ role: "user", content: CLERK }]);
          mem.remember(CLERK);
          expect(mem.memories().some((r) => /Clerk/i.test(r.text))).toBe(false);
          mem.close();
        });
      }
      expect(jsonlContents(dir)).not.toMatch(/Clerk/i);
      expect(jsonlContents(dir)).toMatch(/sqlite/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("on: unset / 1 / on encode and inject sqlite", () => {
    const dir = tmpDir("eden-m13-on-");
    try {
      for (const value of [undefined, "1", "on"] as const) {
        withEnv({ EDEN_MEMORY: value, EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
          const mem = openMemory({ dir });
          mem.remember(SQLITE);
          const list = [{ role: "user", content: SQLITE_Q }];
          const out = mem.inject(list);
          const pkt = packet(out as unknown[]);
          expect(pkt).toContain(MEMORY_MARK);
          expect(pkt).toMatch(/sqlite/i);
          expect(pkt).toMatch(/\[fact(?:\s*·[^\]]*)?\]/);
          mem.close();
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("observe scrub: session_id, cwd, email absent from jsonl; secrets still redacted", () => {
    const dir = tmpDir("eden-m13-scrub-");
    try {
      withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
        const mem = openMemory({ dir, session: SESSION, project: CWD });
        mem.observe([
          {
            role: "user",
            content: `Use sqlite. Contact ${EMAIL}. cwd ${CWD}. session ${SESSION}. Token sk-abc123XYZ999 ghp_abc123XYZ999`,
          },
        ]);
        mem.close();
      });
      const blob = jsonlContents(dir);
      expect(blob).not.toContain(SESSION);
      expect(blob).not.toContain(CWD);
      expect(blob).not.toContain(EMAIL);
      expect(blob).not.toMatch(/\bsk-/);
      expect(blob).not.toMatch(/\bghp_/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
