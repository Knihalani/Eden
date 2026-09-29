/**
 * M34.1 persist WAL: append-only memories.jsonl.wal, compact under lock,
 * load merges JSONL then WAL (same id replaces). Fail-open on torn lines.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_WAL_COMPACT_LINES,
  memoryWalPath,
  openMemory,
} from "./index";

function tmpDir(prefix = "eden-m341-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function jsonlPath(dir: string): string {
  return join(dir, "memories.jsonl");
}

describe("M34.1 WAL", () => {
  test("MEMORY_WAL_COMPACT_LINES is 32 and wal path is memories.jsonl.wal", () => {
    expect(MEMORY_WAL_COMPACT_LINES).toBe(32);
    expect(memoryWalPath("/tmp/memories.jsonl")).toBe("/tmp/memories.jsonl.wal");
  });

  test("first persist with no JSONL writes the snapshot (hooks still see jsonl)", () => {
    const dir = tmpDir("eden-m341-first-");
    try {
      const mem = openMemory({ dir });
      mem.remember("CI is GitHub Actions");
      const jsonl = jsonlPath(dir);
      const wal = memoryWalPath(jsonl);
      expect(existsSync(jsonl)).toBe(true);
      expect(existsSync(wal)).toBe(false);
      expect(readFileSync(jsonl, "utf8")).toMatch(/GitHub Actions/);
      mem.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WAL-append before compact: a new openMemory reloads the records", () => {
    const dir = tmpDir("eden-m341-reload-");
    try {
      const seed = openMemory({ dir });
      seed.remember("Seed catalog header is a stored unpinned fact.");
      seed.close();
      expect(existsSync(jsonlPath(dir))).toBe(true);

      const mem = openMemory({ dir });
      mem.quiet(() => {
        for (let n = 1; n <= 5; n++) mem.remember(`Catalog widget ${n} is a stored unpinned fact.`);
      });
      const wal = memoryWalPath(jsonlPath(dir));
      expect(existsSync(wal)).toBe(true);
      const walN = readFileSync(wal, "utf8").split("\n").filter(Boolean).length;
      expect(walN).toBe(5);
      expect(walN).toBeLessThan(MEMORY_WAL_COMPACT_LINES);

      const again = openMemory({ dir });
      expect(again.memories().length).toBe(6);
      expect(again.memories().some((r) => /widget 3/.test(r.text))).toBe(true);
      again.close();
      mem.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("compact truncates WAL; reload still has records", () => {
    const dir = tmpDir("eden-m341-compact-");
    try {
      const mem = openMemory({ dir });
      mem.quiet(() => {
        for (let n = 1; n <= MEMORY_WAL_COMPACT_LINES; n++) {
          mem.remember(`Compact slot ${n} is a stored unpinned fact.`);
        }
      });
      const jsonl = jsonlPath(dir);
      const wal = memoryWalPath(jsonl);
      expect(existsSync(jsonl)).toBe(true);
      expect(existsSync(wal)).toBe(false);
      const n = readFileSync(jsonl, "utf8").split("\n").filter(Boolean).length;
      expect(n).toBe(MEMORY_WAL_COMPACT_LINES);
      mem.close();

      const again = openMemory({ dir });
      expect(again.memories().length).toBe(MEMORY_WAL_COMPACT_LINES);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("close compact writes JSONL and drops WAL", () => {
    const dir = tmpDir("eden-m341-close-");
    try {
      const seed = openMemory({ dir });
      seed.remember("Seed catalog header is a stored unpinned fact.");
      seed.close();
      const mem = openMemory({ dir });
      mem.remember("CI is GitHub Actions");
      const wal = memoryWalPath(jsonlPath(dir));
      expect(existsSync(wal)).toBe(true);
      mem.close();
      expect(existsSync(wal)).toBe(false);
      const blob = readFileSync(jsonlPath(dir), "utf8");
      expect(blob).toMatch(/GitHub Actions/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WAL same-id replaces in place; new ids append", () => {
    const dir = tmpDir("eden-m341-replace-");
    try {
      const jsonl = jsonlPath(dir);
      writeFileSync(jsonl, [
        JSON.stringify({ id: "a", text: "Auth is Clerk", kind: "fact", tags: [], at: 1 }),
        JSON.stringify({ id: "b", text: "CI is GitHub Actions", kind: "fact", tags: [], at: 2 }),
      ].join("\n") + "\n");
      writeFileSync(memoryWalPath(jsonl), JSON.stringify({
        id: "a", text: "Auth is WorkOS", kind: "fact", tags: [], at: 3,
      }) + "\n" + JSON.stringify({
        id: "c", text: "Postgres is the session store", kind: "fact", tags: [], at: 4,
      }) + "\n");
      const mem = openMemory({ dir });
      const rows = mem.memories();
      expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
      expect(rows[0]?.text).toBe("Auth is WorkOS");
      expect(rows[1]?.text).toBe("CI is GitHub Actions");
      mem.close();
      expect(existsSync(memoryWalPath(jsonl))).toBe(false);
      const again = openMemory({ dir });
      expect(again.memories().map((r) => r.id)).toEqual(["a", "b", "c"]);
      expect(again.memories()[0]?.text).toBe("Auth is WorkOS");
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("torn WAL line is skipped; valid neighbors load", () => {
    const dir = tmpDir("eden-m341-torn-");
    try {
      const jsonl = jsonlPath(dir);
      writeFileSync(jsonl, `${JSON.stringify({
        id: "m-ci",
        text: "CI is GitHub Actions",
        kind: "fact",
        tags: [],
        at: 1,
      })}\n`);
      writeFileSync(memoryWalPath(jsonl), `${JSON.stringify({
        id: "m-auth",
        text: "Auth is Clerk",
        kind: "fact",
        tags: [],
        at: 2,
      })}\n{"id":"x","text":"torn\n${JSON.stringify({
        id: "m-pg",
        text: "Postgres is the session store",
        kind: "fact",
        tags: [],
        at: 3,
      })}\n`);
      const mem = openMemory({ dir });
      const ids = mem.memories().map((r) => r.id).sort();
      expect(ids).toEqual(["m-auth", "m-ci", "m-pg"]);
      expect(mem.memories().some((r) => /torn/.test(r.text))).toBe(false);
      mem.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("torn WAL without trailing newline does not glue the next append", () => {
    const dir = tmpDir("eden-m341-torn-glue-");
    try {
      const jsonl = jsonlPath(dir);
      const seed = openMemory({ dir });
      seed.remember("Seed catalog header is a stored unpinned fact.");
      seed.close();
      writeFileSync(memoryWalPath(jsonl), '{"id":"x","text":"torn');
      const mem = openMemory({ dir });
      mem.remember("CI is GitHub Actions");
      mem.close();
      const again = openMemory({ dir });
      expect(again.memories().some((r) => /GitHub Actions/.test(r.text))).toBe(true);
      expect(again.memories().some((r) => /torn/.test(r.text))).toBe(false);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WAL append redacts secrets", () => {
    const dir = tmpDir("eden-m341-secret-");
    try {
      const seed = openMemory({ dir });
      seed.remember("Seed catalog header is a stored unpinned fact.");
      seed.close();
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "The deploy token is sk-abc123XYZ999" }]);
      mem.observe([{ role: "user", content: "FAIL src/auth.test.ts sk-abc123XYZ999 ghp_abc123XYZ999" }]);
      const wal = memoryWalPath(jsonlPath(dir));
      expect(existsSync(wal)).toBe(true);
      const blob = readFileSync(wal, "utf8");
      expect(blob).not.toMatch(/\bsk-/);
      expect(blob).not.toMatch(/\bghp_/);
      mem.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
