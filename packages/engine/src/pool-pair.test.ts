import { describe, expect, test } from "bun:test";
import { gramsOf, loadPoolPair } from "./pool-pair";

/** A tiny EP12 file (version 2) with the given weights: B = 32 bits, W = 32, NB buckets. */
function tiny(nb: number, fill: (k: number) => number, cap = 0): Uint8Array {
  const B = 32;
  const W = 32;
  const words = (n: number) => Array.from({ length: n }, (_, k) => fill(k) | 0);
  const floats = (n: number, v: number) => Array.from({ length: n }, () => v);
  const parts: { kind: "i" | "f"; v: number[] }[] = [];
  for (let side = 0; side < 2; side++) {
    parts.push({ kind: "i", v: words(nb) }, { kind: "i", v: words(nb).map((x) => ~x) });
    parts.push({ kind: "f", v: floats(B, 1) }, { kind: "f", v: floats(B, 0) });
  }
  parts.push({ kind: "i", v: words(W * 3) }, { kind: "f", v: floats(W, 1) }, { kind: "f", v: floats(W, 0) });
  parts.push({ kind: "i", v: words(32) }, { kind: "f", v: floats(32, 1) }, { kind: "f", v: floats(32, 0) });
  parts.push({ kind: "f", v: floats(32, 0.5) }, { kind: "f", v: [0.25] });
  const n = parts.reduce((a, p) => a + p.v.length, 0);
  const buf = new ArrayBuffer(32 + 4 * n);
  const view = new DataView(buf);
  view.setUint32(0, 0x32315045, true);
  for (const [k, v] of [2, B, nb, W, 32].entries()) view.setUint32(4 + 4 * k, v, true);
  view.setFloat32(24, 0.125, true);
  view.setUint32(28, cap, true);
  let at = 32;
  for (const p of parts)
    for (const v of p.v) {
      if (p.kind === "i") view.setInt32(at, v, true);
      else view.setFloat32(at, v, true);
      at += 4;
    }
  return new Uint8Array(buf);
}

describe("pool-pair (M12, D1002)", () => {
  test("grams hash as the trainer's zlib.crc32 does, accents included", () => {
    // From Python: sorted(grams(["strike", "called", "off", "café"])) with 2^15 buckets (pairnet.py).
    const want = [
      928, 1045, 1225, 1309, 1525, 2296, 2722, 3862, 4659, 6247, 6475, 8569, 10240, 10610, 12094, 14181, 14264, 14792,
      15068, 15666, 16245, 17077, 17256, 17391, 17795, 18290, 20709, 21134, 21489, 22123, 24653, 25065, 25729, 27102,
      27135, 27651, 29359, 30710, 31693, 32026,
    ];
    expect(Array.from(gramsOf(["strike", "called", "off", "café"], 1 << 15))).toEqual(want);
    expect(Array.from(gramsOf([], 64))).toEqual([0]);
  });

  test("a malformed file is refused", () => {
    expect(() => loadPoolPair(new Uint8Array(40))).toThrow("not an EP12");
    const good = tiny(8, (k) => k * 2654435761);
    expect(() => loadPoolPair(good.subarray(0, good.length - 4))).toThrow();
  });

  test("codes are deterministic, the scan peaks on identical codes, and the item cap reads only the head", () => {
    const net = loadPoolPair(tiny(64, (k) => k * 2654435761));
    const a = net.code(["strike", "thursday"], "request");
    expect(Array.from(net.code(["strike", "thursday"], "request"))).toEqual(Array.from(a));
    expect(net.scan(a, a)).toBeCloseTo(32 * 0.125, 6);
    expect(net.scan(a, Int32Array.from(a, (x) => ~x))).toBeCloseTo(-32 * 0.125, 6);
    expect(Number.isFinite(net.score(a, net.itemCode(["strike"], ["no", "services"])))).toBe(true);
    const capped = loadPoolPair(tiny(64, (k) => k * 2654435761, 2));
    const long = capped.itemCode(["notice"], ["one", "two", "three", "four"]);
    const cut = capped.itemCode(["notice"], ["one", "two"]);
    expect(Array.from(long)).toEqual(Array.from(cut));
  });
});
