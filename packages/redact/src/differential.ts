/**
 * Test support, not part of the gate: the seeded differential fuzz behind D1705. It holds the gate's own matchers to
 * re2js (`re2-oracle.ts`, the gate D24 shipped): each scanned rule's `matches`, `groups` and `test` on texts built
 * from its own fragments, and each allowlist regex's `test` on samples of the regex, mutated, with case-fold
 * characters (U+017F, U+212A), lone surrogates, astral characters, Unicode spaces and long runs. own-matchers.test.ts
 * runs a few thousand texts per matcher; the full run is a command:
 *
 *   bun packages/redact/src/differential.ts [texts per matcher, default 50000] [seed, default 1]
 */
import { compileAllowlistRegex, parseRegex, type RegexNode } from "./automaton";
import { linearEngine } from "./re2-oracle";
import { SCANNERS } from "./scanners";
import gitleaks from "./vendor/gitleaks/gitleaks.toml";

/** mulberry32: a seeded generator, so a failure names a reproducible text. */
export function prng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rnd = () => number;
const int = (rnd: Rnd, n: number) => Math.floor(rnd() * n);
const pick = <T>(rnd: Rnd, xs: readonly T[]): T => xs[int(rnd, xs.length)]!;
const draw = (rnd: Rnd, alphabet: string, n: number) => {
  const chars = Array.from(alphabet);
  let out = "";
  for (let i = 0; i < n; i++) out += pick(rnd, chars);
  return out;
};

const LONG_S = "\u017f";
const KELVIN = "\u212a";
/** Characters where engines that read code units, fold case or class spaces differently would disagree. */
const ODD = [
  LONG_S,
  KELVIN,
  "\ud800",
  "\udc00",
  "😀",
  "😀",
  "\u00a0",
  "\u2028",
  "\u2029",
  "\u3000",
  "\ufeff",
  "\u0130",
  "\u0131",
  "é",
  "\u200b",
  "\u1680",
  "\x0b",
  "\f",
  "\r",
  "\n",
  "\t",
  "\\",
  "\0",
];
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Mutations: a fragment's characters replaced, dropped, doubled, or an odd character put in. */
function mutate(rnd: Rnd, text: string): string {
  const chars = Array.from(text);
  const edits = int(rnd, 4);
  for (let e = 0; e < edits && chars.length > 0; e++) {
    const at = int(rnd, chars.length);
    const kind = int(rnd, 5);
    if (kind === 0) chars.splice(at, 1);
    else if (kind === 1) chars.splice(at, 0, pick(rnd, ODD));
    else if (kind === 2) chars.splice(at, 0, chars[at]!);
    else if (kind === 3) chars[at] = pick(rnd, chars);
    else chars[at] = chars[at]!.toUpperCase() === chars[at] ? chars[at]!.toLowerCase() : chars[at]!.toUpperCase();
  }
  return chars.join("");
}

/** A long run: 50–300 copies of a short piece, the shape crafted inputs take. */
const run = (rnd: Rnd, piece: string) => piece.repeat(50 + int(rnd, 250));

// --- texts for the assignment rules ---------------------------------------------------------------------------

const KEYWORDS: Record<string, string[]> = {
  "cisco-meraki-api-key": ["meraki", "Meraki", "MERAKI", "mERAKI", "MeRaKi", "merak"],
  "cohere-api-token": ["cohere", "COHERE", "CoHeRe", "co_api_key", "CO_API_KEY", `co_api_${KELVIN}ey`, "CO_API_kEY"],
  "okta-access-token": ["okta", "Okta", "OKTA", "oKTA", "okt"],
  "privateai-api-token": [
    "privateai",
    "private_ai",
    "private-ai",
    "PRIVATE_AI",
    "Private-Ai",
    "private__ai",
    "private",
  ],
  "sumologic-access-id": ["sumo", "Sumo", "SUMO", "sUMO", `${LONG_S}umo`],
};
const SECRET_SHAPES: Record<string, (rnd: Rnd) => string> = {
  "cisco-meraki-api-key": (rnd) => draw(rnd, "0123456789abcdef", pick(rnd, [39, 40, 40, 40, 41])),
  "cohere-api-token": (rnd) => draw(rnd, ALNUM, pick(rnd, [39, 40, 40, 40, 41])),
  "okta-access-token": (rnd) =>
    pick(rnd, ["00", "00", "0", "01"]) + draw(rnd, ALNUM + "_=-", pick(rnd, [39, 40, 40, 41])),
  "privateai-api-token": (rnd) => draw(rnd, "abcdefghijklmnopqrstuvwxyz0123456789", pick(rnd, [31, 32, 32, 33])),
  "sumologic-access-id": (rnd) => pick(rnd, ["su", "su", "SU", "s"]) + draw(rnd, ALNUM, pick(rnd, [11, 12, 12, 13])),
};
const RUN_CHARS = ALNUM + "_.-" + LONG_S + KELVIN;
const OPERATORS = ["=", ">", ":=", "::=", ":::=", "::::=", "||", ":", "=>", "?=", ",", "|", "?", "==", ":=:", "=="];
const ENDS = ["", " ", ";", "\\n", "\\r", "\\t", "x", "'", "`", '"', "\n", "\u00a0", "\ud800", "😀", "\u2028"];

function assignmentText(rnd: Rnd, id: string): string {
  const shaped = () =>
    draw(rnd, RUN_CHARS, pick(rnd, [0, 0, 3, 20, 45, 49, 50, 51, 55, 99, 100, 101, 120])) +
    pick(rnd, KEYWORDS[id]!) +
    draw(rnd, ` \t_.-x${LONG_S}${KELVIN}'"\u00a0\n`, pick(rnd, [0, 1, 3, 19, 20, 21, 25])) +
    draw(rnd, ` '"\u3000`, int(rnd, 5)) +
    pick(rnd, OPERATORS) +
    draw(rnd, "`'\"= \t\u2028", pick(rnd, [0, 1, 5, 6, 7])) +
    SECRET_SHAPES[id]!(rnd) +
    pick(rnd, ENDS);
  // Well-formed: a match unless the secret's length is off by one.
  const clean = () =>
    draw(rnd, RUN_CHARS, int(rnd, 8)) +
    pick(rnd, KEYWORDS[id]!.slice(0, 3)) +
    pick(rnd, ["", "_key", " ", "_TOKEN", "-id", `${LONG_S}x`]) +
    pick(rnd, ["", " ", '"', "' "]) +
    pick(rnd, ["=", ":", ": ", " = ", "=>", ":=", ","]) +
    pick(rnd, ["", '"', " '", "`"]) +
    SECRET_SHAPES[id]!(rnd) +
    pick(rnd, ["", '"', "'", " ", ";", "\\n", "\n"]);
  const pieces = [
    shaped,
    clean,
    clean,
    () => mutate(rnd, shaped()),
    () => pick(rnd, KEYWORDS[id]!),
    () => pick(rnd, OPERATORS),
    () => SECRET_SHAPES[id]!(rnd),
    () => pick(rnd, ODD),
    () => draw(rnd, RUN_CHARS, int(rnd, 60)),
    () => pick(rnd, [" ", "\n", "\t", "=", ": ", "\\n"]),
    () => run(rnd, pick(rnd, [`${pick(rnd, KEYWORDS[id]!)}-`, "a", "a.", " ", "=", ":", `${LONG_S}`, `${KELVIN}a`])),
  ];
  let text = "";
  for (let i = 1 + int(rnd, 6); i > 0; i--) text += pick(rnd, pieces)();
  return text;
}

// --- texts for the curl rules ----------------------------------------------------------------------------------

const CURL = [
  "curl",
  "curl ",
  "xcurl",
  "curl_",
  "CURL",
  "curl\t",
  "curlx",
  " curl",
  "-curl",
  "😀curl",
  `${KELVIN}curl`,
];
const BREAKS = [
  " ",
  "\t",
  "\n",
  "\r\n",
  "\r",
  "\n\n",
  "\r\r\n",
  "\n\r\n",
  "\u2028",
  "\u2029",
  " https://x.example ",
  "",
];
const OPTIONS = ["-u", "--user", "-H", "--header", "-u=", "-H=", "-user", "--userx", "--header=", "-X", "-Hx", "-u-"];
const SPACES = ["", " ", "  ", "     ", "      ", "\t", " \t", "=", "= "];
const WORD_CHARS = "abcdefghij0123456789$@.-{}_";
function userValue(rnd: Rnd): string {
  const part = () =>
    draw(rnd, WORD_CHARS + pick(rnd, ["", "😀", "\ud800", LONG_S, " ", "\n"]), pick(rnd, [0, 1, 2, 3, 4, 6]));
  const quote = () => pick(rnd, ['"', "'", ""]);
  const q1 = quote();
  const q2 = rnd() < 0.7 ? q1 : quote();
  return pick(rnd, [
    () => `${q1}${part()}:${part()}${q2}`,
    () => `${q1}:${part()}${q2}`,
    () => `${q1}${part()}:${q2}`,
    () => `${q1}${part()}${q2}:${quote()}${part()}${quote()}`,
    () => `${q1}${part()}:${part()}:${part()}${q2}`,
    () => part(),
  ])();
}
const TOKEN_CHARS = ALNUM + "_=~@.+/-";
function headerValue(rnd: Rnd): string {
  const quote = pick(rnd, ['"', "'", '"', "'", ""]);
  const token = () =>
    draw(
      rnd,
      pick(rnd, [TOKEN_CHARS, ALNUM + "+/", ALNUM + LONG_S + KELVIN, TOKEN_CHARS + " "]),
      pick(rnd, [6, 7, 8, 9, 12]),
    );
  const spaces = pick(rnd, ["", " ", "\t", "     ", "      "]);
  const body = pick(rnd, [
    () =>
      `${pick(rnd, ["Authorization:", "authorization:", "AUTHORIZATION:", "Authori\u017fation:"])}${spaces}` +
      `${pick(rnd, [
        "Basic ",
        "basic\t",
        "BASIC ",
        `Ba${LONG_S}ic `,
        "Bearer ",
        "bearer\t",
        "Token ",
        "Api-Token ",
        "api-token ",
        `To${KELVIN}en `,
        "Bearer",
        "",
        "Basicx",
      ])}${token()}${pick(rnd, ["", "=", "==", "===", "===="])}`,
    () =>
      `${pick(rnd, [
        "X-Api-Key",
        "x-foo-token",
        "Api-Key",
        "apikey",
        "X-Key",
        "X--Key",
        "x-ab-api-token",
        "Token",
        `X-Ap${KELVIN}-Key`,
        "Key",
        "X-Api-",
        "x-a1-key",
        "apitoken",
        "X-API-KEY",
        `x-${LONG_S}-key`,
      ])}:${spaces}${token()}`,
  ])();
  return `${quote}${body}${rnd() < 0.85 ? quote : pick(rnd, ['"', "'", ""])}${pick(rnd, ["", " ", "x", "_", "\n", ";", "\u00a0", "-", "é"])}`;
}

function curlText(rnd: Rnd, id: string): string {
  const value = id === "curl-auth-user" ? userValue : headerValue;
  const shaped = () => {
    let text = pick(rnd, CURL);
    for (let i = int(rnd, 4); i > 0; i--) text += pick(rnd, BREAKS) + draw(rnd, "abc -", int(rnd, 6));
    return `${text}${pick(rnd, [" ", "\t", "\n", "\r"])}${pick(rnd, OPTIONS)}${pick(rnd, SPACES)}${value(rnd)}`;
  };
  const clean = () =>
    `curl ${pick(rnd, ["", "-X POST ", "https://x.example ", "-s\n  "])}` +
    `${id === "curl-auth-user" ? pick(rnd, ["-u ", "--user ", "-u="]) : pick(rnd, ["-H ", "--header ", "-H="])}${value(rnd)}`;
  const pieces = [
    shaped,
    clean,
    clean,
    () => mutate(rnd, shaped()),
    () => pick(rnd, CURL),
    () => pick(rnd, BREAKS),
    () => ` ${pick(rnd, OPTIONS)}${pick(rnd, SPACES)}${value(rnd)}`,
    () => value(rnd),
    () => pick(rnd, ODD),
    () => run(rnd, pick(rnd, ["curl ", "curl=", " -u", " -H", "\n", '"', "'", ":", "a", `curl -u ${'"'}`])),
  ];
  let text = "";
  for (let i = 1 + int(rnd, 6); i > 0; i--) text += pick(rnd, pieces)();
  return text;
}

/** A text for a scanned rule. */
export function ruleText(rnd: Rnd, id: string): string {
  return id.startsWith("curl-") ? curlText(rnd, id) : assignmentText(rnd, id);
}

// --- texts for an allowlist regex: samples of the regex itself, mutated, inside other text ---------------------

/** A string the pattern (roughly) matches: a random walk over its parse, assertions ignored. */
function sample(rnd: Rnd, node: RegexNode, depth = 0): string {
  switch (node.t) {
    case "empty":
    case "assert":
      return "";
    case "set": {
      const ranges = node.ranges;
      const ascii: number[] = [];
      for (let i = 0; i < ranges.length; i += 2) {
        for (let cp = ranges[i]!; cp <= Math.min(ranges[i + 1]!, 127); cp++) ascii.push(cp);
      }
      if (ascii.length > 0 && rnd() < 0.85) return String.fromCodePoint(pick(rnd, ascii));
      const r = int(rnd, ranges.length / 2) * 2;
      const lo = ranges[r]!;
      const hi = Math.min(ranges[r + 1]!, lo + 0x3000);
      return String.fromCodePoint(lo + int(rnd, hi - lo + 1));
    }
    case "cat":
      return node.xs.map((x) => sample(rnd, x, depth)).join("");
    case "alt":
      return sample(rnd, pick(rnd, node.xs), depth);
    case "rep": {
      const span = node.max < 0 ? (depth > 2 ? 1 : pick(rnd, [0, 1, 2, 3, 8, 30])) : node.max - node.min;
      const times = node.min + (rnd() < 0.3 ? span : int(rnd, span + 1));
      let out = "";
      for (let i = 0; i < times; i++) out += sample(rnd, node.x, depth + 1);
      return out;
    }
  }
}

/** The literal pieces of a pattern's source: words and punctuation it names, to scatter as near misses. */
function sourcePieces(source: string): string[] {
  const pieces = source.split(/\\[a-zA-Z]|[()[\]|?*+{}^$\\]/).filter((piece) => piece.length > 0 && piece.length < 40);
  return pieces.length > 0 ? pieces : ["x"];
}

/** A text for an allowlist regex. */
export function allowlistText(rnd: Rnd, node: RegexNode, pieces: string[]): string {
  const parts = [
    () => sample(rnd, node),
    () => sample(rnd, node),
    () => mutate(rnd, sample(rnd, node)),
    () => pick(rnd, pieces),
    () => mutate(rnd, pick(rnd, pieces)),
    () => pick(rnd, ODD),
    () => draw(rnd, ALNUM + " :._-/$%{}<>'\"", int(rnd, 12)),
    () => run(rnd, pick(rnd, [...pieces.map((p) => p.slice(0, 3)), "a", " ", ":", "\n", "x-", LONG_S])),
  ];
  // Often the sample alone: most allowlist regexes are anchored at both ends.
  if (rnd() < 0.35) return rnd() < 0.5 ? sample(rnd, node) : mutate(rnd, sample(rnd, node));
  let text = "";
  for (let i = 1 + int(rnd, 4); i > 0; i--) text += pick(rnd, parts)();
  return text;
}

/** Every distinct allowlist regex in the vendored config (global and per rule). */
export function allowlistRegexes(): string[] {
  const config = gitleaks as { allowlist: { regexes?: string[] }; rules: { allowlists?: { regexes?: string[] }[] }[] };
  const lists = [config.allowlist, ...config.rules.flatMap((rule) => rule.allowlists ?? [])];
  return [...new Set(lists.flatMap((list) => list.regexes ?? []))];
}

export interface FuzzResult {
  name: string;
  texts: number;
  /** Texts on which re2js found something (a match, or the regex occurring). */
  positives: number;
  mismatches: string[];
}

const show = (value: unknown) => JSON.stringify(value);

/** `count` texts for a scanned rule: its matcher's matches, groups and test against re2js's. */
export function fuzzRule(id: string, count: number, seed: number): FuzzResult {
  const scanner = SCANNERS.get(id)!;
  const oracle = linearEngine(scanner.regex);
  const rnd = prng(seed);
  const result: FuzzResult = { name: id, texts: count, positives: 0, mismatches: [] };
  for (let i = 0; i < count; i++) {
    const text = ruleText(rnd, id);
    const expected = oracle.matches(text);
    if (expected.length > 0) result.positives++;
    const checks: [string, unknown, unknown][] = [
      ["matches", scanner.pattern.matches(text), expected],
      ["groups", scanner.pattern.groups(text), oracle.groups(text)],
      ["test", scanner.pattern.test(text), expected.length > 0],
    ];
    for (const [what, got, want] of checks) {
      if (show(got) !== show(want) && result.mismatches.length < 5) {
        result.mismatches.push(`${id} ${what} on ${show(text)}: ${show(got)} vs re2js ${show(want)}`);
      }
    }
  }
  return result;
}

/** `count` texts for an allowlist regex: the automaton's `test` against re2js's. */
export function fuzzAllowlist(source: string, count: number, seed: number): FuzzResult {
  const own = compileAllowlistRegex(source);
  const oracle = linearEngine(source);
  const node = parseRegex(source);
  const pieces = sourcePieces(source);
  const rnd = prng(seed);
  const result: FuzzResult = { name: source, texts: count, positives: 0, mismatches: [] };
  for (let i = 0; i < count; i++) {
    const text = allowlistText(rnd, node, pieces);
    const want = oracle.test(text);
    if (want) result.positives++;
    if (own.test(text) !== want && result.mismatches.length < 5) {
      result.mismatches.push(`${show(source)} on ${show(text)}: ${!want} vs re2js ${want}`);
    }
  }
  return result;
}

if (import.meta.main) {
  const count = Number(process.argv[2] ?? 50_000);
  const seed = Number(process.argv[3] ?? 1);
  let failed = 0;
  let texts = 0;
  const t0 = performance.now();
  for (const id of SCANNERS.keys()) {
    const r = fuzzRule(id, count, seed);
    texts += r.texts;
    failed += r.mismatches.length;
    console.log(`rule ${id}: ${r.texts} texts, ${r.positives} with a match, ${r.mismatches.length} mismatches`);
    for (const m of r.mismatches) console.log(`  ${m}`);
  }
  const sources = allowlistRegexes();
  for (const [i, source] of sources.entries()) {
    const r = fuzzAllowlist(source, count, seed + i);
    texts += r.texts;
    failed += r.mismatches.length;
    console.log(
      `allowlist ${show(source).slice(0, 70)}: ${r.texts} texts, ${r.positives} positive, ${r.mismatches.length} mismatches`,
    );
    for (const m of r.mismatches) console.log(`  ${m}`);
  }
  console.log(
    `${SCANNERS.size} rules and ${sources.length} allowlist regexes, ${texts} texts, ${failed} mismatches ` +
      `(${((performance.now() - t0) / 1000).toFixed(1)} s)`,
  );
  if (failed > 0) process.exit(1);
}
