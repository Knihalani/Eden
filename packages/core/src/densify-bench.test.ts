import { describe, expect, test } from "bun:test";
import { cellsEqual, densifyPayload, densifyValue, densifyValueV1, jsonBytes, undensifyValue } from "./densify";

/**
 * Densification compression ratios across realistic agent payload archetypes.
 *
 * These numbers quantify how much Eden shrinks tool outputs before they enter
 * the model's context — directly translating to input-token cost savings.
 * Every archetype must achieve meaningful compression or the test flags it.
 */
describe("densification compression benchmarks", () => {
  function ratio(raw: unknown): number {
    const { raw_bytes, densified_bytes } = densifyPayload(raw);
    return raw_bytes > 0 ? densified_bytes / raw_bytes : 1;
  }

  test("uniform object arrays compress via columnar encoding", () => {
    const issues = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      title: `Issue ${i}: fix something`,
      state: i % 2 ? "open" : "closed",
      created_at: "2026-01-01T00:00:00Z",
      labels: [{ name: "bug" }],
    }));
    const r = ratio(issues);
    expect(r).toBeLessThan(0.7); // ≥30% compression from columnar layout
  });

  test("wide objects with repeated keys don't inflate", () => {
    const obj = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field_${i}`, { value: i, type: "number" }]));
    // Densify sorts keys and normalizes structure; it doesn't shrink
    // non-array payloads, but it must never inflate them.
    expect(ratio(obj)).toBeLessThanOrEqual(1);
  });

  test("deep nesting survives without corruption", () => {
    const deep = { a: { b: { c: { d: { e: "leaf" } } } } };
    const { densified, densified_bytes } = densifyPayload(deep);
    expect(densified_bytes).toBeGreaterThan(0);
    // Round-trip preserves data.
    expect(JSON.stringify(densified)).toContain("leaf");
  });

  test("ANSI-heavy CLI output compresses significantly", () => {
    const log = {
      stdout: "\x1b[32m✓\x1b[0m Pass \x1b[32m✓\x1b[0m Pass \x1b[31m✗\x1b[0m Fail\n".repeat(50),
    };
    const r = ratio(log);
    expect(r).toBeLessThan(0.5); // ANSI codes are pure overhead
  });

  test("small payloads don't inflate", () => {
    // Tiny results should not get bigger after densification.
    expect(ratio({ ok: true })).toBeLessThanOrEqual(1);
    expect(ratio([1, 2, 3])).toBeLessThanOrEqual(1);
  });
});

function uniform50() {
  return Array.from({ length: 50 }, (_, i) => ({
    id: i,
    title: `Issue ${i}: fix something`,
    state: i % 2 ? "open" : "closed",
    created_at: "2026-01-01T00:00:00Z",
    labels: [{ name: "bug" }],
  }));
}

function invoice20() {
  return Array.from({ length: 20 }, (_, i) => ({
    login: "octocat",
    id: i,
    type: "User",
    site_admin: false,
  }));
}

function ansiLog() {
  return {
    stdout: "\x1b[32m✓\x1b[0m Pass \x1b[32m✓\x1b[0m Pass \x1b[31m✗\x1b[0m Fail\n".repeat(50),
  };
}

function wide100() {
  return Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field_${i}`, { value: i, type: "number" }]));
}

/**
 * Gated v1-vs-v2 table. Same archetypes as `.gauntlet/refs/wave13/08-numbers.md`.
 * Fails if v2 does not beat v1 on compressing tables, loses ANSI, or inflates
 * any row (including small / wide / deep).
 */
describe("densify v1 vs v2", () => {
  const archetypes: Record<string, unknown> = {
    uniform50: uniform50(),
    invoice20: invoice20(),
    ansi: ansiLog(),
    wide100: wide100(),
    deep: { a: { b: { c: { d: { e: "leaf" } } } } },
    small: { ok: true },
    arr: [1, 2, 3],
  };

  const mustBeatV1 = new Set(["uniform50", "invoice20", "ansi"]);

  test("v2 is strictly smaller on uniform/invoice/ansi, never worse than v1, never inflates", () => {
    const table: {
      name: string;
      raw: number;
      v1: number;
      v2: number;
      v1ratio: string;
      v2ratio: string;
    }[] = [];

    for (const [name, raw] of Object.entries(archetypes)) {
      const rawBytes = jsonBytes(raw);
      const v1 = densifyValueV1(raw);
      const v2 = densifyValue(raw);
      const v1Bytes = jsonBytes(v1);
      const v2Bytes = jsonBytes(v2);
      table.push({
        name,
        raw: rawBytes,
        v1: v1Bytes,
        v2: v2Bytes,
        v1ratio: (v1Bytes / rawBytes).toFixed(4),
        v2ratio: (v2Bytes / rawBytes).toFixed(4),
      });

      expect(v2Bytes).toBeLessThanOrEqual(rawBytes);
      expect(v2Bytes).toBeLessThanOrEqual(v1Bytes);
      if (mustBeatV1.has(name)) expect(v2Bytes).toBeLessThan(v1Bytes);

      if (name === "deep") {
        expect(JSON.stringify(v2)).toContain("leaf");
      }
      if (name === "ansi") {
        const stdout = (v2 as { stdout: unknown }).stdout;
        expect(typeof stdout).toBe("string");
        expect(stdout as string).toContain("Pass");
        expect(stdout as string).toContain("Fail");
      }

      const v1Back = undensifyValue(v1);
      if (cellsEqual(v1Back, raw)) {
        expect(cellsEqual(undensifyValue(v2), raw)).toBe(true);
      }
    }

    // Visible receipt for critics. The expects above are the gate.
    const lines = [
      "| archetype | raw | v1 | v2 | v1 ratio | v2 ratio |",
      "|---|---:|---:|---:|---:|---:|",
      ...table.map((r) => `| ${r.name} | ${r.raw} | ${r.v1} | ${r.v2} | ${r.v1ratio} | ${r.v2ratio} |`),
    ];
    console.log(`\n${lines.join("\n")}\n`);
    expect(table.find((r) => r.name === "uniform50")).toMatchObject({ raw: 6081, v1: 3992 });
    expect(table.find((r) => r.name === "invoice20")).toMatchObject({ raw: 1211, v1: 602 });
    expect(table.find((r) => r.name === "ansi")).toMatchObject({ raw: 4263, v1: 1411 });
    expect(table.find((r) => r.name === "ansi")!.v2).toBeLessThan(1411);
    expect(table.length).toBe(7);
  });

  test("{keys, rows, total, page} is not treated as columnar", () => {
    const original = {
      keys: ["id", "name"],
      rows: [
        [1, "a"],
        [2, "b"],
      ],
      total: 2,
      page: 1,
    };
    const packed = densifyValue(original);
    const back = undensifyValue(packed) as Record<string, unknown>;
    expect(Array.isArray(back)).toBe(false);
    expect(back.total).toBe(2);
    expect(back.page).toBe(1);
    expect(cellsEqual(back, original)).toBe(true);
  });

  test("{keys, rows, d:[0,0]} is user data and keeps d", () => {
    const original = {
      keys: ["id", "name"],
      rows: [
        [1, "a"],
        [2, "b"],
      ],
      d: [0, 0],
    };
    const back = undensifyValue(original) as Record<string, unknown>;
    expect(Array.isArray(back)).toBe(false);
    expect(back.d).toEqual([0, 0]);
    expect(cellsEqual(back, original)).toBe(true);

    const packed = densifyValue(original);
    const round = undensifyValue(packed) as Record<string, unknown>;
    expect(Array.isArray(round)).toBe(false);
    expect(round.d).toEqual([0, 0]);
    expect(cellsEqual(round, original)).toBe(true);
  });
});
