/**
 * D1850: generic-api-key's REST read by hand (generic-rest.ts) ends every match where the regex, made sticky, ends
 * it, at every position of seeded texts built from the regex's own pieces (each boundary: 10, 11, 150, 151
 * characters; 3 and 4 `=`; every operator; the terminators; the characters the classes split on). The whole gate's
 * differential (gate-differential.ts) checks it in place.
 */
import { describe, expect, test } from "bun:test";
import { prng } from "./differential.ts";
import { freshRuns, GENERIC_REST_SOURCE, genericRest } from "./generic-rest.ts";
import { CRAFTED_UNITS, crafted } from "./gate-crafted.ts";

const REST = new RegExp(GENERIC_REST_SOURCE, "iy");
const regexEnd = (text: string, k: number) => {
  REST.lastIndex = k;
  return REST.test(text) ? REST.lastIndex : -1;
};

const PIECES = [
  ..."key KEY Key api Api API aPi apI access Auth credential creds CREDS passwd password PassWord secret token tok".split(
    " ",
  ),
  " ",
  "\t",
  "  ",
  " ",
  "\n",
  "\r\n",
  "'",
  '"',
  "`",
  ";",
  ".",
  "-",
  "_",
  "x",
  "9",
  "=",
  ">",
  ":",
  "::",
  ":::",
  "::::",
  ":=",
  "::=",
  ":::=",
  "::::=",
  "||",
  "|",
  "=>",
  "?=",
  "?",
  ",",
  "+",
  "/",
  "==",
  "===",
  "====",
  "\\n",
  "\\r",
  "\\N",
  "\\x",
  "ſ",
  "K",
  "é",
];
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

describe("generic-api-key's REST by hand", () => {
  test("ends where the regex ends, at every position of 4,000 texts", () => {
    const rnd = prng(1850);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    let matched = 0;
    for (let n = 0; n < 4_000; n++) {
      let text = "";
      for (let parts = 1 + Math.floor(rnd() * 10); parts > 0; parts--) {
        const r = rnd();
        if (r < 0.2) {
          // A whole assignment, so most texts hold matches: keyword, filler, operator, quote, value, end.
          const value = Array.from({ length: pick([9, 10, 11, 12, 30, 150, 151]) }, () =>
            pick([...ALNUM, "+", "/", ".", "=", "-"]),
          ).join("");
          text +=
            pick(["key", "API", "token", "Secret", "passwd", "auth"]) +
            pick(["", " ", "_id", " \t ", ".x ", "'"]) +
            pick(["=", ":", "::=", "=>", "?=", "||", ",", ">", "::::="]) +
            pick(["", " ", "'", '"', "==", "  \t  ="]) +
            value +
            pick(["", " ", "'", ";", "\\n", "\\x", "==", "===", "====", "!"]);
        } else if (r < 0.4) {
          const len = pick([3, 9, 10, 11, 12, 20, 149, 150, 151, 152, 300]);
          const alphabet = pick([ALNUM, ALNUM + "+/", ALNUM + "._-=", "abcdef0123456789"]);
          for (let i = 0; i < len; i++) text += alphabet[Math.floor(rnd() * alphabet.length)];
        } else text += pick(PIECES);
      }
      const runs = freshRuns();
      for (let k = 0; k < text.length; k++) {
        const expected = regexEnd(text, k);
        if (expected >= 0) matched++;
        // A fresh cache and the one carried along both give the regex's answer.
        expect([text, k, genericRest(text, k, freshRuns())]).toEqual([text, k, expected]);
        expect([text, k, genericRest(text, k, runs)]).toEqual([text, k, expected]);
      }
    }
    expect(matched).toBeGreaterThan(1_000);
  }, 60_000);

  test("the crafted inputs at 16 KB", () => {
    for (const [name, unit] of CRAFTED_UNITS) {
      const text = crafted(unit, 16_384);
      const runs = freshRuns();
      for (let k = 0; k < text.length; k++) {
        const got = genericRest(text, k, runs);
        if (got !== regexEnd(text, k)) throw new Error(`${name} at ${k}: ${got} vs ${regexEnd(text, k)}`);
      }
    }
  }, 60_000);
});
