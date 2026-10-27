/**
 * Searches the secret gate for inputs that cost more than linear time: every rule as `spans` runs it (matches, the
 * re-match for the secret, allowlists), every allowlist regex on its own (a "line" target can be a whole line), and
 * redact(). For each target, input families built from its first keywords and runs of 47 units (characters and
 * fragments the rules' classes take, PEM banners, URL and token prefixes) are timed at 2,000 and 8,000 characters:
 * linear grows ~4x, quadratic ~16x. Prints targets that grew > 8x to over 0.5 ms, or cost over 20 ms at 8,000.
 *
 *   bun packages/primitives/bench/redos.scan.ts [js|d23]     (js: every regex on JavaScript, as before D24)
 *
 * A search, not a proof: it found what D24 fixes, and a clean run says only that these families find nothing.
 */
import { redact } from "../../redact/src/redact";
import { backtrackingEngine, everywhere, GATE_ENGINES, rulesWith, type EngineChoice } from "../../redact/src/secrets";
import gitleaks from "../../redact/src/vendor/gitleaks/gitleaks.toml";

const choice: EngineChoice = process.argv[2] === "js" ? everywhere(backtrackingEngine) : GATE_ENGINES;

// prettier-ignore
const UNITS = [
  "a", "A", "0", "f", "/", "+", "=", "-", ".", "_", " ", "\t", "\n", "'", '"', ":", "@", ";", ",", "a0", "a.", "a-",
  "a ", "a=", "=a", "aA0", "\\n", "${", "{", "a:", "ab/", "a\n", "0-", "a_", "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----\n", "eyJ", "AKIA", "sk-", "a://", "a.a", "Bearer ", "key", "x-", "aa@", "a:a@", "}",
];

interface Target {
  id: string;
  words: string[];
  run(text: string): unknown;
}
const targets: Target[] = rulesWith(choice).map((rule) => ({
  id: rule.id,
  words: [...new Set([...rule.keywords, ...rule.prefilter])].slice(0, 3),
  run: (text) => rule.spans(text),
}));
const config = gitleaks as {
  allowlist: { regexes?: string[] };
  rules: { id: string; allowlists?: { regexes?: string[] }[] }[];
};
const lists: [string, { regexes?: string[] }][] = [
  ["global", config.allowlist],
  ...config.rules.flatMap((rule) =>
    (rule.allowlists ?? []).map((list): [string, { regexes?: string[] }] => [rule.id, list]),
  ),
];
for (const [owner, list] of lists) {
  for (const source of list.regexes ?? []) {
    const pattern = choice.allowlist(source);
    targets.push({
      id: `allowlist of ${owner}: ${source.slice(0, 40)}`,
      words: [""],
      run: (text) => pattern.test(text),
    });
  }
}
targets.push({ id: "redact()", words: ["", "password=", "PRIVATE KEY"], run: (text) => redact(text) });

const repeat = (unit: string, length: number) =>
  unit.repeat(Math.ceil(length / Math.max(1, unit.length))).slice(0, length);
function families(words: string[]): [string, (n: number) => string][] {
  const out: [string, (n: number) => string][] = [];
  for (const word of words.length ? words : [""]) {
    for (const unit of UNITS) {
      const w = JSON.stringify(word);
      const u = JSON.stringify(unit);
      out.push([`${w}= + ${u}* + !`, (n) => `${word}=` + repeat(unit, n) + "!"]);
      out.push([`(${w} + ${u})*`, (n) => repeat(`${word}${unit}`, n)]);
      out.push([`(${w}=" + ${u}x8)*`, (n) => repeat(`${word}="${unit.repeat(8)}`, n)]);
      out.push([`${u}* + ${w}`, (n) => repeat(unit, n - word.length) + word]);
    }
  }
  return out;
}

/** Best of three, so one GC pause is not a finding. */
function time(run: (text: string) => unknown, text: string): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    run(text);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

const t0 = performance.now();
const flagged = new Map<string, { family: string; t2: number; t8: number }>();
for (const target of targets) {
  for (const [family, make] of families(target.words)) {
    if (time(target.run, make(500)) > 200) {
      flagged.set(target.id, { family, t2: Infinity, t8: Infinity });
      break;
    }
    const t2 = time(target.run, make(2_000));
    const t8 = time(target.run, make(8_000));
    const bad = (t8 / Math.max(t2, 0.001) > 8 && t8 > 0.5) || t8 > 20;
    if (bad && t8 > (flagged.get(target.id)?.t8 ?? 0)) flagged.set(target.id, { family, t2, t8 });
  }
}
const seconds = ((performance.now() - t0) / 1_000).toFixed(0);
console.log(`${targets.length} targets, ${process.argv[2] ?? "d23"} engines, ${seconds} s; flagged: ${flagged.size}`);
for (const [id, f] of [...flagged].sort((a, b) => b[1].t8 - a[1].t8)) {
  console.log(`  ${id}: worst ${f.family}: 2k ${f.t2.toFixed(2)} ms, 8k ${f.t8.toFixed(2)} ms`);
}
