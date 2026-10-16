/**
 * P0 leftover + P1 sleep: pack, write-time aliases, bi-temporal, sleep NOOP/tombstone.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_MARK,
  memoryInjectSwallows,
  openMemory,
  packNotes,
  goldFirstNotes,
  PACKET_BULLET_MAX,
  PACKET_BYTE_CAP,
  placePathsFrom,
  isNoopCue,
  sleep,
} from "./index";
import { SNAPSHOT_FILE } from "./memory-postings";
import { SemanticStore } from "./semantic-store";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "eden-sota-"));
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

describe("P0 empty-arm and NOOP", () => {
  test("posting miss does not dump the store", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "Auth is Clerk." }]);
      mem.observe([{ role: "user", content: "Use sqlite." }]);
      mem.observe([{ role: "user", content: "Always run tests before committing." }]);
      const pkt = packetOf(mem.inject([{ role: "user", content: "xyzzy qwerty asdfgh" }]));
      expect(pkt).not.toContain(MEMORY_MARK);
      expect(pkt).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("chatter and math stay silent", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "Use sqlite." }]);
      for (const cue of ["got it", "nice", "cool", "will do", "thanks", "what's 2+2?"]) {
        expect(isNoopCue(cue)).toBe(true);
        expect(packetOf(mem.inject([{ role: "user", content: cue }]))).not.toContain(MEMORY_MARK);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inject throw is fail-open", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      const before = memoryInjectSwallows.n;
      const orig = [{ role: "user", content: "Use sqlite." }];
      const out = mem.inject(orig);
      expect(out).toBeDefined();
      const boom = mem.inject({ not: "array" } as unknown as unknown[]);
      expect(Array.isArray(boom)).toBe(true);
      expect(memoryInjectSwallows.n).toBeGreaterThanOrEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("placePathsFrom keeps auth.ts and drops bodies", () => {
    const names = placePathsFrom({
      open_files: ["src/lib/auth.ts"],
      cwd: "/tmp/eden-not-a-place",
      content: "export const SECRET = 1",
    });
    expect(names.some((n) => n.toLowerCase().includes("auth.ts"))).toBe(true);
    expect(names.join(" ")).not.toContain("/tmp/eden-not-a-place");
    expect(placePathsFrom({ files: ["export default function huge() {\n  return 1;\n}"] })).toEqual([]);
    expect(placePathsFrom({ session_id: "auth.ts", email: "dev@eden.dev" })).toEqual([]);
  });
});

describe("P0 pack on inject", () => {
  test("worded packet (D14, the wrap's since P0.7); skip-not-evict; never clips a copula", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "auth.provider is Clerk." }]);
      const pkt = packetOf(mem.inject([{ role: "user", content: "what is auth.provider?" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/^- auth\.provider is Clerk\.? \(just now\)$/m);
      expect(pkt).toMatch(/auth\.provider/i);
      expect(Buffer.byteLength(pkt, "utf8")).toBeLessThanOrEqual(PACKET_BYTE_CAP);
      expect(pkt.split("\n").filter((l) => /^\s*-\s+/.test(l)).length).toBeLessThanOrEqual(PACKET_BULLET_MAX);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("packNotes skips an oversized later fact and keeps a shorter one", () => {
    const huge = "x".repeat(800);
    const packed = packNotes([{ text: `Walked the widget catalog ${huge}` }, { text: "The needle is gold." }], 200, 8);
    expect(packed.some((n) => /needle/.test(n.text))).toBe(true);
    expect(packed.some((n) => n.text.includes(huge))).toBe(false);
  });

  test("live inject skip-not-evict keeps the short sqlite fact", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.remember(`Walked the sqlite catalog ${"x".repeat(800)}`, { kind: "episode", tags: ["sqlite", "catalog"] });
      mem.remember("The session store is sqlite.", { kind: "fact", tags: ["sqlite", "session", "store"] });
      const pkt = packetOf(mem.inject([{ role: "user", content: "what sqlite database do we use?" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/session store is sqlite/i);
      expect(pkt).not.toMatch(/x{40}/);
      expect(pkt.split("\n").filter((l) => /^\s*-\s+/.test(l)).length).toBeLessThanOrEqual(PACKET_BULLET_MAX);
      expect(Buffer.byteLength(pkt, "utf8")).toBeLessThanOrEqual(PACKET_BYTE_CAP);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P0 write-time aliases", () => {
  test("cue tokens are not synonym-expanded; login does not retrieve auth", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "auth.provider is Clerk." }]);
      const pkt = packetOf(mem.inject([{ role: "user", content: "login flow" }]));
      expect(pkt).not.toContain(MEMORY_MARK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dlq cue retrieves the dead-letters row", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "Dead letters are SQS." }]);
      const stored = mem.memories().find((r) => /dead letters/i.test(r.text) || /SQS/i.test(r.text));
      expect(stored).toBeTruthy();
      expect(stored!.tags).toEqual(expect.arrayContaining(["dlq", "sqs", "dead", "letters"]));
      const pkt = packetOf(mem.inject([{ role: "user", content: "dlq" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/SQS|dead letters/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P0 bi-temporal", () => {
  test("old value absent from packet; row still on disk", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "Auth is Clerk." }]);
      mem.observe([{ role: "user", content: "Auth is Auth0." }]);
      const pkt = packetOf(mem.inject([{ role: "user", content: "what is auth?" }]));
      expect(pkt).toMatch(/Auth0/);
      expect(pkt).not.toMatch(/Clerk/);
      const rows = mem.memories();
      expect(rows.some((r) => /Clerk/i.test(r.text))).toBe(true);
      expect(rows.some((r) => /Clerk/i.test(r.text) && typeof r.invalidAt === "number")).toBe(true);
      const disk = readFileSync(join(dir, "memories.jsonl"), "utf8");
      expect(disk).toMatch(/Clerk/);
      expect(disk).toMatch(/Auth0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P0 source id on the bullet", () => {
  test("episode file stays on disk; packet may cite the path", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "The flake is in src/auth.test.ts." }]);
      // A cue that restates the row is its own residual (D26, the wrap's since P0.7): this one names the file only.
      const pkt = packetOf(mem.inject([{ role: "user", content: "src/auth.test.ts failed on main again" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/src\/auth\.test\.ts/);
      expect(readFileSync(join(dir, "memories.jsonl"), "utf8")).toMatch(/src\/auth\.test\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P1 foresight expiry", () => {
  test("stale valid_until drops out of the packet; row stays on disk", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "Use sqlite." }]);
      const stale = mem.remember("The promo code is FALL valid until 2020-01-01.");
      expect(typeof stale.validUntil).toBe("number");
      expect(stale.validUntil!).toBeLessThan(Date.now());
      const promo = packetOf(mem.inject([{ role: "user", content: "what is the promo code?" }]));
      expect(promo).not.toMatch(/FALL/);
      expect(promo).not.toContain(MEMORY_MARK);
      const sqlite = packetOf(mem.inject([{ role: "user", content: "what sqlite database do we use?" }]));
      expect(sqlite).toMatch(/sqlite/i);
      expect(sqlite).not.toMatch(/FALL/);
      expect(readFileSync(join(dir, "memories.jsonl"), "utf8")).toMatch(/FALL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P1 sleep", () => {
  test("same value is NOOP; change tombstones; chatter stays silent", async () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "Auth is Clerk." }]);
      await sleep({ dir, mem });
      const before = new SemanticStore(dir).live().filter((t) => t.s === "auth provider" && t.p === "is");
      expect(before.some((t) => /Clerk/i.test(t.o))).toBe(true);
      mem.remember("Auth is Clerk.");
      await sleep({ dir, mem });
      const again = new SemanticStore(dir).get("auth provider", "is");
      expect(String(again?.o ?? "")).toMatch(/Clerk/i);
      const liveSame = new SemanticStore(dir).live().filter((t) => t.s === "auth provider" && t.p === "is");
      expect(liveSame.length).toBe(1);

      mem.observe([{ role: "user", content: "Auth is Auth0." }]);
      await sleep({ dir, mem });
      const store = new SemanticStore(dir);
      expect(String(store.get("auth provider", "is")?.o ?? "")).toMatch(/Auth0/i);
      expect(store.supersededObject("clerk", "auth provider", "is")).toBe(true);
      const pkt = packetOf(mem.inject([{ role: "user", content: "what is auth?" }]));
      expect(pkt).toMatch(/Auth0/);
      expect(pkt).not.toMatch(/Clerk/);
      expect(packetOf(mem.inject([{ role: "user", content: "got it" }]))).not.toContain(MEMORY_MARK);
      expect(packetOf(mem.inject([{ role: "user", content: "nice" }]))).not.toContain(MEMORY_MARK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("chat-only sleep mints no howto.jsonl; unused episode heat decays; postings and miss files appear", async () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "We shipped the checkout banner." }]);
      mem.observe([{ role: "user", content: "Please remember that the auth provider is Clerk." }]);
      await sleep({ dir, mem });
      expect(existsSync(join(dir, "howto.jsonl"))).toBe(false);
      const episode = mem.memories().find((r) => r.kind === "episode" && /banner/i.test(r.text));
      expect(episode).toBeTruthy();
      expect(Number(episode!.heat ?? episode!.sal ?? 1)).toBeLessThan(1);
      const pin = mem.memories().find((r) => /Clerk/i.test(r.text));
      expect(pin).toBeTruthy();
      const pinHeat = Number(pin!.heat ?? pin!.sal ?? 1);
      expect(pinHeat).toBeGreaterThanOrEqual(1);
      // P4.2: the full sleep writes the postings snapshot; the legacy sleep-postings.jsonl is gone.
      expect(existsSync(join(dir, "sleep-postings.jsonl"))).toBe(false);
      expect(readFileSync(join(dir, SNAPSHOT_FILE), "utf8")).toMatch(/clerk|auth|banner/i);
      if (existsSync(join(dir, "miss.jsonl"))) {
        const miss = readFileSync(join(dir, "miss.jsonl"), "utf8");
        expect(miss).toMatch(/Encode|Store|Retrieve|Maintain/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("completeness without drowning", () => {
  test("extract miss is stored as episode; xyzzy still silent; chatter not stored", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "Nobody mentioned the letter." }]);
      expect(mem.memories().some((r) => r.kind === "episode" && /letter/i.test(r.text))).toBe(true);
      expect(packetOf(mem.inject([{ role: "user", content: "xyzzy qwerty asdfgh" }]))).not.toContain(MEMORY_MARK);
      mem.observe([{ role: "user", content: "ok thanks" }]);
      expect(mem.memories().some((r) => /ok thanks/i.test(r.text))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("goldFirstNotes puts the rare copula ahead of a huge episode", () => {
    const huge = `Walked the sqlite catalog ${"x".repeat(400)}`;
    const ordered = goldFirstNotes("what sqlite database", [
      { text: huge, kind: "episode" },
      { text: "The session store is sqlite.", kind: "fact" },
    ]);
    expect(ordered[0]?.text).toMatch(/session store is sqlite/i);
  });

  test("twenty sqlite episodes still pack ≤ k and keep the copula", () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.remember("The session store is sqlite.", { kind: "fact", tags: ["sqlite", "session", "store"] });
      for (let i = 0; i < 20; i++) {
        mem.remember(`We shipped sqlite banner slice ${i} in the checkout.`, {
          kind: "episode",
          tags: ["sqlite", "banner", "checkout"],
        });
      }
      const pkt = packetOf(mem.inject([{ role: "user", content: "what sqlite database do we use?" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/session store is sqlite/i);
      expect(pkt.split("\n").filter((l) => /^\s*-\s+/.test(l)).length).toBeLessThanOrEqual(PACKET_BULLET_MAX);
      expect(Buffer.byteLength(pkt, "utf8")).toBeLessThanOrEqual(PACKET_BYTE_CAP);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sleep keeps the raw episode and applies miss tags", async () => {
    const dir = tmpDir();
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "Nobody mentioned the letter." }]);
      const id = mem.memories().find((r) => /letter/i.test(r.text))?.id;
      expect(id).toBeTruthy();
      await sleep({ dir, mem });
      expect(mem.memories().some((r) => r.id === id)).toBe(true);
      const letter = mem.memories().find((r) => r.id === id);
      expect(letter?.tags?.some((t) => t === "letter" || t === "mentioned")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
