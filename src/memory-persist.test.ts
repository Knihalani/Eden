/**
 * M5.1 persist: file lock, atomic JSONL write, store cap ≠ retrieve k.
 * Pin salience threshold is M5.3 — this file does not assert sal=0.6 pinning.
 */
import { describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "./index";

const INDEX = join(import.meta.dir, "index.ts");

function tmpDir(prefix = "eden-m51-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function jsonlPath(dir: string): string {
  return join(dir, "memories.jsonl");
}

function parseJsonl(dir: string): unknown[] {
  const out: unknown[] = [];
  const idx = new Map<string, number>();
  const ingest = (p: string, overlay: boolean) => {
    if (!existsSync(p)) return;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line) continue;
      let rec: { id?: string };
      try { rec = JSON.parse(line) as { id?: string }; } catch { continue; }
      const id = typeof rec?.id === "string" ? rec.id : undefined;
      if (!id) continue;
      const at = idx.get(id);
      if (overlay && at != null) out[at] = rec;
      else {
        idx.set(id, out.length);
        out.push(rec);
      }
    }
  };
  ingest(jsonlPath(dir), false);
  ingest(`${jsonlPath(dir)}.wal`, true);
  return out;
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

async function persistChild(dir: string, tag: string): Promise<number> {
  const src = `
    import { openMemory } from ${JSON.stringify(INDEX)};
    const mem = openMemory({ dir: process.env.EDEN_M51_DIR });
    const tag = process.env.EDEN_M51_TAG;
    mem.quiet(() => {
      for (let i = 0; i < 40; i++) {
        mem.remember("Concurrent " + tag + " record " + i + " is a catalogued durable fact.");
      }
    });
    mem.close();
  `;
  const env = { ...process.env, EDEN_M51_DIR: dir, EDEN_M51_TAG: tag };
  delete env.EDEN_MEMORY_STORE_CAP;
  const proc = Bun.spawn(["bun", "-e", src], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`persist child ${tag} exited ${code}: ${err}`);
  }
  return code;
}

describe("M5.1 concurrent persist", () => {
  test("two overlapping persists do not tear JSONL", async () => {
    const dir = tmpDir("eden-m51-lock-");
    try {
      const [a, b] = await Promise.all([persistChild(dir, "alpha"), persistChild(dir, "bravo")]);
      expect(a).toBe(0);
      expect(b).toBe(0);
      const rows = parseJsonl(dir);
      expect(rows).toHaveLength(80);
      const text = rows.map((rec) => String((rec as { text?: string }).text ?? "")).join("\n");
      expect(text).toContain("Concurrent alpha record 0");
      expect(text).toContain("Concurrent bravo record 0");
      for (const rec of rows) {
        expect(rec).toEqual(expect.objectContaining({ id: expect.any(String), text: expect.any(String) }));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("stale instance close merges records appended after it opened", () => {
    const dir = tmpDir("eden-m51-stale-close-");
    try {
      const first = openMemory({ dir });
      const stale = openMemory({ dir });
      first.remember("Alpha catalog entry is durable.", { id: "alpha" });
      stale.remember("Bravo catalog entry is durable.", { id: "bravo" });
      stale.close();
      expect(parseJsonl(dir).map((r) => (r as { id?: string }).id).sort()).toEqual(["alpha", "bravo"]);
      first.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M5.1 EDEN_MEMORY_CAP is retrieve k", () => {
  test("CAP=6 stores more than 6; notesFor still returns ≤6", () => {
    const dir = tmpDir("eden-m51-k-");
    try {
      withEnv({ EDEN_MEMORY_CAP: "6", EDEN_MEMORY_STORE_CAP: undefined }, () => {
        const mem = openMemory({ dir });
        mem.quiet(() => {
          for (let n = 1; n <= 20; n++) {
            mem.remember(`Widget slot ${n} belongs to the alpha catalog.`);
          }
        });
        expect(mem.memories().length).toBeGreaterThan(6);
        expect(mem.memories().length).toBe(20);
        expect(parseJsonl(dir).length).toBe(20);
        expect(mem.notesFor().length).toBeLessThanOrEqual(6);
        expect(mem.notesFor("alpha catalog").length).toBeLessThanOrEqual(6);
        mem.close();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M5.1 EDEN_MEMORY_STORE_CAP caps the store", () => {
  test("STORE_CAP=10 keeps ≤10 after writing 15 unpinned facts", () => {
    const dir = tmpDir("eden-m51-store-");
    try {
      withEnv({ EDEN_MEMORY_STORE_CAP: "10", EDEN_MEMORY_CAP: undefined }, () => {
        const mem = openMemory({ dir });
        mem.quiet(() => {
          for (let n = 1; n <= 15; n++) {
            mem.remember(`Catalog item ${n} is a stored unpinned fact.`);
          }
        });
        expect(mem.memories().length).toBeLessThanOrEqual(10);
        expect(parseJsonl(dir).length).toBeLessThanOrEqual(10);
        mem.close();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CAP=6 does not trim the store when STORE_CAP=10 already bounds it", () => {
    const dir = tmpDir("eden-m51-both-");
    try {
      withEnv({ EDEN_MEMORY_STORE_CAP: "10", EDEN_MEMORY_CAP: "6" }, () => {
        const mem = openMemory({ dir });
        mem.quiet(() => {
          for (let n = 1; n <= 15; n++) {
            mem.remember(`Catalog item ${n} is a stored unpinned fact.`);
          }
        });
        expect(mem.memories().length).toBeLessThanOrEqual(10);
        expect(mem.notesFor().length).toBeLessThanOrEqual(6);
        mem.close();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M5.1 persist fail-open + mode + secrets", () => {
  test("lock timeout does not throw into inject", () => {
    const dir = tmpDir("eden-m51-lockwait-");
    const lock = `${jsonlPath(dir)}.lock`;
    let fd: number | undefined;
    try {
      const mem = openMemory({ dir });
      mem.remember("CI is GitHub Actions");
      fd = openSync(lock, "wx");
      const list = [{ role: "user", content: "What GitHub Actions CI do we use?" }];
      let out: unknown;
      expect(() => {
        out = mem.inject(list);
      }).not.toThrow();
      expect(Array.isArray(out)).toBe(true);
      closeSync(fd);
      fd = undefined;
      try { unlinkSync(lock); } catch {}
      mem.close();
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch {}
      try { unlinkSync(lock); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  test("jsonl is 0o600 after persist", () => {
    const dir = tmpDir("eden-m51-mode-");
    try {
      const mem = openMemory({ dir });
      mem.remember("CI is GitHub Actions");
      mem.close();
      expect(statSync(jsonlPath(dir)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("observe redacts secrets in persist JSONL", () => {
    const dir = tmpDir("eden-m51-secret-");
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "The deploy token is sk-abc123XYZ999" }]);
      mem.observe([{ role: "user", content: "FAIL src/auth.test.ts sk-abc123XYZ999 ghp_abc123XYZ999" }]);
      mem.close();
      const blob = readFileSync(jsonlPath(dir), "utf8");
      for (const line of blob.split("\n").filter(Boolean)) JSON.parse(line);
      expect(blob).not.toMatch(/\bsk-/);
      expect(blob).not.toMatch(/\bghp_/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The extracted row was redacted, but the whole-turn episode row and the
  // SemanticStore rows and tombstones it fed kept the raw value (a8370beb5).
  test("whole-turn row and semantic tombstones keep no raw token in any store file", () => {
    const dir = tmpDir("eden-m51-rawrow-");
    const key = "sk-ant-api03-SECRETVALUE99";
    const ghp = "ghp_abc123XYZ999";
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: `The deploy key is ${key}. Auth is Clerk.` }]);
      mem.observe([{ role: "user", content: `The github token is ${ghp}` }]);
      mem.observe([{ role: "user", content: "The deploy key is kept in the vault." }]);
      mem.close();
      const rows = mem.memories().map((r) => r.text);
      expect(rows).toContain("The deploy key is [REDACTED]");
      expect(rows).toContain("The github token is [REDACTED]");
      const semantic = readFileSync(join(dir, "semantic.jsonl"), "utf8");
      expect(semantic).toMatch(/"o":"\[REDACTED\]"[^\n]*"tombstone":true/);
      const files = readdirSync(dir, { recursive: true, encoding: "utf8" });
      const stored = files.filter((f) => statSync(join(dir, f)).isFile());
      expect(stored.length).toBeGreaterThan(0);
      const leaks = stored.filter((f) => {
        const text = readFileSync(join(dir, f), "utf8");
        return text.includes("SECRETVALUE99") || text.includes(ghp);
      });
      expect(leaks).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M5.4 ghost APIs gone from user-facing READMEs", () => {
  test("plugin and package READMEs have no /forget, EDEN_MEMORY_HOST, or :8787 memory HTTP", () => {
    const root = join(import.meta.dir, "..");
    const files = [
      join(root, "plugins/eden-memory/README.md"),
      join(root, "README.md"),
      join(root, "packages/cli/README.md"),
      join(root, "packages/know/README.md"),
      join(root, "packages/sdk-js/README.md"),
      join(root, "packages/sdk-py/README.md"),
    ];
    for (const f of files) {
      const t = readFileSync(f, "utf8");
      expect({ file: f, forget: t.includes("/forget") }).toEqual({ file: f, forget: false });
      expect({ file: f, host: t.includes("EDEN_MEMORY_HOST") }).toEqual({ file: f, host: false });
    }
    const plugin = readFileSync(join(root, "plugins/eden-memory/README.md"), "utf8");
    expect(plugin).not.toMatch(/:8787/);
  });
});
