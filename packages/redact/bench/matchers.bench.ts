/**
 * The gate's own matchers (D1705) against re2js, matcher by matcher: each scanned rule's `matches` plus the gate's
 * re-match of each found match (`groups`), and each allowlist regex's `test`. Typical: the differential fuzz's texts
 * (a few hundred characters each, a third or so holding a match), timed over the whole set. Crafted: one call on
 * 128 KB and 1 MB runs of units built against the matcher, on a fresh string each time (re2js keeps per-string state:
 * a second call on the same string returned in ~0 ms, so a repeated string would flatter it). Both engines warmed
 * on the typical set first.
 *
 *   bun packages/redact/bench/matchers.bench.ts
 */
import { compileAllowlistRegex } from "../src/automaton.ts";
import { allowlistRegexes, allowlistText, prng, ruleText } from "../src/differential.ts";
import { parseRegex } from "../src/automaton.ts";
import { linearEngine } from "../src/re2-oracle.ts";
import { SCANNERS } from "../src/scanners.ts";
import type { Pattern } from "../src/secrets.ts";

let salt = 0;
/**
 * A fresh string of `size` characters: `unit` repeated, then a distinct tail so no engine sees it twice. Flattened
 * (one `charCodeAt` pass) before it is timed, so neither engine pays for building it.
 */
const fresh = (unit: string, size: number) => {
  const text =
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size - 8) + `#${(salt++).toString(36).padStart(7, "0")}`;
  let sum = 0;
  for (let i = 0; i < text.length; i += 64) sum += text.charCodeAt(i);
  return sum >= 0 ? text : "";
};
const time = (fn: () => void) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};
/** What the gate asks of a rule's pattern: every match, then the groups of each match on its own. */
const gateUse = (pattern: Pattern, text: string) => {
  for (const [start, end] of pattern.matches(text)) pattern.groups(text.slice(start, end));
};

const KEYWORD: Record<string, string> = {
  "cisco-meraki-api-key": "meraki",
  "cohere-api-token": "cohere",
  "okta-access-token": "okta",
  "privateai-api-token": "private_ai",
  "sumologic-access-id": "sumo",
};
const unitsFor = (id: string): string[] => {
  if (id.startsWith("curl-")) {
    return [
      "curl ",
      "curl -u ",
      'curl -u "',
      "curl -H ",
      'curl -H "',
      "curl\r\n\r\n -H 'X-Api-Key: ",
      'curl -u "abc:def" ',
      "curl -H 'Token: abcdefghij' ",
    ];
  }
  const w = KEYWORD[id]!;
  // The last unit matches: a value of the rule's own shape (entropy aside).
  const secret = { okta: `00${"aB3_".repeat(10)}`, sumo: `su${"aB3d".repeat(3)}`, private_ai: "a1b2c3d4".repeat(4) }[w];
  return [
    `${w}=`,
    `${w}0`,
    `${w} `,
    `${w}:::`,
    `${"a".repeat(55)}${w}`,
    `${w}=${"0".repeat(39)} `,
    `${w}=${secret ?? "0a1b2c3d4e".repeat(4)} `,
  ];
};

console.log(
  "| Rule | typical (texts) own / re2js ms | worst crafted 128 KB own / re2js ms | worst crafted 1 MB own / re2js ms |",
);
console.log("|---|---:|---:|---:|");
for (const [id, scanner] of SCANNERS) {
  const oracle = linearEngine(scanner.regex);
  const rnd = prng(41);
  const texts = Array.from({ length: 300 }, () => ruleText(rnd, id));
  for (const text of texts) (gateUse(scanner.pattern, text), gateUse(oracle, text));
  const typicalOwn = Math.min(...[0, 1, 2].map(() => time(() => texts.forEach((t) => gateUse(scanner.pattern, t)))));
  const typicalRe2 = Math.min(...[0, 1, 2].map(() => time(() => texts.forEach((t) => gateUse(oracle, t)))));
  const worst = (size: number) => {
    let own = 0;
    let re2 = 0;
    for (const unit of unitsFor(id)) {
      const a = fresh(unit, size);
      const b = fresh(unit, size);
      own = Math.max(
        own,
        time(() => gateUse(scanner.pattern, a)),
      );
      re2 = Math.max(
        re2,
        time(() => gateUse(oracle, b)),
      );
    }
    return `${own.toFixed(1)} / ${re2.toFixed(1)}`;
  };
  console.log(
    `| ${id} | ${typicalOwn.toFixed(1)} / ${typicalRe2.toFixed(1)} | ${worst(131_072)} | ${worst(1_048_576)} |`,
  );
}

console.log("\n| Allowlist regexes | typical own / re2js ms | worst crafted 128 KB own / re2js ms | which |");
console.log("|---|---:|---:|---|");
let typicalOwn = 0;
let typicalRe2 = 0;
let worstOwn = { ms: 0, source: "" };
let worstRe2 = { ms: 0, source: "" };
for (const [i, source] of allowlistRegexes().entries()) {
  const own = compileAllowlistRegex(source);
  const oracle = linearEngine(source);
  const node = parseRegex(source);
  const pieces = source.split(/\\[a-zA-Z]|[()[\]|?*+{}^$\\]/).filter((piece) => piece.length > 0);
  const rnd = prng(100 + i);
  const texts = Array.from({ length: 300 }, () => allowlistText(rnd, node, pieces.length ? pieces : ["x"]));
  for (const text of texts) (own.test(text), oracle.test(text));
  typicalOwn += Math.min(...[0, 1, 2].map(() => time(() => texts.forEach((t) => own.test(t)))));
  typicalRe2 += Math.min(...[0, 1, 2].map(() => time(() => texts.forEach((t) => oracle.test(t)))));
  for (const unit of [...pieces.map((p) => p.slice(0, 12)), "a", " ", ":", "a:", "\n---\n", "{{", "\u017f"]) {
    const [x, y] = [fresh(unit, 131_072), fresh(unit, 131_072)];
    const a = time(() => own.test(x));
    const b = time(() => oracle.test(y));
    if (a > worstOwn.ms) worstOwn = { ms: a, source: `${source.slice(0, 24)} on ${JSON.stringify(unit)}` };
    if (b > worstRe2.ms) worstRe2 = { ms: b, source: `${source.slice(0, 24)} on ${JSON.stringify(unit)}` };
  }
}
console.log(
  `| all ${allowlistRegexes().length}, 300 texts each | ${typicalOwn.toFixed(1)} / ${typicalRe2.toFixed(1)} | ` +
    `${worstOwn.ms.toFixed(1)} / ${worstRe2.ms.toFixed(1)} | own: ${worstOwn.source}; re2js: ${worstRe2.source} |`,
);
