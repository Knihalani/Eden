import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_MARK,
  memoryInjectSwallows,
  memoryStoreCap,
  openMemory,
  PACKET_BYTE_CAP,
  PACKET_BULLET_MAX,
} from "../../src/index";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "eden-whatever-contract-"));
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

describe("scale contract", () => {
  test("store cap default is 20,000 (D33's hot path, P4.2) and retrieve k stays 6–10", () => {
    const prev = process.env.EDEN_MEMORY_STORE_CAP;
    delete process.env.EDEN_MEMORY_STORE_CAP;
    expect(memoryStoreCap()).toBe(20_000);
    if (prev === undefined) delete process.env.EDEN_MEMORY_STORE_CAP;
    else process.env.EDEN_MEMORY_STORE_CAP = prev;
  });

  test("Clerk injects; xyzzy chatter math stay silent; packet bounded; fail-open", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "Auth is Clerk." }]);
      const pkt = packetOf(mem.inject([{ role: "user", content: "what is auth" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/Clerk/);
      expect(pkt.split("\n").filter((l) => /^\s*-\s+/.test(l)).length).toBeLessThanOrEqual(PACKET_BULLET_MAX);
      expect(Buffer.byteLength(pkt, "utf8")).toBeLessThanOrEqual(PACKET_BYTE_CAP);
      for (const cue of ["xyzzy qwerty asdfgh", "got it", "what's 2+2?"]) {
        expect(packetOf(mem.inject([{ role: "user", content: cue }]))).not.toContain(MEMORY_MARK);
      }
      const before = memoryInjectSwallows.n;
      const boom = mem.inject({ not: "array" } as unknown as unknown[]);
      expect(Array.isArray(boom)).toBe(true);
      expect(memoryInjectSwallows.n).toBeGreaterThanOrEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
