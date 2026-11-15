/**
 * Test support (D1850): the gate never redacts less than main did before D1850 (`secrets.baseline.ts`, frozen). The
 * reference oracle (`secrets.reference.ts`) moves with every detection change, so it cannot see a change that loses
 * a secret; this can. Two checks a text:
 *
 * - every character inside a span some baseline rule finds is inside a span some rule of the gate finds;
 * - every character the baseline's `sanitizeForStore` removes, the gate's removes too (`lessThanBaseline`);
 *
 * except the characters of a value that is code or a placeholder (`not-secret.ts`), which D1850 leaves on purpose
 * (and only those: `compose.ts` reports which, and each is checked here).
 *
 * Also a command, for the fuzz at scale:
 *
 *   bun packages/redact/src/never-less.ts 250000 101       # texts, seed: fuzz, keyword-chain and shape texts
 */
import { prng } from "./differential.ts";
import { chainText, gateText } from "./gate-differential.ts";
import {
  assignmentSpans as assignmentSpansBefore,
  REDACTED,
  structuralMask as structuralMaskBefore,
} from "./redact.baseline.ts";
import { keptValue, oracleNotSecret } from "./never-less-oracle.ts";
import { type Gate, gateOf, secretRules } from "./secrets.ts";
import {
  type Gate as BaselineGate,
  gateOf as gateOfBaseline,
  secretRules as secretRulesBaseline,
} from "./secrets.baseline.ts";

let gates: { now: Gate; baseline: BaselineGate } | undefined;

function setUp(): { now: Gate; baseline: BaselineGate } {
  gates ??= { now: gateOf(secretRules()), baseline: gateOfBaseline(secretRulesBaseline()) };
  return gates;
}

/**
 * What the baseline's `sanitizeForStore` removes from `text`, worked out apart from it with its own frozen modules:
 * its rules' spans (and the assignment pass's, with any finding), then what its structural pass removes from the
 * gated text (`structuralMask`), traced back. Checked against its output (`baselineMaskDiffers`).
 */
function baselineMask(text: string): Uint8Array {
  const found = setUp()
    .baseline.findings(text)
    .flatMap((f) => f.spans);
  const spans = (found.length > 0 ? [...found, ...assignmentSpansBefore(text)] : found).sort((a, b) => a[0] - b[0]);
  const mask = new Uint8Array(text.length);
  const map: number[] = [];
  let gated = "";
  let at = 0;
  for (const [start, end] of spans) {
    if (end <= at) continue;
    const kept = Math.max(start, at);
    gated += text.slice(at, kept) + (start >= at ? REDACTED : "");
    for (let i = at; i < kept; i++) map.push(i);
    if (start >= at) for (let i = 0; i < REDACTED.length; i++) map.push(-1);
    mask.fill(1, kept, end);
    at = end;
  }
  gated += text.slice(at);
  for (let i = at; i < text.length; i++) map.push(i);
  const structural = structuralMaskBefore(gated, 15);
  for (let j = 0; j < gated.length; j++) if (structural[j] === 1 && map[j]! >= 0) mask[map[j]!] = 1;
  return mask;
}

/** `text` with each maximal run `mask` marks replaced by one sentinel. */
function render(text: string, mask: Uint8Array): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length;) {
    if (mask[i] === 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && mask[j] === 1) j++;
    out += text.slice(from, i) + REDACTED;
    from = i = j;
  }
  return out + text.slice(from);
}

/** Adjacent sentinels as one: the pipeline can leave two side by side where a mask has one run. */
const merged = (s: string) => s.replace(/(?:\[REDACTED\]){2,}/g, REDACTED);

/** Where the baseline mask is not what the baseline stores on `text` (sentinels side by side as one), or undefined. */
export function baselineMaskDiffers(text: string): string | undefined {
  if (text.includes(REDACTED)) return undefined; // a sentinel of the text's own reads either way
  const rendered = merged(render(text, baselineMask(text)));
  const stored = merged(setUp().baseline.sanitizeForStore(text));
  return rendered === stored ? undefined : `${JSON.stringify(rendered)} vs ${JSON.stringify(stored)}`;
}

/**
 * Where the gate redacts less than the baseline on `text`, or undefined when it does not. Four checks:
 *
 * - every character in a span of a baseline rule is in a span of the gate's rules, or in one they excused;
 * - the gate's own account of main's pipeline (`explain().before`) is the frozen baseline's mask, character for
 *   character (so the gate starts from what main removed), and that mask is what the baseline stores;
 * - the gate stores what its mask (`after`) says;
 * - every character main removed and the gate keeps was removed only through an excused value, and every run of
 *   them is, as written, a value the independent oracle (`never-less-oracle.ts`) calls code or a placeholder: a
 *   loss counts only where that oracle agrees (the second review of 2026-11-14: checking with `not-secret.ts`
 *   itself could not catch its own mistakes).
 */
export function lessThanBaseline(text: string): string | undefined {
  const { now, baseline } = setUp();
  const explained = now.explain(text);
  const mine = new Uint8Array(text.length);
  for (const f of now.findings(text)) for (const [start, end] of f.spans) mine.fill(1, start, end);
  for (const [start, end] of explained.excusedSpans) mine.fill(1, start, end);
  for (const f of baseline.findings(text)) {
    for (const [start, end] of f.spans) {
      for (let i = start; i < end; i++) {
        if (mine[i] === 0) return `span: ${f.id} at ${i} (${JSON.stringify(text.slice(i, i + 24))})`;
      }
    }
  }
  const before = baselineMask(text);
  const differs = baselineMaskDiffers(text);
  if (differs) return `baseline mask: ${differs}`;
  for (let i = 0; i < text.length; i++) {
    if (before[i] !== explained.before![i]) return `main's pipeline at ${i}: ${JSON.stringify(text.slice(i, i + 24))}`;
  }
  const stored = now.sanitizeForStore(text);
  if (!text.includes(REDACTED) && merged(stored) !== merged(render(text, explained.after!))) {
    return `stored: ${JSON.stringify(stored)} vs its mask ${JSON.stringify(render(text, explained.after!))}`;
  }
  for (let i = 0; i < text.length; i++) {
    if (before[i] === 1 && explained.after![i] === 0 && explained.excused![i] === 0) {
      return `stored less at ${i}: ${JSON.stringify(text.slice(i, i + 24))}`;
    }
  }
  // Each run of characters main removed and the gate keeps must be, as written in the text, a value the independent
  // oracle (never-less-oracle.ts, not `not-secret.ts`) calls code or a placeholder.
  for (let i = 0; i < text.length; i++) {
    if (before[i] !== 1 || explained.after![i] !== 0) continue;
    let j = i;
    while (j < text.length && before[j] === 1 && explained.after![j] === 0) j++;
    const kept = keptValue(text, i, j);
    if (kept !== undefined && !oracleNotSecret(kept)) {
      return `kept ${JSON.stringify(text.slice(i, j))} of ${JSON.stringify(kept)}`;
    }
    i = j;
  }
  return undefined;
}

const KEYWORDS = [
  "password",
  "passwd",
  "token",
  "secret",
  "api_key",
  "apiKey",
  "API_KEY",
  "DB_PASSWORD",
  "auth_token",
  "client_secret",
  "access_token",
  "credential",
  "pwd",
  "aws_secret_access_key",
  "private_key",
];
const SEPARATORS = ["=", ": ", " = ", ":", '": "', "='", " is ", ":= ", "\t=\t", '="'];
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** What can follow an excused shape inside one written value (the second review's fuzz). */
const GLUE = [
  ".",
  "||",
  "|| ",
  "/",
  ":",
  ",",
  "&&",
  "-",
  "+",
  "?.",
  "#",
  "@",
  "!",
  "~",
  ":-",
  "-",
  ":=",
  "=",
  ":?",
  "}",
  ")",
  "",
];

/**
 * An excused shape, alone or followed (after punctuation) by a random 12–40 character token, as a keyword's value:
 * every shape `not-secret.ts` leaves, and near misses (a default inside `${…}`, one member on a broad receiver, a
 * command, digits grouped). The token is a secret unless the oracle says the whole value is code.
 */
export function shapeText(rnd: () => number): string {
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  const token = () => Array.from({ length: 12 + int(29) }, () => ALNUM[int(ALNUM.length)]).join("");
  const shape = pick([
    () =>
      `\${${pick(["DB_PASS", "TOKEN", "X", "api_key", "DB_PASSWORD"])}${pick(["", ":-", "-", ":=", "=", ":?", "?", ":+", "+"])}`,
    () =>
      pick([
        "process.env.X",
        "process.env.DB_PASS",
        "import.meta.env.VITE_KEY",
        "this.options.apiKey",
        "this.token",
        "config.key",
        "options.a",
        "env.Y",
        "self",
        "data",
        "state",
        "Math",
        "req.body",
        "res.usage.input",
      ]),
    () => `{{${pick(["x", "vault_pw", "a.b", "X"])}}}`,
    () => pick(["env.OPENROUTER_API_KEY", "env.X", "env.Api_KEY", "${accessToken}", "${apiKey2}", "${aB}"]),
    () => `<${pick(["your-key", "b", "token", "API_KEY", "Xy"])}>`,
    () => `%${pick(["PASS", "API_KEY", "x"])}%`,
    () => `$(${pick(["echo ", "cat ", ""])}`,
    () => `$${pick(["API_KEY", "DB_PASS", "X"])}`,
    () => pick(["string", "number", "Set<string>", "Uint8Array", "string[]", "Map<string, number>"]),
    () => `${int(1000)}_${int(1000)}${rnd() < 0.5 ? "_" + int(1000) : ""}`,
    () => `${pick(["", "sk-", "hf_", "pplx-"])}${pick(["****", "xxxxxxxx", "########", "•••••••••", "XXXXXXXXXX"])}`,
    () => `${pick(["", "AIza", "AKIA", "glc_"])}${pick(["a", "X", "*", "1", "="]).repeat(14 + int(6))}`,
  ])();
  const quote = pick(["", "", '"', "'", "`"]);
  let text = "";
  for (let n = 1 + int(3); n > 0; n--) {
    const tail = rnd() < 0.7 ? pick(GLUE) + token() + (rnd() < 0.2 ? pick(["}", ")", "%", ">", "}}"]) : "") : "";
    text += pick(KEYWORDS) + pick(SEPARATORS) + quote + shape + tail + (rnd() < 0.6 ? quote : "");
    text += pick([" ", "\n", ", ", ";", "", "&", " and "]);
  }
  return text;
}

/** `count` texts from `seed`, fuzz, chain and shape texts in turn: the texts where the gate redacts less. */
export function fuzzNeverLess(
  count: number,
  seed: number,
): { texts: number; failures: { text: string; why: string }[] } {
  const rnd = prng(seed);
  const failures: { text: string; why: string }[] = [];
  for (let i = 0; i < count; i++) {
    const text = i % 3 === 0 ? gateText(rnd) : i % 3 === 1 ? chainText(rnd) : shapeText(rnd);
    const why = lessThanBaseline(text);
    if (why) failures.push({ text, why });
  }
  return { texts: count, failures };
}

if (import.meta.main) {
  const t0 = performance.now();
  const result = fuzzNeverLess(Number(process.argv[2] ?? 100_000), Number(process.argv[3] ?? 1));
  const seconds = (performance.now() - t0) / 1000;
  console.log(JSON.stringify({ texts: result.texts, failures: result.failures.slice(0, 5), seconds }));
}
