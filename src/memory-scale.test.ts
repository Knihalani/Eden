/**
 * 2k-store accuracy / speed / cap. Product k stays 6–10. STORE_CAP default 20,000 (D33, P4.2).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_MARK, memoryStoreCap, openMemory, PACKET_BYTE_CAP, PACKET_BULLET_MAX, sleep } from "./index";
import { SemanticStore } from "./semantic-store";
import { cuesBelowTau } from "../scripts/test-below-tau";

cuesBelowTau();

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/62

const STORE_N = 2000;
const GOLD_I = 42;
const LOCAL_P50 = 24.542;
const MEM0_P50 = 148;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "eden-scale-"));
}

function packetOf(list: unknown[]): string {
  return (Array.isArray(list) ? list : [])
    .flatMap((m) => {
      if (!m || typeof m !== "object") return [];
      const c = (m as { content?: unknown }).content;
      return typeof c === "string" ? [c] : [];
    })
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

function bullets(pkt: string): string[] {
  return pkt.split("\n").filter((l) => /^\s*-\s+/.test(l));
}

function seedOperators(mem: ReturnType<typeof openMemory>, n = STORE_N) {
  mem.quiet(() => {
    for (let i = 0; i < n; i++) {
      const id = String(i).padStart(4, "0");
      mem.observe([{ role: "user", content: `Operator op${id} lives in city c${id}.` }]);
    }
  });
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i),
    hi = Math.ceil(i);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

describe("2k store accuracy and speed", () => {
  test("memoryStoreCap default is 20,000 and distinct from retrieve k", () => {
    const prev = process.env.EDEN_MEMORY_STORE_CAP;
    delete process.env.EDEN_MEMORY_STORE_CAP;
    expect(memoryStoreCap()).toBe(20_000);
    process.env.EDEN_MEMORY_STORE_CAP = "10";
    expect(memoryStoreCap()).toBe(10);
    if (prev === undefined) delete process.env.EDEN_MEMORY_STORE_CAP;
    else process.env.EDEN_MEMORY_STORE_CAP = prev;
  });

  test("buried op0042 is the gold; recency clones stay out; packet bounded", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      seedOperators(mem);
      const cue = `Where does operator op${String(GOLD_I).padStart(4, "0")} live?`;
      const pkt = packetOf(mem.inject([{ role: "user", content: cue }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/c0042/);
      expect(pkt).not.toMatch(/c1993/);
      expect(pkt).not.toMatch(/c1983/);
      expect(bullets(pkt).length).toBeLessThanOrEqual(PACKET_BULLET_MAX);
      expect(Buffer.byteLength(pkt, "utf8")).toBeLessThanOrEqual(PACKET_BYTE_CAP);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2k inject p50 beats dated 24.5 ms and Mem0 148 ms; JSONL under 1.04 MB", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      seedOperators(mem);
      const cue = `Where does operator op${String(GOLD_I).padStart(4, "0")} live?`;
      mem.inject([{ role: "user", content: cue }]);
      const times: number[] = [];
      let last = "";
      for (let i = 0; i < 40; i++) {
        const t0 = performance.now();
        last = packetOf(mem.inject([{ role: "user", content: cue }]));
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const p50 = pct(times, 50);
      expect(last).toMatch(/c0042/);
      expect(p50).toBeLessThan(LOCAL_P50);
      expect(p50).toBeLessThan(MEM0_P50);
      const jsonl = join(dir, "memories.jsonl");
      expect(statSync(jsonl).size).toBeLessThan(1_037_914);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("xyzzy math chatter stay silent on a full store", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      seedOperators(mem);
      mem.observe([{ role: "user", content: "Auth is Clerk." }]);
      for (const cue of ["xyzzy qwerty asdfgh", "got it", "what's 2+2?"]) {
        expect(packetOf(mem.inject([{ role: "user", content: cue }]))).not.toContain(MEMORY_MARK);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.failing("Clerk still injects beside 2k operators; STOP tags are not persisted", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      seedOperators(mem);
      mem.observe([{ role: "user", content: "Auth is Clerk." }]);
      const pkt = packetOf(mem.inject([{ role: "user", content: "what is auth" }]));
      expect(pkt).toMatch(/Clerk/);
      const clerk = mem.memories().find((r) => /Clerk/i.test(r.text));
      expect(clerk).toBeTruthy();
      expect(clerk!.tags!.some((t) => t === "the" || t === "is" || t === "in")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sqlite instead-of postgres still LWW after 2k distractors; failing is not a delete", async () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      seedOperators(mem);
      mem.observe([{ role: "user", content: "The database is postgres." }]);
      mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);
      await sleep({ dir, mem });
      const live = new SemanticStore(dir).get("database", "is");
      expect(String(live?.o ?? "")).toMatch(/sqlite/i);
      const pkt = packetOf(mem.inject([{ role: "user", content: "what database do we use" }]));
      expect(pkt).toMatch(/sqlite/i);
      expect(pkt).not.toMatch(/postgres/i);

      mem.observe([{ role: "user", content: "Auth is Clerk." }]);
      mem.observe([{ role: "user", content: "Auth is failing." }]);
      await sleep({ dir, mem });
      const auth = packetOf(mem.inject([{ role: "user", content: "what is auth" }]));
      expect(auth).toMatch(/Clerk/);
      expect(String(new SemanticStore(dir).get("auth provider", "is")?.o ?? "")).toMatch(/Clerk/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sleep heat does not drop the operator episode", async () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "Operator op0042 lives in city c0042." }]);
      await sleep({ dir, mem });
      expect(mem.memories().some((r) => /op0042/.test(r.text))).toBe(true);
      expect(existsSync(join(dir, "memories.jsonl"))).toBe(true);
      expect(readFileSync(join(dir, "memories.jsonl"), "utf8")).toMatch(/op0042/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
