/**
 * D1935-D1937 against the map before them (`source-map.reference.ts`, main 7bca42093's `source-map.ts` unchanged):
 * the read memos, the WITHOUT ROWID tables and the entity fast path must leave every answer as it was, to the order
 * and the float, on random streams of every public call, across users, files and a second connection.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Xoshiro128 } from "@eden/primitives";
import type { Scope } from "@eden/protocol";
import { normalizeEntity, normalizeEntitySlow, SourceMap } from "./source-map";
import { SourceMap as ReferenceMap } from "./source-map.reference";

const dir = mkdtempSync(join(tmpdir(), "eden-map-fast-"));
let files = 0;
const fileOf = () => join(dir, `m${files++}.db`);

const SPACES = [" ", "  ", "\t", "\n", "\r\n", " ", " ", "　", "﻿", " ", "\v", "\f"];
const LETTERS = ["a", "Z", "q", "M", "0", "7", "-", "'", ".", "&", "é", "Ö", "İ", "ß", "Σ", "ǅ", "日", "😀", "́"];

function randomEntity(rng: Xoshiro128): string {
  const n = rng.below(12);
  let s = "";
  for (let i = 0; i < n; i++) {
    const r = rng.uniform();
    if (r < 0.15) s += SPACES[rng.below(SPACES.length)];
    else if (r < 0.3) s += " ";
    else if (r < 0.4) s += LETTERS[rng.below(LETTERS.length)];
    else s += String.fromCharCode(r < 0.7 ? 97 + rng.below(26) : 65 + rng.below(26));
  }
  return s;
}

describe("normalizeEntity's fast path (D1937)", () => {
  test("equals the definition on 300,000 random strings and every single code unit", () => {
    const rng = new Xoshiro128(19);
    for (let i = 0; i < 300_000; i++) {
      const e = randomEntity(rng);
      if (normalizeEntity(e) !== normalizeEntitySlow(e))
        expect([e, normalizeEntity(e)]).toEqual([e, normalizeEntitySlow(e)]);
    }
    for (let c = 0; c < 0x10000; c++) {
      for (const e of [String.fromCharCode(c), `a${String.fromCharCode(c)}b`, `A ${String.fromCharCode(c)}`]) {
        if (normalizeEntity(e) !== normalizeEntitySlow(e))
          expect([c, normalizeEntity(e)]).toEqual([c, normalizeEntitySlow(e)]);
      }
    }
    for (const e of ["", " ", "a", "A", " a", "a ", "a  b", "a b", "Dana Lee", "ACME-42", "x\ty"]) {
      expect(normalizeEntity(e)).toBe(normalizeEntitySlow(e));
    }
  });
});

const SCOPES: Scope[] = [
  { tenantId: "acme", userId: "alice" },
  { tenantId: "acme", userId: "bob" },
  { tenantId: "globex", userId: "alice" },
];
const SOURCES = ["mail", "cal", "docs", "crm", "chat", "drive"];
const SITUATIONS = ["planning", "email", "coding"];
const NAMES = ["Dana Lee", "dana  lee", " DANA LEE", "Globex", "ACME-42", "Zoë", "李雷", "Bob's", "x", "Sam\tO'Neil"];

type AnyMap = SourceMap | ReferenceMap;

/** One random call, applied to both maps; returns what each answered (undefined for a write). */
function step(rng: Xoshiro128, maps: AnyMap[], t: number): unknown[] {
  const scope = SCOPES[rng.below(SCOPES.length)]!;
  const pick = <T>(xs: T[]) => xs[rng.below(xs.length)]!;
  const r = rng.uniform();
  const entities = () =>
    Array.from({ length: rng.below(5) }, () => (rng.uniform() < 0.7 ? pick(NAMES) : randomEntity(rng)));
  if (r < 0.25) {
    const rows = Array.from({ length: 1 + rng.below(4) }, () => ({ sourceId: pick(SOURCES), entities: entities() }));
    return maps.map((m) => m.recordMentionsMany(scope, rows, t));
  }
  if (r < 0.35) {
    const [situation, source, used] = [pick(SITUATIONS), pick(SOURCES), rng.uniform() < 0.4];
    return maps.map((m) => m.recordOutcome(scope, situation, source, used));
  }
  if (r < 0.38) {
    const [situation, source, used] = [pick(SITUATIONS), pick(SOURCES), rng.uniform() < 0.5];
    return maps.map((m) => m.correctOutcome(scope, situation, source, used));
  }
  if (r < 0.55) {
    const e = rng.uniform() < 0.8 ? pick(NAMES) : randomEntity(rng);
    return maps.map((m) => m.sourcesFor(scope, e));
  }
  if (r < 0.75) {
    const ents = entities();
    const boost = rng.uniform() < 0.3 ? new Map([[pick(SOURCES), rng.uniform() * 3]]) : undefined;
    const ids = SOURCES.filter(() => rng.uniform() < 0.8);
    const [situation, limit] = [pick(SITUATIONS), 1 + rng.below(5)];
    return maps.map((m) =>
      m.route({ scope, entities: ents, situation, sourceIds: ids, limit, ...(boost ? { boost } : {}) }),
    );
  }
  if (r < 0.79) {
    const [situation, source] = [pick(SITUATIONS), pick(SOURCES)];
    return maps.map((m) => m.utility(scope, situation, source));
  }
  if (r < 0.83) return maps.map((m) => m.flush());
  if (r < 0.85) {
    const source = rng.uniform() < 0.5 ? pick(SOURCES) : undefined;
    return maps.map((m) => m.forget(scope, source));
  }
  if (r < 0.88) return maps.map((m) => m.exportUser(scope));
  if (r < 0.9) {
    // A user's rows carried from another user's export (the shapes D992 carries).
    const from = SCOPES[rng.below(SCOPES.length)]!;
    const rows = maps[0]!.exportUser(from);
    expect(maps[1]!.exportUser(from)).toEqual(rows);
    return maps.map((m) => m.importUser(scope, structuredClone(rows)));
  }
  if (r < 0.94) {
    const source = pick(SOURCES);
    const arms = Array.from({ length: rng.below(3) }, () => ({
      bucket: rng.below(4),
      shape: pick(["and", "or", "phrase"]),
      alpha: 1 + rng.uniform() * 5,
      beta: 1 + rng.uniform() * 5,
    }));
    return maps.map((m) => m.saveArms(scope, source, arms));
  }
  const source = pick(SOURCES);
  return maps.map((m) => m.loadArms(scope, source));
}

function differential(seed: number, steps: number, makeNew: () => AnyMap, makeOld: () => AnyMap): number {
  const rng = new Xoshiro128(seed);
  const maps = [makeNew(), makeOld()];
  let compared = 0;
  for (let i = 0; i < steps; i++) {
    const [a, b] = step(rng, maps, 1_000 + i);
    if (a !== undefined || b !== undefined) {
      compared++;
      if (!Bun.deepEquals(a, b, true)) expect({ seed, i, a }).toEqual({ seed, i, a: b });
    }
  }
  for (const s of SCOPES) expect(maps[0]!.exportUser(s)).toEqual(maps[1]!.exportUser(s));
  for (const m of maps) m.close();
  return compared;
}

describe("SourceMap against the map before D1935-D1937", () => {
  test("in memory: random streams of every call answer alike, Thompson draws included", () => {
    let compared = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const opts = { seed, explore: seed % 3 !== 0, mentionFlushMs: 60_000 };
      compared += differential(
        seed,
        1_500,
        () => new SourceMap(":memory:", opts),
        () => new ReferenceMap(":memory:", opts),
      );
    }
    expect(compared).toBeGreaterThan(8_000);
  });

  test("in files: a new file (WITHOUT ROWID) and a file of the old layout answer as the old map on its own file", () => {
    for (let seed = 21; seed <= 22; seed++) {
      const opts = { seed, mentionFlushMs: 60_000 };
      differential(
        seed,
        800,
        () => new SourceMap(fileOf(), opts),
        () => new ReferenceMap(fileOf(), opts),
      );
      // A file the old map made (rowid tables, some rows in it), opened by the new map and by the old on a copy.
      const old = fileOf();
      const seedMap = new ReferenceMap(old, opts);
      differential(
        seed + 100,
        300,
        () => seedMap,
        () => new ReferenceMap(":memory:", opts),
      ); // fills `old` (closed)
      const copy = fileOf();
      copyFileSync(old, copy);
      differential(
        seed,
        800,
        () => new SourceMap(old, opts),
        () => new ReferenceMap(copy, opts),
      );
      const schema = new Database(old).query("SELECT sql FROM sqlite_master WHERE type = 'table'").values();
      expect(String(schema)).not.toContain("WITHOUT ROWID");
    }
    const fresh = fileOf();
    new SourceMap(fresh).close();
    const schema = new Database(fresh).query("SELECT sql FROM sqlite_master WHERE type = 'table'").values();
    expect(schema.map((r) => String(r[0]).endsWith("WITHOUT ROWID"))).toEqual([true, true, true]);
  });

  test("a memoised read sees another connection's commit at once (data_version), as the old map's query did", () => {
    const path = fileOf();
    const alice = SCOPES[0]!;
    const reader = new SourceMap(path, { explore: false, mentionFlushMs: 60_000 });
    const writer = new SourceMap(path, { explore: false, mentionFlushMs: 60_000 });
    const route = () =>
      reader.route({ scope: alice, entities: ["Dana Lee"], situation: "planning", sourceIds: SOURCES, limit: 6 });
    expect(reader.sourcesFor(alice, "Dana Lee")).toEqual([]);
    const before = route();
    writer.recordMentions(alice, "crm", ["Dana Lee"], 1);
    writer.recordOutcome(alice, "planning", "docs", true);
    expect(reader.sourcesFor(alice, "Dana Lee")).toEqual([]); // not committed yet: buffered in the writer
    writer.flush();
    expect(reader.sourcesFor(alice, "Dana Lee")).toEqual([{ sourceId: "crm", count: 1 }]);
    const after = route();
    expect(after.find((r) => r.sourceId === "crm")!.entityHits).toBe(1);
    expect(after.find((r) => r.sourceId === "docs")!.utility).toBe(2 / 3);
    expect(before.find((r) => r.sourceId === "docs")!.utility).toBe(0.5);
    writer.forget(alice);
    expect(reader.sourcesFor(alice, "Dana Lee")).toEqual([]);
    reader.close();
    writer.close();
  });

  test("two maps on one file, interleaved, with raw SQL from a third connection, answer as two old maps do", () => {
    // The directed test above checks one commit; this interleaves both maps' writes and reads with outside commits,
    // so a memo emptied or re-filled at the wrong moment (between `fresh()` and a commit) shows up (D1935's review).
    const scopes: Scope[] = [
      { tenantId: "t1", userId: "u" },
      { tenantId: "t2", userId: "u" },
      { tenantId: "t1", userId: "v" },
    ];
    const srcs = ["a", "b", "c", "d"];
    const sits = ["s1", "s2"];
    const names = ["Dana", "dana", " DANA ", "Ann Lee", "ann  lee", "Zoë"];
    let compared = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const fa = join(dir, `two-n${seed}.db`);
      const fb = join(dir, `two-r${seed}.db`);
      const o = { explore: seed % 2 === 0, seed, mentionFlushMs: 60_000 };
      const news = [new SourceMap(fa, o), new SourceMap(fa, { ...o, seed: seed + 7 })];
      const refs = [new ReferenceMap(fb, o), new ReferenceMap(fb, { ...o, seed: seed + 7 })];
      const rng = new Xoshiro128(seed);
      const pick = <T>(xs: T[]) => xs[rng.below(xs.length)]!;
      for (let i = 0; i < 1_000; i++) {
        const w = rng.below(2);
        const sc = pick(scopes);
        const r = rng.uniform();
        // biome-ignore lint/suspicious/noExplicitAny: both maps share the public calls used here
        const both = (f: (m: any) => unknown) => {
          const a = f(news[w]);
          const b = f(refs[w]);
          compared++;
          if (!Bun.deepEquals(a, b, true)) expect({ seed, i, a }).toEqual({ seed, i, a: b });
        };
        if (r < 0.2) {
          const src = pick(srcs);
          const es = [pick(names), pick(names)];
          both((m) => m.recordMentions(sc, src, es, i));
        } else if (r < 0.3) {
          const [sit, src, used] = [pick(sits), pick(srcs), rng.uniform() < 0.5];
          both((m) => m.recordOutcome(sc, sit, src, used));
        } else if (r < 0.33) {
          const [sit, src, used] = [pick(sits), pick(srcs), rng.uniform() < 0.5];
          both((m) => m.correctOutcome(sc, sit, src, used));
        } else if (r < 0.5) {
          const e = pick(names);
          both((m) => m.sourcesFor(sc, e));
        } else if (r < 0.7) {
          const entities = [pick(names), pick(names)];
          const req = { scope: sc, entities, situation: pick(sits), sourceIds: srcs, limit: 4 };
          both((m) => m.route(req));
        } else if (r < 0.8) both((m) => m.flush());
        else if (r < 0.83) {
          const src = rng.uniform() < 0.5 ? pick(srcs) : undefined;
          both((m) => m.forget(sc, src));
        } else if (r < 0.86) {
          const from = pick(scopes);
          const rows = news[1 - w]!.exportUser(from);
          expect(rows).toEqual(refs[1 - w]!.exportUser(from));
          both((m) => m.importUser(sc, structuredClone(rows)));
        } else if (r < 0.95) {
          const [sit, src] = [pick(sits), pick(srcs)];
          both((m) => m.utility(sc, sit, src));
        } else {
          const n = 1 + rng.below(5);
          for (const f of [fa, fb]) {
            const d = new Database(f);
            d.exec("PRAGMA busy_timeout=2000");
            d.query("UPDATE mention SET count = count + ?").run(n);
            d.query("UPDATE utility SET shown = shown + ?").run(n);
            d.close();
          }
        }
      }
      for (const m of [...news, ...refs]) m.close();
    }
    expect(compared).toBeGreaterThan(5_000);
  }, 60_000);

  test("the memos stay bounded past their cap and answer as the old map through every emptying", () => {
    const opts = { explore: false, mentionFlushMs: 60_000 };
    const [map, old] = [new SourceMap(":memory:", opts), new ReferenceMap(":memory:", opts)];
    const alice = SCOPES[0]!;
    for (const m of [map, old]) {
      for (let i = 0; i < 3_000; i++) m.recordMentions(alice, SOURCES[i % 6]!, [`name ${i}`, `name ${i + 1}`], i);
      for (let i = 0; i < 2_000; i++) m.recordOutcome(alice, `situation ${i % 700}`, SOURCES[i % 6]!, i % 3 === 0);
      m.flush();
    }
    const held = map as unknown as { mentionMemoSize: number; outcomeMemoSize: number };
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < 3_001; i += 1 + (i % 3)) {
        expect(map.sourcesFor(alice, `Name ${i}`)).toEqual(old.sourcesFor(alice, `Name ${i}`));
        const request = {
          scope: alice,
          entities: [`name ${i}`],
          situation: `situation ${i % 700}`,
          sourceIds: SOURCES,
        };
        expect(map.route({ ...request, limit: 6 })).toEqual(old.route({ ...request, limit: 6 }));
        expect(held.mentionMemoSize).toBeLessThanOrEqual(4_096);
        expect(held.outcomeMemoSize).toBeLessThanOrEqual(4_096);
      }
    }
    map.close();
    old.close();
  });

  test("the memo is per user: one user's read never answers another's, and forget empties it (D9)", () => {
    const map = new SourceMap(":memory:", { explore: false, mentionFlushMs: 60_000 });
    const [alice, bob, otherAlice] = SCOPES as [Scope, Scope, Scope];
    map.recordMentions(alice, "mail", ["Dana Lee"], 1);
    map.flush();
    expect(map.sourcesFor(alice, "Dana Lee")).toEqual([{ sourceId: "mail", count: 1 }]);
    expect(map.sourcesFor(bob, "Dana Lee")).toEqual([]);
    expect(map.sourcesFor(otherAlice, "Dana Lee")).toEqual([]);
    // A caller that changes what it was handed changes nothing held.
    map.sourcesFor(alice, "Dana Lee")[0]!.count = 99;
    expect(map.sourcesFor(alice, "Dana Lee")).toEqual([{ sourceId: "mail", count: 1 }]);
    map.forget(alice);
    expect(map.sourcesFor(alice, "Dana Lee")).toEqual([]);
    map.close();
  });
});
