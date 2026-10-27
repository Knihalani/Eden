/**
 * Where the TS gate's time goes: which rules pass the keyword gate on benign email and what each one's `spans()`
 * costs; the keyword gate itself (`toLowerCase` + one `includes` per keyword, as secrets.ts does it); and a
 * single-pass alternative in plain TS (one regex over every keyword), checked to select the same rules on the
 * secret corpus, then timed end to end like `gitleaksHits`.
 */
import { secretCorpus, THREE_SECRETS } from "./lib/corpus";
import { emailText } from "./lib/gen";
import { bench, perKiB, table, type Stats } from "./lib/harness";
import { gitleaksHits } from "./lib/ts-secrets";
import { secretRules, type SecretRule } from "../../packages/redact/src/secrets";

const rules = secretRules();
const gitleaks = rules.filter((rule) => !rule.id.startsWith("eden-"));

/** The keyword gate as secrets.ts runs it. */
function includesGate(text: string, from: SecretRule[]): SecretRule[] {
  const lower = text.toLowerCase();
  return from.filter((rule) => !rule.keywords.length || rule.keywords.some((word) => lower.includes(word)));
}

// Single pass: a zero-width lookahead tries every position; alternatives go longest first, so each position reports
// the longest keyword starting there, and every keyword that starts there is a prefix of that one.
const keywords = [...new Set(rules.flatMap((rule) => rule.keywords))].sort((a, b) => b.length - a.length);
const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const KEYWORDS = new RegExp(`(?=(${keywords.map(escape).join("|")}))`, "gi");
const prefixes = new Map(keywords.map((word) => [word, keywords.filter((other) => word.startsWith(other))]));

function regexGate(text: string, from: SecretRule[]): SecretRule[] {
  const found = new Set<string>();
  for (const match of text.matchAll(KEYWORDS)) {
    for (const word of prefixes.get(match[1]!.toLowerCase())!) found.add(word);
  }
  return from.filter((rule) => !rule.keywords.length || rule.keywords.some((word) => found.has(word)));
}

const regexGateHits = (text: string) =>
  regexGate(text, gitleaks)
    .filter((rule) => rule.spans(text).length > 0)
    .map((rule) => rule.id)
    .sort();

// Cross-check: the same rules pass both gates, and the same rules fire, on every corpus text.
let mismatches = 0;
for (const { name, text } of secretCorpus()) {
  const a = includesGate(text, rules).map((rule) => rule.id);
  const b = regexGate(text, rules).map((rule) => rule.id);
  if (a.join() !== b.join()) {
    mismatches++;
    console.log(`MISMATCH gate on ${name}: includes [${a}] vs regex [${b}]`);
  }
  if (gitleaksHits(text).join() !== regexGateHits(text).join()) {
    mismatches++;
    console.log(`MISMATCH hits on ${name}`);
  }
}
console.log(
  `single-regex keyword gate vs includes gate on ${secretCorpus().length} corpus texts: ${mismatches} mismatches`,
);

const text = emailText(2048);
const gated = includesGate(text, rules);
console.log(`${gated.length} of ${rules.length} rules pass the keyword gate on the 2 KiB benign ASCII email`);
const rows: (Stats & { extra: Record<string, string> })[] = [];
const lower = text.toLowerCase();
for (const rule of gated) {
  const hit = rule.keywords.find((word) => lower.includes(word)) ?? "(none: always runs)";
  rows.push({ ...bench(`${rule.id}.spans()`, () => rule.spans(text).length), extra: { "keyword hit": hit } });
}
table("TS gate profile: rules that run on benign ASCII 2 KiB", rows);

const inputs: [string, string][] = [
  ["benign ASCII 256 B", emailText(256)],
  ["benign ASCII 2 KiB", text],
  ["benign non-ASCII 2 KiB", emailText(2048, true)],
  ["benign ASCII 16 KiB", emailText(16384)],
  ["3 secrets ~2 KiB", THREE_SECRETS],
];
const gates: (Stats & { extra: Record<string, string> })[] = [];
for (const [label, input] of inputs) {
  const bytes = new TextEncoder().encode(input).length;
  const cases: [string, () => number][] = [
    ["keyword gate, includes per keyword (as secrets.ts)", () => includesGate(input, rules).length],
    ["keyword gate, one regex", () => regexGate(input, rules).length],
    ["TS gitleaks rules, includes gate", () => gitleaksHits(input).length],
    ["TS gitleaks rules, one-regex gate", () => regexGateHits(input).length],
  ];
  for (const [name, op] of cases) {
    const stats = bench(`${label}: ${name}`, op);
    gates.push({ ...stats, extra: { "ns/KiB": perKiB(stats.meanNs, bytes) } });
  }
}
table("TS keyword gate: includes per keyword vs one regex", gates);
