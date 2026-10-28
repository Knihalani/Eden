import { describe, expect, test } from "bun:test";
import { buildShape, inert, SHAPES, type ShapeOptions } from "./shapes";

const plain: ShapeOptions = { quotes: false };
const cue = { text: "prep globex call sam ortiz", entities: ["Globex", "Sam Ortiz"] };

describe("query shapes", () => {
  test("each shape phrases the same cue as the connector lab's variants did", () => {
    const frequency = (t: string) => ({ prep: 50, call: 40 })[t] ?? 0;
    expect(buildShape("terms", cue, plain)).toEqual(["prep globex call sam ortiz"]);
    expect(buildShape("entities", cue, plain)).toEqual(["Globex Sam Ortiz"]);
    expect(buildShape("each-entity", cue, plain)).toEqual(["Globex", "Sam Ortiz"]);
    expect(buildShape("entity+term", cue, { ...plain, frequency })).toEqual(["Globex call"]);
    expect(buildShape("phrase", cue, plain)).toEqual([]);
    expect(buildShape("phrase", cue, { quotes: true })).toEqual(["Globex", '"Sam Ortiz"']);
  });

  test("entity shapes do not apply without entities, and each-entity is capped", () => {
    const none = { text: "what time is it", entities: [] };
    for (const s of ["entities", "each-entity", "entity+term", "phrase"] as const) {
      expect(buildShape(s, none, { quotes: true })).toEqual([]);
    }
    const many = { text: "a", entities: ["Ana", "Bo", "Cy", "Di", "ana"] };
    expect(buildShape("each-entity", many, plain)).toEqual(["Ana", "Bo", "Cy"]);
    expect(buildShape("each-entity", many, { ...plain, maxCalls: 5 })).toEqual(["Ana", "Bo", "Cy", "Di"]);
  });

  test("operators in cue text never become syntax", () => {
    expect(inert('in:trash OR from:boss -label:work "secret" (a AND b) c* d~2 e^3 f\\g')).toBe(
      "in trash from boss label work secret a b c d 2 e 3 f g",
    );
    expect(inert("OPS-142 dana.lee@acme.com #launch")).toBe("OPS-142 dana.lee@acme.com #launch");
    expect(inert("project = EDEN ORDER BY created; DROP TABLE x")).toBe("project EDEN ORDER BY created DROP TABLE x");
    expect(inert("or and not")).toBe("or and not"); // Lower case is a word in every syntax checked.
    expect(inert("50% off a%b snake_case")).toBe("50 off a b snake_case"); // LIKE's % is dropped; see inert() on _.
    // A phrase shape quotes only after the inner text is inert: no quote from the input survives.
    expect(buildShape("phrase", { text: "", entities: ['Sam" OR "x'] }, { quotes: true })).toEqual(['"Sam x"']);
  });

  test("fuzz: every built query is inert, bounded, and only phrase adds quotes", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = "abcXYZ019 -+:\"'()[]{}<>*?~^\\|&!=;,/.@#“”OR AND NOT NEAR é漢";
    const piece = (n: number) =>
      Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
    for (let i = 0; i < 3_000; i++) {
      const input = {
        text: piece(Math.floor(rnd() * 400)),
        entities: Array.from({ length: Math.floor(rnd() * 5) }, () => piece(1 + Math.floor(rnd() * 300))),
      };
      for (const shape of SHAPES) {
        for (const q of buildShape(shape, input, { quotes: rnd() < 0.5, maxCalls: 3 })) {
          const body = shape === "phrase" && q.startsWith('"') ? q.slice(1, -1) : q;
          expect(body).not.toMatch(/["'`:()[\]{}<>*?~^\\|&!=;,/%“”]/);
          expect(body.split(" ").some((w) => ["AND", "OR", "NOT", "NEAR", "TO"].includes(w))).toBe(false);
          expect(body.split(" ").some((w) => /^[-+]/.test(w))).toBe(false);
          expect(q.length).toBeGreaterThan(0);
          expect(q.length).toBeLessThanOrEqual(258);
        }
      }
    }
  });
});
