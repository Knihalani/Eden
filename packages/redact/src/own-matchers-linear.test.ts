/**
 * D1705: no crafted input makes the gate's own matchers super-linear. The timing half of own-matchers.test.ts, in a
 * file of its own so a parallel test run runs it beside the exactness checks. CPU time, not wall time (D811): the work
 * done, whatever else shares the cores. Secret-shaped values are assembled from parts, so no literal here is one.
 */
import { describe, expect, test } from "bun:test";
import { compileAllowlistRegex } from "./automaton";
import { allowlistRegexes, prng } from "./differential";
import { linearEngine } from "./re2-oracle";
import { SCANNERS } from "./scanners";
import { GATE_ENGINES, gateOf, rulesWith } from "./secrets";

const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
/** CPU ms one call of `fn` cost. */
const cost = (fn: () => void) => {
  const t0 = cpuMs();
  fn();
  return cpuMs() - t0;
};

/**
 * 1 MB inputs: a scanner takes 5-130 ms on its worst unit here (packages/redact/bench/matchers.bench.ts), so a
 * quadratic slip shows: a colon search that ran to the text's end cost 18 ms at 128 KB, which is over a second at 1 MB.
 */
const SIZE = 1_048_576;
const CEILING_MS = 400;
const fill = (unit: string, size = SIZE) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

const KEYWORD: Record<string, string> = {
  "cisco-meraki-api-key": "meraki",
  "cohere-api-token": "cohere",
  "okta-access-token": "okta",
  "privateai-api-token": "private_ai",
  "sumologic-access-id": "sumo",
};
const assignmentUnits = (word: string) => [
  `${word}=`,
  `${word}0`,
  `${word} `,
  `${word}:::`,
  `${"a".repeat(55)}${word}`,
  `${"a".repeat(45)}\u017f${"a".repeat(10)}${word}`,
  `${word}${" ".repeat(20)}'''`,
  `${word}=${"`'\"= ".repeat(2)}`,
  `${word}=${"0".repeat(39)} `,
  `${word} = "${"0".repeat(41)}"`,
  `${word}\u212a\u017f.`,
  // Every keyword matches: the most work per character.
  `${word}=${"0a1b2c3d4e".repeat(4)} `,
];
const CURL_UNITS = [
  "curl ",
  "curl -u ",
  'curl -u "',
  "curl -u '",
  "curl -H ",
  'curl -H "',
  ' -u "a:',
  ' -H "Authorization: Bearer ',
  "curl\r\n\r\n -H 'X-Api-Key: ",
  "curl x\n",
  "curl \u2028 -u ",
  'curl -u "abc:def" ',
  "curl -H 'Authorization: Basic abcdefgh====' ",
];

describe("no crafted input makes an own matcher super-linear", () => {
  for (const [id, scanner] of SCANNERS) {
    test(`${id}: 1 MB runs of each crafted unit`, () => {
      for (const unit of id.startsWith("curl-") ? CURL_UNITS : assignmentUnits(KEYWORD[id]!)) {
        const text = fill(unit);
        // What the gate does: every match, then each match's groups.
        const ms = cost(() => {
          for (const [start, end] of scanner.pattern.matches(text)) scanner.pattern.groups(text.slice(start, end));
        });
        expect([unit, ms < CEILING_MS]).toEqual([unit, true]);
      }
    });
  }

  test("every allowlist regex: 256 KB runs of its own pieces", () => {
    for (const source of allowlistRegexes()) {
      const tester = compileAllowlistRegex(source);
      const pieces = [...new Set(source.split(/\\[a-zA-Z]|[()[\]|?*+{}^$\\]/).filter((piece) => piece.length > 0))];
      const units = [...pieces.map((piece) => piece.slice(0, 12)), "a", " ", ":", "a:", "\n---\n", "{{", "\u017f"];
      for (const unit of units) {
        const ms = cost(() => tester.test(fill(unit, 262_144)));
        expect([source, unit, ms < CEILING_MS]).toEqual([source, unit, true]);
      }
    }
  }, 30_000);

  test("the gate on 1 MB built against the scanned rules", () => {
    const gate = gateOf(rulesWith(GATE_ENGINES));
    // (The redos tests hold the rules on JavaScript's engine; these units reach the scanned rules.)
    for (const unit of ["okta0", "curl ", "meraki ", "cohere=", 'curl -u "a:', "private_ai:"]) {
      const text = fill(unit);
      expect([unit, cost(() => gate.sanitizeForStore(text)) < 2_000]).toEqual([unit, true]);
    }
  });

  test("the automaton stays right and linear when its state cache is dropped", () => {
    // `(a|b)*a(a|b){12}c` needs 2^13 DFA states: random a/b text overflows the 2,000-state cache many times over.
    const source = "(a|b)*a(a|b){12}c";
    const own = compileAllowlistRegex(source);
    const oracle = linearEngine(source);
    const rnd = prng(5);
    for (let i = 0; i < 6; i++) {
      let text = "";
      for (let j = 0; j < 20_000; j++) text += rnd() < 0.5 ? "a" : "b";
      if (i % 2 === 0) text += "c";
      let got = false;
      expect(cost(() => (got = own.test(text)))).toBeLessThan(CEILING_MS);
      expect(got).toBe(oracle.test(text));
    }
  });
});
