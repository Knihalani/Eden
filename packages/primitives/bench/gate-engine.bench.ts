/**
 * The secret gate three ways, end to end through `sanitizeForStore`: every gitleaks regex on JavaScript's
 * backtracking RegExp (before D24), every one on RE2 (re2js), and the gate since D24 (RE2 for RE2_RULES and the
 * allowlists, JavaScript for the rest). Typical texts with the harness, then inputs built against the rules that
 * backtrack, one call each at growing sizes (a curve stops once a call takes over 4 s). All three share the
 * prefilter, Eden's own rules and redact().
 *
 *   bun packages/primitives/bench/gate-engine.bench.ts
 */
import {
  backtrackingEngine,
  everywhere,
  GATE_ENGINES,
  gateOf,
  linearEngine,
  rulesWith,
  secretRules,
} from "../../redact/src/secrets";
import { bench, corpus } from "./harness";

const KEYWORD_DENSE =
  "Hi Dana, your api key for the staging account was rotated. The new access token is in the vault; do not paste " +
  "the password or the secret into Slack. Auth is via the SSO provider; the client secret and private key stay in " +
  "the KMS. If the token expires, ask Priya for a new key. Credentials for Globex: see the shared password manager. ";
const SECRETS =
  corpus(1_900).slice(0, 600) +
  ` here it is ${"gh" + "p_"}${"aB3dE5gH7jK9mN2pQ4sT6vW8yZ0123456789"} ` +
  corpus(1_900, { seed: 3 }).slice(0, 600) +
  ` and ${"AK" + "IA"}QWERTYUIOPASDFGH then ` +
  corpus(1_900, { seed: 5 }).slice(0, 600);

const gates = (
  [
    ["all JavaScript", everywhere(backtrackingEngine)],
    ["all RE2", everywhere(linearEngine)],
    ["D24 (targeted RE2)", GATE_ENGINES],
  ] as const
).map(([name, choice]) => {
  const t0 = performance.now();
  const rules = rulesWith(choice);
  for (const rule of rules) rule.spans("");
  console.log(`${name}: compile every rule (first use) ${(performance.now() - t0).toFixed(1)} ms`);
  return [name, gateOf(rules)] as const;
});

const typical: [string, string][] = [
  ["benign 256 B", corpus(256)],
  ["benign 2 KB", corpus(2_048)],
  ["benign 16 KB", corpus(16_384)],
  ["benign 2 KB, 10% non-ASCII", corpus(2_048, { nonAscii: true })],
  ["keyword-dense 2 KB", KEYWORD_DENSE.repeat(6).slice(0, 2_048)],
  ["2 secrets ~2 KB", SECRETS],
];
const fmt = (ns: number) => `${(ns / 1e3).toFixed(2)} µs`;
console.log(`\n| Text | ${gates.map(([name]) => `${name} mean (p99)`).join(" | ")} |\n|---|---:|---:|---:|`);
for (const [name, text] of typical) {
  const outputs = new Set(gates.map(([, gate]) => gate.sanitizeForStore(text)));
  if (outputs.size !== 1) throw new Error(`gates differ: ${name}`);
  const cells = gates.map(([, gate]) => bench(name, () => gate.sanitizeForStore(text), { batch: 5 }));
  console.log(`| ${name} | ${cells.map((r) => `${fmt(r.meanNs)} (${fmt(r.p99Ns)})`).join(" | ")} |`);
}

/** Random text over the rules' class characters, 5% gitleaks keywords: every rule runs, none backtracks badly. */
const JUNK = "keyword-saturated random text";
const KEYWORDS = [...new Set(secretRules().flatMap((rule) => rule.keywords))];
function junk(size: number): string {
  let x = 3;
  const rnd = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=._-:\"' \n\t@";
  let out = "";
  while (out.length < size) {
    out += rnd() < 0.05 ? KEYWORDS[Math.floor(rnd() * KEYWORDS.length)] : alphabet[Math.floor(rnd() * alphabet.length)];
  }
  return out.slice(0, size);
}

const attacks: [string, string, string][] = [
  ["sumologic-access-id", "sumox-", ""],
  ["okta-access-token", "okta0", ""],
  ["curl-auth-user", "curl ", ""],
  ["curl-auth-header", "curl=", ""],
  ["generic-api-key (`token` keyword)", "token0-", ""],
  ["eden-url-userinfo (JavaScript in all three; rewritten by D24)", "a-", "://"],
  [JUNK, "", ""],
];
console.log(
  "\nOne call, ms, by input size:\n\n| Input built against | Gate | 8 KB | 32 KB | 128 KB | 1 MB |\n|---|---|---:|---:|---:|---:|",
);
for (const [rule, unit, tail] of attacks) {
  for (const [name, gate] of gates) {
    const cells: string[] = [];
    for (const size of [8_192, 32_768, 131_072, 1_048_576]) {
      if (cells.some((cell) => cell.startsWith("skipped") || Number(cell) > 4_000)) {
        cells.push("skipped");
        continue;
      }
      const text =
        rule === JUNK ? junk(size) : unit.repeat(Math.ceil(size / unit.length)).slice(0, size - tail.length) + tail;
      const start = performance.now();
      gate.sanitizeForStore(text);
      cells.push((performance.now() - start).toFixed(1));
    }
    console.log(`| ${rule} | ${name} | ${cells.join(" | ")} |`);
  }
}
