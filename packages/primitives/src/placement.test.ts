import { describe, expect, test } from "bun:test";
import { BUCKETS, childTable, jumpHash, OwnerTable } from "./placement";

describe("placement (D992)", () => {
  test("jumpHash stays in range and moves 1/(n+1) of keys, all to the new slot", () => {
    expect(jumpHash(0, 1)).toBe(0);
    expect(jumpHash(7, 0)).toBe(0);
    for (let n = 1; n < 20; n++) expect(jumpHash(12345, n)).toBeLessThan(n);
    for (const n of [2, 3, 5, 8]) {
      let moved = 0;
      for (let k = 0; k < 20_000; k++) {
        const a = jumpHash(k * 2654435761, n);
        const b = jumpHash(k * 2654435761, n + 1);
        if (a !== b) {
          moved++;
          expect(b).toBe(n);
        }
      }
      expect(Math.abs(moved / 20_000 - 1 / (n + 1))).toBeLessThan(0.02);
    }
  });

  test("childTable: 2 -> 3 keeps two thirds of buckets on their child; 3 -> 2 moves only child 2's", () => {
    const two = childTable(2);
    const three = childTable(3);
    let kept = 0;
    for (let b = 0; b < BUCKETS; b++) {
      if (two[b] === three[b]) kept++;
      else expect(three[b]).toBe(2);
    }
    expect(Math.abs(kept / BUCKETS - 2 / 3)).toBeLessThan(0.01);
    expect(childTable(1).every((c) => c === 0)).toBe(true);
  });

  test("OwnerTable: adding a node moves about 1/(n+1), all to it; removing any node moves only its buckets", () => {
    const three = new OwnerTable(["a", "b", "c"]);
    const four = new OwnerTable(["a", "b", "c", "d"]);
    const moved = three.moved(four);
    expect(Math.abs(moved.length / BUCKETS - 1 / 4)).toBeLessThan(0.01);
    for (const b of moved) expect(four.owner(b)).toBe("d");
    // Remove the middle node (jump hash could only drop the last).
    const noB = new OwnerTable(["a", "c"]);
    for (const b of three.moved(noB)) expect(three.owner(b)).toBe("b");
    // Order of the list does not matter, and neither does a duplicate.
    const shuffled = new OwnerTable(["c", "a", "b", "a"]);
    expect(three.moved(shuffled)).toEqual([]);
    // Each node's share is even.
    const share = new Map<string, number>();
    for (let b = 0; b < BUCKETS; b++) share.set(three.owner(b)!, (share.get(three.owner(b)!) ?? 0) + 1);
    for (const n of share.values()) expect(Math.abs(n / BUCKETS - 1 / 3)).toBeLessThan(0.01);
    expect(new OwnerTable([]).owner(5)).toBeNull();
  });

  test("a node's buckets spread evenly over its children (no inherited pattern)", () => {
    const t = new OwnerTable(["a", "b", "c"]);
    const kids = childTable(4);
    const per = [0, 0, 0, 0];
    let mine = 0;
    for (let b = 0; b < BUCKETS; b++) {
      if (t.owner(b) !== "a") continue;
      mine++;
      per[kids[b]!]!++;
    }
    for (const n of per) expect(Math.abs(n / mine - 1 / 4)).toBeLessThan(0.02);
  });
});
