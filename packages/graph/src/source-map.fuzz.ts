/**
 * The random call streams `source-map-fast.test.ts` (D1935-D1937) and `source-map-migrate.test.ts` (D1960) run on the
 * map and on the map before them (`source-map.reference.ts`), answer by answer.
 */
import { expect } from "bun:test";
import { Xoshiro128 } from "@eden/primitives";
import type { Scope } from "@eden/protocol";
import type { SourceMap } from "./source-map";
import type { SourceMap as ReferenceMap } from "./source-map.reference";

const SPACES = [" ", "  ", "\t", "\n", "\r\n", " ", " ", "　", "﻿", " ", "\v", "\f"];
const LETTERS = ["a", "Z", "q", "M", "0", "7", "-", "'", ".", "&", "é", "Ö", "İ", "ß", "Σ", "ǅ", "日", "😀", "́"];

export function randomEntity(rng: Xoshiro128): string {
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

export const SCOPES: Scope[] = [
  { tenantId: "acme", userId: "alice" },
  { tenantId: "acme", userId: "bob" },
  { tenantId: "globex", userId: "alice" },
];
export const SOURCES = ["mail", "cal", "docs", "crm", "chat", "drive"];
const SITUATIONS = ["planning", "email", "coding"];
const NAMES = ["Dana Lee", "dana  lee", " DANA LEE", "Globex", "ACME-42", "Zoë", "李雷", "Bob's", "x", "Sam\tO'Neil"];

export type AnyMap = SourceMap | ReferenceMap;

/** One random call, applied to both maps; returns what each answered (undefined for a write). */
export function step(rng: Xoshiro128, maps: AnyMap[], t: number): unknown[] {
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

export function differential(seed: number, steps: number, makeNew: () => AnyMap, makeOld: () => AnyMap): number {
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
