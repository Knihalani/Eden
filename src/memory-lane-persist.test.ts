/**
 * M17.2: encode-lane survives reload. ICL/narrative are not FIFO-evicted
 * under chat small-talk pressure. Store cap still counts every record.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "./index";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/53

function tmpDir(prefix = "eden-m172-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function jsonlPath(dir: string): string {
  return join(dir, "memories.jsonl");
}

function parseJsonl(dir: string): Array<{ text?: string; lane?: string }> {
  const p = jsonlPath(dir);
  if (!existsSync(p)) return [];
  const rows: Array<{ text?: string; lane?: string }> = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line) continue;
    rows.push(JSON.parse(line) as { text?: string; lane?: string });
  }
  return rows;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("M17.2 lane persist + eviction", () => {
  test("remember lane=icl survives close/reload", () => {
    const dir = tmpDir("eden-m172-remember-");
    try {
      const mem = openMemory({ dir });
      mem.remember("The movie was great. label: 28", { lane: "icl" });
      expect(mem.memories()[0]?.lane).toBe("icl");
      mem.close();
      const again = openMemory({ dir });
      expect(again.memories().some((r) => r.lane === "icl" && r.text === "The movie was great. label: 28")).toBe(true);
      expect(parseJsonl(dir).some((r) => r.lane === "icl")).toBe(true);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("icl lane survives observe close/reload", () => {
    const dir = tmpDir("eden-m172-reload-");
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "The movie was great. label: 28" }]);
      expect(mem.memories()[0]?.lane).toBe("icl");
      mem.close();
      const again = openMemory({ dir });
      expect(again.memories().some((r) => r.lane === "icl" && /label:\s*28/.test(r.text))).toBe(true);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing("old JSONL without lane defaults to chat on load", () => {
    const dir = tmpDir("eden-m172-legacy-");
    try {
      const p = jsonlPath(dir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        p,
        `${JSON.stringify({ id: "m-legacy", text: "CI is GitHub Actions", kind: "fact", tags: [], at: 1 })}\n`,
      );
      const mem = openMemory({ dir });
      expect(mem.memories()[0]?.lane).toBe("chat");
      mem.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing("5900-shot-class ICL atoms survive chat cap pressure", () => {
    const dir = tmpDir("eden-m172-cap-");
    try {
      withEnv({ EDEN_MEMORY_STORE_CAP: "12", EDEN_MEMORY_CAP: "6" }, () => {
        const mem = openMemory({ dir });
        const shots = Array.from({ length: 5 }, (_, i) => `The movie was great. label: ${i + 1}`);
        for (const shot of shots) mem.observe([{ role: "user", content: shot }]);
        mem.quiet(() => {
          for (let n = 1; n <= 40; n++) {
            mem.remember(`Catalog item ${n} is a stored unpinned chat fact.`);
          }
        });
        expect(mem.memories().length).toBeLessThanOrEqual(12);
        for (const shot of shots) {
          expect(mem.memories().some((r) => r.text === shot && r.lane === "icl")).toBe(true);
        }
        mem.close();
        const again = openMemory({ dir });
        expect(again.memories().length).toBeLessThanOrEqual(12);
        for (const shot of shots) {
          expect(again.memories().some((r) => r.text === shot && r.lane === "icl")).toBe(true);
        }
        expect(parseJsonl(dir).filter((r) => r.lane === "icl").length).toBe(5);
        expect(again.notesFor().length).toBeLessThanOrEqual(6);
        again.close();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ICL+narrative over cap still FIFO those lanes; pins still win", () => {
    const dir = tmpDir("eden-m172-overcap-");
    try {
      withEnv({ EDEN_MEMORY_STORE_CAP: "6", EDEN_MEMORY_CAP: "6" }, () => {
        const mem = openMemory({ dir });
        mem.quiet(() => {
          mem.remember("Never print tokens into logs.", { kind: "constraint" });
          mem.remember("Always keep the deploy freeze on Fridays.", { kind: "constraint" });
          for (let i = 1; i <= 8; i++) {
            mem.remember(`Shot catalog exemplar ${i} is stored. label: ${100 + i}`, { lane: "icl" });
          }
        });
        const recs = mem.memories();
        expect(recs.length).toBeLessThanOrEqual(6);
        expect(recs.filter((r) => r.kind === "constraint").length).toBe(2);
        expect(recs.filter((r) => r.lane === "icl").length).toBe(4);
        mem.close();
        const again = openMemory({ dir });
        expect(again.memories().length).toBeLessThanOrEqual(6);
        expect(again.memories().filter((r) => r.kind === "constraint").length).toBe(2);
        expect(again.memories().filter((r) => r.lane === "icl").length).toBe(4);
        again.close();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
