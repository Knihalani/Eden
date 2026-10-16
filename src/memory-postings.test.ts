/**
 * The lexical path's postings. P0.6: a row the user did not type, of more than 12 needles, is not ranked, so tool
 * results neither cost a Submit their tokenizing nor crowd the candidate pool. P4.2 (`memory-postings.ts`): sleep's
 * postings snapshot, the bounded candidate set (|C| ≤ 200, newest-64 on fat terms) and BM25F ranking for every reader.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIARY_FILE, openMemory, type MemoryRecord } from "./index";
import { rowFields } from "./memory-bm25f";
import {
  CANDIDATE_CAP,
  candidateRows,
  DeltaIndex,
  FAT_DF,
  PostingsView,
  Snapshot,
  SNAPSHOT_FILE,
  snapshotBytes,
  writeSnapshot,
  type Indexed,
} from "./memory-postings";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.EDEN_MEMORY_STORE_CAP;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-postings-"));
  dirs.push(dir);
  return dir;
}

function indexed(id: string, text: string, extra: Partial<MemoryRecord> = {}): Indexed {
  const rec: MemoryRecord = { id, text, kind: "fact", at: 0, seq: Number(id.replace(/\D/g, "")) || 0, ...extra };
  return { rec, fields: rowFields(rec) };
}

test("forty long rows sharing a fact's words do not crowd the fact out of the candidate pool", () => {
  const dir = tempDir();
  const mem = openMemory({ dir, session: "s1", perRepo: true });
  for (let i = 0; i < 40; i++)
    mem.remember(
      `Migration log ${i}: the database postgres replica ${i} reported lag, vacuum ran on tables orders users ` +
        `payments invoices sessions audit events, then the pooler restarted and checkpoints resumed normally.`,
      { kind: "episode", lane: "narrative", tags: ["src:tool"] },
    );
  mem.remember("The database is postgres.", { kind: "fact", tags: ["src:user"] });
  const found = mem.relevant("which database do we use, postgres?").map((row) => row.text);
  expect(found).toContain("The database is postgres.");
  mem.close();
});

describe("the snapshot file", () => {
  const rows = [
    indexed("r1", "Our billing database runs on CockroachDB.", { scope: "services/billing" }),
    indexed("r2", "The search queue is RabbitMQ.", { scope: "services/search" }),
    indexed("r3", "Billing tests run with Vitest.", { scope: "services/billing" }),
    indexed("r4", "We deploy everything to Fly.io.", { scope: "" }),
  ];

  test("reads back each term's ordinals by scope, the ids by ordinal, and N and field lengths by scope", () => {
    const dir = tempDir();
    writeSnapshot(dir, rows);
    const snapshot = Snapshot.open(dir)!;
    try {
      expect(snapshot.header).toMatchObject({ v: 1, rows: 4, id: expect.any(String) });
      expect(snapshot.ids()).toEqual(["r1", "r2", "r3", "r4"]);
      expect(snapshot.lists("billing")).toEqual({ "services/billing": [0, 2] });
      expect(snapshot.lists("deploy")).toEqual({ "": [3] });
      expect(snapshot.lists("redis")).toBeUndefined();
      expect(snapshot.header.scopes["services/billing"]).toMatchObject({ n: 2 });
      expect(snapshot.header.scopes["services/billing"]!.len.body).toBe(
        rows[0]!.fields.body.length + rows[2]!.fields.body.length,
      );
    } finally {
      snapshot.close();
    }
  });

  test("a term or folder named like an Object key is just a key", () => {
    const dir = tempDir();
    writeSnapshot(dir, [indexed("r1", "The constructor hook is broken.", { scope: "constructor" })]);
    const snapshot = Snapshot.open(dir)!;
    try {
      expect(snapshot.lists("constructor")).toEqual({ constructor: [0] });
      expect(snapshot.lists("tostring")).toBeUndefined();
      expect(snapshot.lists("__proto__")).toBeUndefined();
    } finally {
      snapshot.close();
    }
  });

  test("none, an unknown version or a cut-short file is no snapshot", () => {
    const dir = tempDir();
    expect(Snapshot.open(dir)).toBeUndefined();
    writeFileSync(join(dir, SNAPSHOT_FILE), '{"v":99}\n');
    expect(Snapshot.open(dir)).toBeUndefined();
    writeFileSync(join(dir, SNAPSHOT_FILE), snapshotBytes(rows).subarray(0, 40));
    expect(Snapshot.open(dir)).toBeUndefined();
  });

  test("it is written owner-only", () => {
    const dir = tempDir();
    writeSnapshot(dir, rows);
    expect(statSync(join(dir, SNAPSHOT_FILE)).mode & 0o777).toBe(0o600);
  });
});

describe("the bounded candidate set", () => {
  /** A term's rows, newest first (`TermRows`): row `i` of `n` is `${term}:${i}`, newest last. */
  function list(term: string, ids: readonly string[]) {
    return { term, df: ids.length, newest: () => [...ids].reverse() };
  }
  const range = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  test("a thin term gives all its rows, rarest term first", () => {
    const got = candidateRows([list("b", range("b", 10)), list("a", range("a", 3))], () => true);
    expect(got.slice(0, 3)).toEqual(["a2", "a1", "a0"]);
    expect(got).toHaveLength(13);
  });

  test("a fat term gives its newest 64 only", () => {
    const got = candidateRows([list("fat", range("f", 1_000))], () => true);
    expect(got).toEqual(range("f", 1_000).slice(-FAT_DF).reverse());
  });

  test("two fat terms give the rows they share first, however old, then each one's newest 64", () => {
    const shared = ["old-both"];
    const a = [...shared, ...range("a", 500)];
    const b = [...shared, ...range("b", 900)];
    const got = candidateRows([list("a", a), list("b", b)], () => true);
    expect(got[0]).toBe("old-both");
    expect(got).toHaveLength(1 + 2 * FAT_DF);
  });

  test("a newest-64 read walks 256 entries at most: a fat term whose newest rows the reader refuses gives none", () => {
    const ids = range("f", 1_000);
    const refused = new Set(ids.slice(-300));
    expect(candidateRows([list("fat", ids)], (id) => !refused.has(id))).toEqual([]);
  });

  test("only the 4 rarest fat terms are intersected: an old row two fatter ones share is not read", () => {
    // Oldest first: "rare-pair" is in the two rarest lists, "fat-pair" in the two fattest, both older than any
    // newest 64.
    const fat = Array.from({ length: 6 }, (_, k) => {
      const oldest = k < 2 ? ["rare-pair"] : k >= 4 ? ["fat-pair"] : [];
      return list(`t${k}`, [...oldest, ...range(`t${k}-`, 100 + k)]);
    });
    const got = candidateRows(fat, () => true);
    expect(got).toContain("rare-pair");
    expect(got).not.toContain("fat-pair");
  });

  test("|C| never passes 200, and a row the reader refuses takes no place", () => {
    const thin = Array.from({ length: 10 }, (_, k) => list(`t${k}`, range(`t${k}-`, FAT_DF)));
    expect(candidateRows(thin, () => true)).toHaveLength(CANDIDATE_CAP);
    const refused = candidateRows([list("a", range("a", 50))], (id) => !id.endsWith("7"));
    expect(refused).toHaveLength(45);
    expect(refused.some((id) => id.endsWith("7"))).toBe(false);
  });
});

describe("the view a reader reads", () => {
  test("only the scopes it may see: a sibling folder's rows are neither candidates nor in df", () => {
    const dir = tempDir();
    const rows = [
      indexed("r1", "The web auth provider is Clerk.", { scope: "apps/web" }),
      indexed("r2", "The cli auth is none.", { scope: "packages/cli" }),
      indexed("r3", "Auth tokens expire after an hour."),
    ];
    writeSnapshot(dir, rows);
    const snapshot = Snapshot.open(dir)!;
    const byId = new Map(rows.map((row) => [row.rec.id, row]));
    const sees = (scope: string) => scope === "" || scope === "apps/web";
    const view = new PostingsView(snapshot, new DeltaIndex(snapshot.header.id, []), (id) => byId.get(id), sees);
    try {
      expect(view.n).toBe(2);
      expect(view.df("auth")).toBe(2);
      expect([...view.rowsOf("auth").newest()].map((row) => row.rec.id)).toEqual(["r3", "r1"]);
    } finally {
      snapshot.close();
    }
  });

  test("rows written since the snapshot are indexed in process, newest of all", () => {
    const dir = tempDir();
    const old = [indexed("r1", "The queue is RabbitMQ.")];
    writeSnapshot(dir, old);
    const snapshot = Snapshot.open(dir)!;
    const fresh = indexed("r2", "The queue moved to SQS.");
    const byId = new Map([...old, fresh].map((row) => [row.rec.id, row]));
    const delta = new DeltaIndex(snapshot.header.id, [fresh]);
    const view = new PostingsView(
      snapshot,
      delta,
      (id) => byId.get(id),
      () => true,
    );
    try {
      expect(view.df("queue")).toBe(2);
      expect([...view.rowsOf("queue").newest()].map((row) => row.rec.id)).toEqual(["r2", "r1"]);
    } finally {
      snapshot.close();
    }
  });
});

describe("retrieval through the snapshot (AgentMemory)", () => {
  const FACT = "The storefront queue is RabbitMQ.";

  /**
   * A store where thirty newer, longer rows name a fact's subject words, as the scale bench's filler does: "one long
   * diary line that mentions `auth` … cannot outrank the short copula" (A2 §2.2).
   */
  function distracted(dir: string) {
    const mem = openMemory({ dir, session: "s1", perRepo: true });
    mem.remember(FACT, { tags: ["src:user"] });
    for (let i = 0; i < 30; i++)
      mem.remember(`Moved ticket T-${100 + i} for storefront queue into the next sprint on day ${i}.`, {
        tags: ["src:user"],
      });
    return mem;
  }

  test("BM25F ranks the short row stating the fact above newer, longer rows that only name its words", () => {
    const mem = distracted(tempDir());
    expect(mem.relevant("what's the storefront queue?", 4).map((row) => row.text)[0]).toBe(FACT);
    mem.close();
  });

  test("the same through a snapshot, and with rows written after it", () => {
    const dir = tempDir();
    const mem = distracted(dir);
    expect(mem.refreshPostings()).toBe(true);
    expect(existsSync(join(dir, SNAPSHOT_FILE))).toBe(true);
    mem.remember("The billing database runs on CockroachDB.", { tags: ["src:user"] });
    const fresh = openMemory({ dir, session: "s2", perRepo: true });
    expect(fresh.relevant("what's the storefront queue?", 4).map((row) => row.text)[0]).toBe(FACT);
    expect(fresh.relevant("which billing database?", 4).map((row) => row.text)).toContain(
      "The billing database runs on CockroachDB.",
    );
    mem.close();
    fresh.close();
  });

  test("a row another process wrote after the snapshot's builder read the store is in the delta, whatever its seq", () => {
    const dir = tempDir();
    const builder = openMemory({ dir, session: "s1", perRepo: true });
    builder.remember("The cache is Redis.", { tags: ["src:user"] });
    builder.remember("The deploy target is Fly.io.", { tags: ["src:user"] });
    expect(builder.refreshPostings()).toBe(true);
    builder.close();
    // A writer that claimed its seq before the builder's rows, and wrote after the snapshot was built.
    const late = { id: "late-writer-row", text: "The storefront queue is RabbitMQ.", tags: ["src:user"], t: 1, seq: 1 };
    appendFileSync(join(dir, "memories.jsonl"), `${JSON.stringify(late)}\n`);
    const reader = openMemory({ dir, session: "s2", perRepo: true });
    expect(reader.relevant("what's the storefront queue?").map((row) => row.text)).toContain(
      "The storefront queue is RabbitMQ.",
    );
    reader.close();
  });

  test("a snapshot cut short is set aside: the rows are indexed in process", () => {
    const dir = tempDir();
    const mem = distracted(dir);
    mem.refreshPostings();
    const path = join(dir, SNAPSHOT_FILE);
    const bytes = readFileSync(path);
    const header = Snapshot.open(dir)!;
    const idsEnd = bytes.indexOf(0x0a) + 1 + header.header.ids[1];
    header.close();
    writeFileSync(path, bytes.subarray(0, idsEnd + 5));
    const fresh = openMemory({ dir, session: "s2", perRepo: true });
    expect(fresh.relevant("what's the storefront queue?", 4).map((row) => row.text)[0]).toBe(FACT);
    mem.close();
    fresh.close();
  });

  test("the light sleep's threshold: no snapshot until enough rows wait outside one", () => {
    const dir = tempDir();
    const mem = distracted(dir);
    expect(mem.refreshPostings(256)).toBe(false);
    expect(mem.refreshPostings(31)).toBe(true);
    expect(mem.refreshPostings(1)).toBe(false);
    mem.remember("The cache is Redis.", { tags: ["src:user"] });
    expect(mem.refreshPostings(1)).toBe(true);
    mem.close();
  });

  test("a typed row of more than 12 needles ranks (follow-up from P4.1: w06, w21)", () => {
    const mem = openMemory({ dir: tempDir(), session: "s1", perRepo: true });
    const gotcha =
      "Gotcha: the sign-in redirect loop happens when /login is missing from publicRoutes in middleware.ts; " +
      "also set afterSignInUrl to /dashboard.";
    mem.remember(gotcha, { kind: "episode", tags: ["src:user"] });
    expect(mem.relevant("the sign-in keeps looping on redirect").map((row) => row.text)).toContain(gotcha);
    mem.close();
  });

  test("every reader ranks one way: with no situation cue a procedure does not jump a better-matching fact", () => {
    const mem = openMemory({ dir: tempDir(), session: "s1", perRepo: true });
    mem.remember("The staging database is Postgres 16 on Neon.", { kind: "fact", tags: ["src:user"] });
    mem.remember("To reset the staging database, run make db-reset.", { kind: "procedure", tags: ["src:user"] });
    const found = mem.notesFor("which postgres version is the staging database?", 2).map((row) => row.text);
    expect(found[0]).toContain("Postgres 16");
    mem.close();
  });
});

describe("D33: the hot path's 20k rows", () => {
  test("rows past the cap leave the store for its diary, the newest stay", () => {
    process.env.EDEN_MEMORY_STORE_CAP = "5";
    const dir = tempDir();
    const mem = openMemory({ dir, session: "s1", perRepo: true });
    for (let i = 0; i < 8; i++) mem.remember(`Ticket ${i} note: the queue lagged again.`, { tags: ["src:user"] });
    mem.close();
    const diary = readFileSync(join(dir, DIARY_FILE), "utf8").trim().split("\n");
    expect(diary).toHaveLength(3);
    expect(diary.join("\n")).toContain("Ticket 0 note");
    const kept = openMemory({ dir, session: "s2", perRepo: true })
      .memories()
      .map((row) => row.text);
    expect(kept).toHaveLength(5);
    expect(kept.some((text) => text.includes("Ticket 7 note"))).toBe(true);
  });

  test("the cap is 20,000 rows by default", async () => {
    const { memoryStoreCap } = await import("./index");
    expect(memoryStoreCap()).toBe(20_000);
  });
});
