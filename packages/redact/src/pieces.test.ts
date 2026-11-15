/**
 * D1850: the composer's pieces (pieces.ts) trace a removal back to the original text as a map per character does,
 * through chains of random rewrites (each replacing random ranges by a sentinel), on 3,000 seeded cases.
 */
import { describe, expect, test } from "bun:test";
import { prng } from "./differential.ts";
import { identity, type Iv, maskOf, replaced, runsOf, same, traced, union } from "./pieces.ts";

describe("pieces", () => {
  test("replaced and traced agree with a map per character", () => {
    const rnd = prng(1850);
    const int = (n: number) => Math.floor(rnd() * n);
    for (let t = 0; t < 3_000; t++) {
      const length = int(80);
      let pieces = identity(length);
      let map = Array.from({ length }, (_, i) => i); // per character of the current text, its origin or -1
      for (let step = int(4); step >= 0; step--) {
        // Random sorted, apart, non-empty ranges of the current text; a sentinel 1 to 10 long each.
        const ranges: Iv[] = [];
        for (let at = int(6); at < map.length; at += 1 + int(8)) {
          const end = Math.min(map.length, at + 1 + int(6));
          ranges.push([at, end]);
          at = end;
        }
        // What the ranges remove, traced: the pieces against the map.
        const expected: number[] = [];
        for (const [s, e] of ranges) for (let i = s; i < e; i++) if (map[i]! >= 0) expected.push(map[i]!);
        const got = traced(pieces, ranges);
        expect(
          same(
            got,
            runsOf(
              maskOf(
                expected.map((i) => [i, i + 1] as Iv),
                length,
              ),
            ),
          ),
        ).toBe(true);
        const sentinel = 1 + int(10);
        pieces = replaced(pieces, ranges, sentinel);
        const next: number[] = [];
        let at = 0;
        for (const [s, e] of ranges) {
          next.push(...map.slice(at, s), ...Array.from({ length: sentinel }, () => -1));
          at = e;
        }
        map = [...next, ...map.slice(at)];
        // The pieces cover the new text exactly, each run where the map says.
        let covered = 0;
        for (let p = 0; p < pieces.length; p += 3) {
          expect(pieces[p]).toBe(covered);
          for (let i = pieces[p]!; i < pieces[p + 1]!; i++) {
            expect(map[i]).toBe(pieces[p + 2]! < 0 ? -1 : pieces[p + 2]! + (i - pieces[p]!));
          }
          covered = pieces[p + 1]!;
        }
        expect(covered).toBe(map.length);
      }
    }
  });

  test("union merges overlapping and touching intervals", () => {
    expect(
      union(
        [[5, 7]],
        [
          [0, 2],
          [2, 3],
          [6, 9],
        ],
        [[4, 4]],
      ),
    ).toEqual([
      [0, 3],
      [5, 9],
    ]);
  });
});
