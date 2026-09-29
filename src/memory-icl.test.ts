/**
 * M19.1 ICL index. Diversity at k=10 is load-bearing (Mem0 MCC 32.4).
 * Not BrainMemory. Does not import src/index.ts (hay banned).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ICL_RETRIEVE_K, IclIndex, retrieveIcl } from "./icl-index";

const INDEX_SRC = readFileSync(join(import.meta.dir, "icl-index.ts"), "utf8");

function codeWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function tmpDir(prefix = "eden-m191-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function jsonlLines(dir: string): string[] {
  const p = join(dir, "icl.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0);
}

function parseJsonl(dir: string): unknown[] {
  const out: unknown[] = [];
  for (const line of jsonlLines(dir)) {
    out.push(JSON.parse(line));
  }
  return out;
}

describe("M19.1 ICL index does not import BrainMemory", () => {
  test("icl-index.ts does not import BrainMemory, hay, extract, or graph", () => {
    const code = codeWithoutComments(INDEX_SRC);
    expect(code).not.toMatch(/\bBrainMemory\b/);
    expect(code).not.toMatch(/brain-memory/);
    expect(code).not.toMatch(/\bqueryHay\b/);
    expect(code).not.toMatch(/\bextractDurable\b/);
    expect(code).not.toMatch(/\bcomplete\s*\(/);
    expect(code).not.toMatch(/\bgraphrag\b/i);
    expect(code).not.toMatch(/\bfrom\s+['"]\.\/index['"]/);
    expect(code).not.toMatch(/\bfrom\s+['"]\.\/brain-memory['"]/);
  });
});

describe("M19.1 store-all keeps label:", () => {
  test("stored text still contains label:", () => {
    const dir = tmpDir("eden-m191-label-");
    try {
      const store = new IclIndex(dir);
      const shot = "The movie was great. label: 28";
      const minted = store.put(shot);
      expect(minted.length).toBe(1);
      expect(minted[0]!.text).toContain("label: 28");
      expect(store.all()[0]!.text).toContain("label: 28");
      expect(jsonlLines(dir).join("\n")).toMatch(/label:\s*28/);
      const hits = retrieveIcl(dir, "The movie was great. label:");
      expect(hits.some((h) => /label:\s*28/.test(h.text))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one put is one record, not 512-chunked", () => {
    const dir = tmpDir("eden-m191-one-");
    try {
      const store = new IclIndex(dir);
      const long =
        `${"word ".repeat(600)}Classify this review. Excellent acting. label: 28`.trim();
      expect(store.put(long).length).toBe(1);
      expect(store.all().length).toBe(1);
      expect(store.all()[0]!.text).toMatch(/label:\s*28/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M19.1 empty cue", () => {
  test("empty cue → [] (no dump)", () => {
    const dir = tmpDir("eden-m191-empty-");
    try {
      const store = new IclIndex(dir);
      store.put("Classify this review. Excellent acting. label: 28");
      expect(store.all().length).toBe(1);
      expect(retrieveIcl(dir, "")).toEqual([]);
      expect(retrieveIcl(dir, "   ")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M19.1 concurrent puts do not tear", () => {
  test("two puts, all() still valid JSONL", () => {
    const dir = tmpDir("eden-m191-conc-");
    try {
      const a = new IclIndex(dir);
      const b = new IclIndex(dir);
      a.put("Classify this review. Excellent acting. item a. label: 28", { t: 1 });
      b.put("Classify this review. Excellent acting. item b. label: 7", { t: 2 });
      expect(() => parseJsonl(dir)).not.toThrow();
      const rows = parseJsonl(dir);
      expect(rows.length).toBe(2);
      for (const rec of rows) {
        expect(rec).toEqual(expect.objectContaining({ id: expect.any(String), text: expect.any(String) }));
      }
      const all = new IclIndex(dir).all();
      expect(all.length).toBe(2);
      expect(all.some((r) => /label:\s*28/.test(r.text))).toBe(true);
      expect(all.some((r) => /label:\s*7/.test(r.text))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parallel puts stay valid JSONL", async () => {
    const dir = tmpDir("eden-m191-par-");
    try {
      await Promise.all([
        Promise.resolve(new IclIndex(dir).put("shot alpha. label: 28", { t: 1 })),
        Promise.resolve(new IclIndex(dir).put("shot bravo. label: 7", { t: 2 })),
      ]);
      expect(() => parseJsonl(dir)).not.toThrow();
      const all = new IclIndex(dir).all();
      expect(all.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M19.1 100+1 label diversity", () => {
  test("100 shots one class + 1 gold other class → gold in k=10", () => {
    const dir = tmpDir("eden-m191-div-");
    try {
      const store = new IclIndex(dir);
      for (let i = 0; i < 100; i++) {
        store.put(
          `Classify this review. Excellent acting and a moving plot about family. item ${i}. label: 28`,
          { t: i + 1 },
        );
      }
      store.put(
        "Classify this review. Excellent acting and a moving plot about family. item gold. label: 7",
        { t: 101 },
      );
      expect(store.all().length).toBe(101);
      expect(ICL_RETRIEVE_K).toBe(10);
      const cue = "Classify this review. Excellent acting and a moving plot about family. label:";
      const hits = retrieveIcl(dir, cue, { k: 10 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThanOrEqual(10);
      const blob = hits.map((h) => h.text).join("\n");
      expect(blob).toMatch(/label:\s*7/);
      expect(hits.some((h) => /label:\s*7/.test(h.text))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("100 near-dup majority label: 28 + 1 gold label: 7 → gold still in k=10 after dedup", () => {
    const dir = tmpDir("eden-m393-neardup-");
    try {
      const store = new IclIndex(dir);
      for (let i = 0; i < 100; i++) {
        store.put(
          `Classify this review. Excellent acting and a moving plot about family. take ${i}. label: 28`,
          { t: i + 1 },
        );
      }
      store.put(
        "Classify this review. Excellent acting and a moving plot about family. take gold. label: 7",
        { t: 101 },
      );
      const cue = "Classify this review. Excellent acting and a moving plot about family. label:";
      let hits: ReturnType<typeof retrieveIcl> = [];
      expect(() => {
        hits = retrieveIcl(dir, cue, { k: 10 });
      }).not.toThrow();
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThanOrEqual(10);
      expect(hits.some((h) => /label:\s*7/.test(h.text))).toBe(true);
      const majority = hits.filter((h) => /label:\s*28\b/.test(h.text));
      expect(majority.length).toBe(1);
      const ids = new Set(hits.map((h) => h.id));
      const texts = [...new Set(hits.map((h) => h.text))];
      expect(ids.size).toBe(hits.length);
      expect(texts.length).toBeGreaterThan(1);
      const labels = new Set(
        hits.map((h) => h.text.match(/label:\s*(\S+)/i)?.[1]?.replace(/[.,;:!?]+$/g, "") ?? ""),
      );
      const goldAmongUnique = texts.some((t) => /label:\s*7/.test(t));
      expect(labels.size > 1 || goldAmongUnique).toBe(true);
      expect(goldAmongUnique).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("10 exact majority clones + 1 gold other-class → gold still in k=10", () => {
    const dir = tmpDir("eden-m393-clones-");
    try {
      const store = new IclIndex(dir);
      const majority = "Classify this review. Excellent acting and a moving plot about family. same shot. label: 28";
      for (let i = 0; i < 10; i++) store.put(majority, { t: i + 1 });
      store.put(
        "Classify this review. Excellent acting and a moving plot about family. same shot. label: 7",
        { t: 11 },
      );
      expect(store.all().length).toBe(11);
      const cue = "Classify this review. Excellent acting and a moving plot about family. label:";
      let hits: ReturnType<typeof retrieveIcl> = [];
      expect(() => {
        hits = retrieveIcl(dir, cue, { k: 10 });
      }).not.toThrow();
      expect(hits.length).toBeLessThanOrEqual(10);
      expect(hits.some((h) => /label:\s*7/.test(h.text))).toBe(true);
      const labels = hits.map((h) => h.text.match(/label:\s*(\S+)/i)?.[1]?.replace(/[.,;:!?]+$/g, "") ?? "");
      expect(labels.filter((l) => l === "28").length).toBe(1);
      expect(labels.filter((l) => l === "7").length).toBe(1);
      expect(hits.length).toBe(2);
      const texts = [...new Set(hits.map((h) => h.text))];
      expect(texts.some((t) => /label:\s*7/.test(t))).toBe(true);
      expect(new Set(hits.map((h) => h.id)).size).toBe(hits.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("k is capped at 10 even if 40 is requested", () => {
    const dir = tmpDir("eden-m191-k-");
    try {
      const store = new IclIndex(dir);
      for (let i = 0; i < 20; i++) {
        store.put(`Classify this review. item ${i}. label: ${i}`, { t: i });
      }
      expect(retrieveIcl(dir, "Classify this review. label:", { k: 40 }).length).toBeLessThanOrEqual(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M19.1 fallback + fail-open", () => {
  test("empty icl.jsonl uses lane=icl fallback with the same diversity", () => {
    const dir = tmpDir("eden-m191-fb-");
    try {
      const fallback = [
        ...Array.from({ length: 100 }, (_, i) => ({
          text: `Classify this review. Excellent acting and a moving plot about family. item ${i}. label: 28`,
          id: `maj-${i}`,
          at: i,
          lane: "icl",
        })),
        {
          text: "Classify this review. Excellent acting and a moving plot about family. item gold. label: 7",
          id: "gold",
          at: 101,
          lane: "icl",
        },
      ];
      const cue = "Classify this review. Excellent acting and a moving plot about family. label:";
      const hits = retrieveIcl(dir, cue, { k: 10, fallback });
      expect(hits.some((h) => /label:\s*7/.test(h.text))).toBe(true);
      expect(hits.length).toBeLessThanOrEqual(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("torn icl.jsonl does not throw; secrets are scrubbed", () => {
    const dir = tmpDir("eden-m191-tear-");
    try {
      const store = new IclIndex(dir);
      expect(() => {
        store.put("The movie was great. label: 28 token sk-abc123XYZ999 ghp_abc123XYZ999");
      }).not.toThrow();
      const blob = `${jsonlLines(dir).join("\n")}\n${store.all().map((r) => r.text).join("\n")}`;
      expect(blob).toMatch(/label:\s*28/);
      expect(blob).not.toContain("sk-abc123XYZ999");
      expect(blob).not.toContain("ghp_abc123XYZ999");
      writeFileSync(join(dir, "icl.jsonl"), "{not json\n{\"id\":\"x\",\"text\":\n", "utf8");
      expect(() => store.all()).not.toThrow();
      expect(() => retrieveIcl(dir, "The movie was great. label:")).not.toThrow();
      expect(retrieveIcl(dir, "The movie was great. label:")).toEqual([]);
      writeFileSync(
        join(dir, "icl.jsonl"),
        "{torn\n{\"id\":\"keep\",\"text\":\"Classify this review. label: 7\",\"t\":1}\n{\"id\":\"bad\",\"text\":\n",
        "utf8",
      );
      expect(() => store.all()).not.toThrow();
      const kept = store.all();
      expect(kept.some((r) => /label:\s*7/.test(r.text))).toBe(true);
      expect(() => retrieveIcl(dir, "Classify this review. label:")).not.toThrow();
      expect(retrieveIcl(dir, "Classify this review. label:").some((h) => /label:\s*7/.test(h.text))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
