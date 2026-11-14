/**
 * Test support, not part of the gate: the seeded differential fuzz of the whole gate against the reference gate
 * (`secrets.reference.ts` and `redact.reference.ts`, the gate as it was before docs/research/redact-perf.md, kept
 * unchanged as the oracle). Each text is built from samples of every rule's regex (mutated or not), the literals the
 * gate's prefilter and anchors look for, Eden's own secret shapes, prose, separators and the characters engines
 * disagree on, then run through both gates: each rule's findings (ids and spans), `secretHits`, `sanitizeForStore`
 * and the structural redactor (`redactString`, `redact` on a JSON value) must be identical. `gate-differential.test.ts`
 * runs a few thousand texts; the full run is a command:
 *
 *   bun packages/redact/src/gate-differential.ts [texts, default 1000000] [seed, default 1]
 *   bun packages/redact/src/gate-differential.ts --corpus     # the realistic corpus (bench/corpus.ts), 256 B to 1 MB
 */
import { parseRegex, type RegexNode } from "./automaton";
import { ALNUM, mutate, ODD, prng, sample, sourcePieces } from "./differential";
import { redact, redactString, TOKEN_LITERALS } from "./redact";
import { redact as redactBefore, redactString as redactStringBefore } from "./redact.reference";
import { type Gate, gateOf, secretRules } from "./secrets";
import { gateOf as gateOfBefore, secretRules as secretRulesBefore } from "./secrets.reference";
import gitleaks from "./vendor/gitleaks/gitleaks.toml";

type Rnd = () => number;
const int = (rnd: Rnd, n: number) => Math.floor(rnd() * n);
const pick = <T>(rnd: Rnd, xs: readonly T[]): T => xs[int(rnd, xs.length)]!;
const draw = (rnd: Rnd, alphabet: string, n: number) => {
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[int(rnd, alphabet.length)]!;
  return out;
};

interface Vendored {
  rules: { id: string; regex?: string; keywords?: string[] }[];
}
const RULES = (gitleaks as Vendored).rules.filter((rule) => rule.regex);
/** Each rule's parse (for samples) and the literal pieces of its source (near misses); a parse that fails is null. */
const PARSED: { node: RegexNode | null; pieces: string[] }[] = RULES.map((rule) => {
  let node: RegexNode | null = null;
  try {
    node = parseRegex(rule.regex!);
  } catch {
    node = null;
  }
  return { node, pieces: sourcePieces(rule.regex!) };
});

/** Every word the gate's prefilter, anchors and token passes look for. */
const WORDS = [
  ...new Set([
    ...secretRules().flatMap((rule) => [...rule.prefilter, ...(rule.anchorWords ?? [])]),
    ...TOKEN_LITERALS,
    ...RULES.flatMap((rule) => rule.keywords ?? []),
  ]),
];

/** Randomly cased: the gate folds ASCII case, and the matcher also folds U+017F and U+212A. */
function recase(rnd: Rnd, word: string): string {
  const r = rnd();
  if (r < 0.4) return word;
  if (r < 0.6) return word.toUpperCase();
  let out = "";
  for (const char of word) {
    const c = rnd();
    out += c < 0.45 ? char.toUpperCase() : c < 0.9 ? char : char === "s" ? "ſ" : char === "k" ? "K" : char;
  }
  return out;
}

const SEPARATORS = [" ", "  ", "\n", "\r\n", "\t", "=", ": ", ":", " = ", '"', "'", '": "', "&", "?", ";", ",", "", ""];
const PROSE = [
  "Hi Dana, following up on the Globex renewal; Bill said Initech pays annually.",
  "Müller’s café booking for Zoë on Thursday at 3pm, ref OPS-142.",
  "the token bucket refills at 10/s and the api docs are at https://example.com/docs",
  "Your access key and secret were rotated; see the vault. The password manager has the new credentials.",
  "Fwd: ---------- Forwarded message ---------\nFrom: Priya <priya@acme.com>",
  "secrets in this thread are fake; the api is down and the key is on the desk",
  "ﬁle ﬂow café́ İstanbul ǅemal",
];
const KEYS = [
  "password",
  "PASSWORD",
  "db_password",
  "api_key",
  "apiKey",
  "x-api-key",
  "token",
  "access_token",
  "client_secret",
  "secret",
  "AWS_SECRET_ACCESS_KEY",
  "authorization",
  "credentials2",
  "tokens",
  "author",
  "tokenizer",
  "monkey",
  "name",
  "pwd",
  "passphrase",
  "private_key",
  "Set-Cookie",
];

/** Eden's own shapes and the structural redactor's, assembled from parts so no literal here is a secret. */
function edenShape(rnd: Rnd): string {
  const value = () => draw(rnd, ALNUM + (rnd() < 0.3 ? "+/_-.=" : ""), pick(rnd, [3, 6, 8, 12, 20, 24, 32, 40, 64]));
  switch (int(rnd, 16)) {
    case 0:
      return `${pick(rnd, KEYS)}${pick(rnd, [" is ", "=", ": ", ":", " = ", '": "', "='"])}${pick(rnd, ["", '"', "'", "“", "‘"])}${value()}${pick(rnd, ["", '"', "'", "”", "’", " "])}`;
    case 1:
      return `${pick(rnd, ["postgres", "https", "redis", "a-b.c+d", "x"])}://${pick(rnd, ["admin", "u", ""])}:${pick(rnd, [value(), "[REDACTED]"])}@db.internal:5432/app`;
    case 2:
      return `https://bucket.s3.amazonaws.com/o?${pick(rnd, ["X-Amz-Signature", "x-goog-signature", "X-Amz-Security-Token"])}${pick(rnd, ["=", "%3D"])}${value()}${pick(rnd, ["&a=1", "%26b", "#f", ""])}`;
    case 3:
      return `${pick(rnd, ["AK", "AS"])}${"IA"}${draw(rnd, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 16)} ${pick(rnd, ["secret ", "", "Secretary "])}${draw(rnd, ALNUM + "/+", 40)}`;
    case 4:
      return `${pick(rnd, ["deploy secret", "the token", "api", "nothing"])} ${draw(rnd, ALNUM, 30 + int(rnd, 10))}${pick(rnd, ["", "/x", "-y", ".z"])}`;
    case 5:
      return `${pick(rnd, ["Bearer", "bearer", "BEARER", "Basic"])} ${pick(rnd, [value(), btoa(`${value()}:${value()}`)])}`;
    case 6:
      return `${pick(rnd, ["sk", "rk"])}${pick(rnd, ["-", "_live_", "_test_", "-proj-", "-ant-api03-"])}${value()}`;
    case 7:
      return `${pick(rnd, ["gh", "go"])}${pick(rnd, ["p_", "o_", "thub_pat_"])}${value()}`;
    case 8:
      return `${"xo"}${pick(rnd, ["xb", "xp", "xa"])}-${draw(rnd, ALNUM + "-", 24)}`;
    case 9:
      return `-----BEGIN ${pick(rnd, ["RSA ", "", "EC "])}PRIVATE KEY-----\n${value()}\n${pick(rnd, ["-----END RSA PRIVATE KEY-----", ""])}`;
    case 10:
      return `${"cf"}at_${value()} ${"NR"}AK-${draw(rnd, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 27)} key-${draw(rnd, "0123456789abcdef", 32)}`;
    case 11:
      return `${draw(rnd, "0123456789", 9)}:AA${draw(rnd, ALNUM + "_-", 33)}`;
    case 12:
      return `https://discord.com/api/${pick(rnd, ["", "v10/"])}webhooks/${draw(rnd, "0123456789", 18)}/${draw(rnd, ALNUM + "_-", 68)}`;
    case 13:
      return `eden_local_${draw(rnd, "0123456789abcdef", 16)}`;
    case 14:
      return `{"${pick(rnd, KEYS)}":"${value()}${pick(rnd, ['\\"x', ",y", ""])}","n":1}`;
    default:
      return `curl -${pick(rnd, ["u", "H"])} ${pick(rnd, ['"', "'", ""])}${pick(rnd, ["user:", "Authorization: Bearer ", "X-Api-Key: "])}${value()}`;
  }
}

/** One text: one to six parts of the kinds above, joined by separators. */
export function gateText(rnd: Rnd): string {
  const parts = 1 + int(rnd, 6);
  let text = "";
  for (let i = 0; i < parts; i++) {
    const kind = int(rnd, 10);
    let part: string;
    if (kind <= 2) {
      const at = int(rnd, RULES.length);
      const { node, pieces } = PARSED[at]!;
      part = node && rnd() < 0.8 ? sample(rnd, node) : pick(rnd, pieces);
      if (rnd() < 0.3) part = mutate(rnd, part);
    } else if (kind <= 4) part = edenShape(rnd);
    else if (kind === 5) part = recase(rnd, pick(rnd, WORDS));
    else if (kind === 6) part = pick(rnd, PROSE);
    else if (kind === 7) part = pick(rnd, ODD);
    else if (kind === 8) part = draw(rnd, ALNUM + "_.-/+=", int(rnd, 60));
    else part = `${recase(rnd, pick(rnd, WORDS))}${pick(rnd, SEPARATORS)}${edenShape(rnd)}`;
    text += (i > 0 ? pick(rnd, SEPARATORS) : "") + part;
  }
  return rnd() < 0.05 ? text.repeat(2 + int(rnd, 20)) : text;
}

let gates: { now: Gate; before: Gate } | undefined;

/** The first difference between the gate and the reference on `text`, or undefined when there is none. */
export function difference(text: string): string | undefined {
  gates ??= { now: gateOf(secretRules()), before: gateOfBefore(secretRulesBefore()) };
  const show = (value: unknown) => JSON.stringify(value);
  const findings = [show(gates.now.findings(text)), show(gates.before.findings(text))];
  if (findings[0] !== findings[1]) return `findings: ${findings[0]} vs ${findings[1]}`;
  const hits = [show(gates.now.secretHits(text)), show(gates.before.secretHits(text))];
  if (hits[0] !== hits[1]) return `secretHits: ${hits[0]} vs ${hits[1]}`;
  const stored = [gates.now.sanitizeForStore(text), gates.before.sanitizeForStore(text)];
  if (stored[0] !== stored[1]) return `sanitizeForStore: ${show(stored[0])} vs ${show(stored[1])}`;
  const redacted = [redactString(text), redactStringBefore(text)];
  if (redacted[0] !== redacted[1]) return `redactString: ${show(redacted[0])} vs ${show(redacted[1])}`;
  const value = { [text.slice(0, 12)]: text, list: [text, { token: text }] };
  const walked = [show(redact(value)), show(redactBefore(value))];
  if (walked[0] !== walked[1]) return `redact: ${walked[0]} vs ${walked[1]}`;
  return undefined;
}

export interface GateFuzzResult {
  texts: number;
  /** Texts on which some rule found something (so the comparison exercised spans, not only "nothing"). */
  withFindings: number;
  failures: { text: string; why: string }[];
}

/** `count` texts from `seed` through both gates. */
export function fuzzGate(count: number, seed: number): GateFuzzResult {
  const rnd = prng(seed);
  const failures: { text: string; why: string }[] = [];
  let withFindings = 0;
  for (let i = 0; i < count; i++) {
    const text = gateText(rnd);
    const why = difference(text);
    if (why) {
      failures.push({ text, why });
      if (failures.length >= 10) break;
    }
    if (gates!.now.findings(text).length > 0) withFindings++;
  }
  return { texts: count, withFindings, failures };
}

/**
 * Every text of the realistic corpus (`bench/corpus.ts`: the sim worlds' items, the eval scenarios, the repo's code),
 * whole, and each kind at 256 B to 1 MB. Imported on demand: it builds sim worlds, which the tests do not need.
 */
async function corpusDifferences(): Promise<{ texts: number; failures: { text: string; why: string }[] }> {
  const { KINDS, pieces, sample: sized } = await import("../bench/corpus");
  const failures: { text: string; why: string }[] = [];
  const texts = [
    ...pieces().map((piece) => piece.text),
    ...KINDS.flatMap((kind) =>
      [256, 2_048, 16_384, 1_048_576].flatMap((size) => [1, 2].map((s) => sized(kind, size, s))),
    ),
  ];
  for (const text of texts) {
    const why = difference(text);
    if (why) failures.push({ text: text.slice(0, 300), why: why.slice(0, 300) });
  }
  return { texts: texts.length, failures };
}

if (import.meta.main) {
  if (process.argv[2] === "--corpus") {
    const result = await corpusDifferences();
    console.log(JSON.stringify({ corpusTexts: result.texts, failures: result.failures.slice(0, 3) }));
    process.exit(result.failures.length > 0 ? 1 : 0);
  }
  const count = Number(process.argv[2] ?? 1_000_000);
  const seed = Number(process.argv[3] ?? 1);
  const t0 = performance.now();
  const result = fuzzGate(count, seed);
  console.log(
    JSON.stringify({ ...result, failures: result.failures.slice(0, 3), seconds: (performance.now() - t0) / 1000 }),
  );
  if (result.failures.length > 0) process.exit(1);
}
