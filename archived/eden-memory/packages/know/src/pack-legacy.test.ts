import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allFacts, decodePack, encodePack, encodePackV1 } from "./pack";

const facts = [
  { s: "RFC 3986", p: "is" as const, o: "Uniform Resource Identifier (URI): Generic Syntax", e: "", url: "" },
  { s: "France", p: "capital" as const, o: "Paris", e: "", url: "" },
];

const FIX = join(import.meta.dir, "fixtures/kpk1.kpk");

describe("legacy pack magics", () => {
  test("KPK1 fixture decodes full RFC title", () => {
    if (!existsSync(FIX)) writeFileSync(FIX, encodePackV1(facts));
    const buf = readFileSync(FIX);
    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe("KPK1");
    expect(decodePack(buf).search("RFC 3986")[0]?.o).toContain("URI");
  });

  test("encodePackV1 roundtrip is KPK1", () => {
    const buf = encodePackV1(facts);
    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe("KPK1");
    expect(decodePack(buf).search("France")[0]?.o).toBe("Paris");
  });

  test("current encode is KPK9", () => {
    const buf = encodePack(facts);
    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe("KPK9");
    expect(decodePack(buf).search("RFC 3986")[0]?.o).toContain("URI");
  });

  test("historical KPK5/6/7 dumps decode when present", () => {
    const samples: [string, string][] = [
      ["KPK5", join(import.meta.dir, "../../../.gauntlet/baseline/graph.kpk")],
      ["KPK6", join(import.meta.dir, "../../../.gauntlet/captures/graph.kpk")],
      ["KPK7", join(import.meta.dir, "../../../.gauntlet/baseline/know-pack.kpk")],
    ];
    let n = 0;
    for (const [magic, path] of samples) {
      if (!existsSync(path)) continue;
      const buf = readFileSync(path);
      const got = new TextDecoder().decode(buf.subarray(0, 4));
      if (got !== magic) continue;
      const p = decodePack(buf);
      expect(p.nTriples).toBeGreaterThan(0);
      n++;
    }
    if (n === 0) return;
  });

  test("launch exact-closed dump does not invent the IANA universe", () => {
    const path = join(import.meta.dir, "../../../.gauntlet/baseline/know-launch/graph.kpk");
    if (!existsSync(path)) return;
    const buf = readFileSync(path);
    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe("KPK9");
    const p = decodePack(buf);
    const facts = allFacts(p);
    expect(p.nTriples).toBe(8299);
    expect(facts.length).toBe(8299);
    expect(facts.filter((f) => f.s.startsWith("IANA media ")).length).toBe(15);
    expect(facts.filter((f) => f.s.startsWith("SPDX ")).length).toBe(14);
    expect(facts.filter((f) => /^IANA scheme /i.test(f.s)).length).toBe(16);
    expect(p.search("application/json")[0]?.o).toBe("JSON");
    expect(facts.some((f) => f.s === "IANA media application/vnd.fiduswriter+zip")).toBe(false);
    expect(facts.some((f) => f.s === "IANA header ID")).toBe(false);
  });
});
