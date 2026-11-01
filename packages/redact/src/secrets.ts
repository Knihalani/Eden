/**
 * D13's secret gate, as A6 §2.2 details it: which rules a text hits (`secretHits`; `eden eval build-negatives`
 * drops such a prompt), and the text every memory writer stores (`sanitizeForStore`: each secret replaced by
 * `[REDACTED]`, so a row keeps what the value is, never the value).
 *
 * The rules:
 * - (a) the vendored gitleaks default rules (`vendor/gitleaks/`, v8.30.1), applied as gitleaks applies them to
 *   a fragment: a rule runs only when its keywords occur (case-insensitive); each regex match yields a secret
 *   (the rule's `secretGroup`, else the first non-empty group, else the match); the secret must clear the rule's
 *   entropy floor; and neither the global allowlist nor the rule's own excuses it. Text has no path, so three
 *   choices differ from gitleaks, each stricter: a rule with a regex and a `path` condition (freemius, hashicorp-tf,
 *   kubernetes-secret-yaml, nuget-config) runs on every text; a path-only rule never fires; an allowlist's path
 *   condition never holds. Two more: a list's allowlist regexes are tried one by one, where gitleaks joins them
 *   into one alternation (so a leading `(?i)` reaches the later ones), and base64/hex segments are not decoded;
 * - (a′) provider shapes gitleaks lacks or gates on context: `cfat_` tokens (R9 §R5.2, R3 E12); OpenAI project
 *   keys without the `T3BlbkFJ` marker; Mailgun `key-` and Telegram bot tokens without the provider's name nearby;
 *   AWS key ids below gitleaks' entropy floor. Each makes the gate stricter, never looser;
 * - (a″) an AWS secret access key (40 base64 characters, not pure hex, mixed case, high entropy, not a path) within
 *   40 characters of an `AKIA`/`ASIA` key id, of a `[REDACTED]` sentinel (a key id an earlier pass replaced), or
 *   of the word "secret" (D86);
 * - (b) D13's keyword rule, whatever the value's entropy, with `is` read as a word ("secrets in this" assigns
 *   nothing) and an already redacted value left alone;
 * - (c) URL userinfo, `scheme://user:pass@`;
 * - (d) entropy only with a keyword: a whitespace-delimited token of ≥ 32 characters that mixes letters and
 *   digits and holds no `/`, `.` or `-`, with a secret keyword within 40 characters. ULIDs, UUIDs, `sha512-`
 *   integrity strings and paths never qualify on their own;
 * - (e) the redaction memory had before P0.4 (a password, passphrase or API key of any length; short token
 *   prefixes), so the gate is never looser than it was.
 */
import { MultiMatcher } from "@eden/primitives";
import { RE2JS } from "re2js";
import { redact, REDACTED } from "./redact";
import gitleaks from "./vendor/gitleaks/gitleaks.toml";

interface Allowlist {
  regexTarget?: "secret" | "match" | "line";
  condition?: "OR" | "AND";
  regexes?: string[];
  stopwords?: string[];
  paths?: string[];
}

interface GitleaksRule {
  id: string;
  regex?: string;
  secretGroup?: number;
  entropy?: number;
  keywords?: string[];
  allowlists?: Allowlist[];
}

interface GitleaksConfig {
  allowlist: Allowlist;
  rules: GitleaksRule[];
}

interface CompiledAllowlist {
  target: "secret" | "match" | "line";
  and: boolean;
  regexes: Pattern[];
  stopwords: string[];
  /** Path conditions never hold for text, so they only matter to an AND list (which they then fail). */
  hasPaths: boolean;
}

/** Where a secret sits in a text: `[start, end)`. */
type Span = [number, number];

export interface SecretRule {
  id: string;
  /** Lower-case words of which at least one must occur in the text for the rule to run; none: always runs. */
  keywords: string[];
  /**
   * Words of which at least one occurs in every text the rule can match: for rules without keywords, a literal every
   * match contains ("sk-" for an OpenAI key). Used only to skip a rule cheaply, so it never changes what a rule finds.
   */
  prefilter: string[];
  /** Where the rule's secrets sit in `text`; none when it finds none. */
  spans(text: string): Span[];
}

/**
 * D13's keyword rule, case-insensitive (env lines spell it `PASSWORD=`), with `is` read as a word and the value in
 * group 1. A value already redacted is no secret.
 */
const KEYWORD_RULE = new RegExp(
  String.raw`(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential)s?\b[^\n]{0,20}?(?:\bis\b|=|:)\s*(?!\[REDACTED\])(\S{6,})`,
  "dgi",
);
const SECRET_WORD = /(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential)/i;
/**
 * URL userinfo, with the password in group 1: the user and host stay, as they say where the secret is for. The
 * scheme is a lookbehind rather than the match's start: written as `\b[a-z][a-z0-9+.-]*:\/\/…`, every word start in
 * a long run of scheme characters re-scanned the run to its `://`, quadratic (1 MB of `a-a-…://`: 200 s, D24). Each
 * `://` now checks its own run once; group 1, and so every span, is unchanged (secrets.test.ts pins both forms).
 */
export const URL_USERINFO = new RegExp(
  String.raw`(?<=\b[a-z][a-z0-9+.-]*):\/\/[^\s:/@]+:(?!\[REDACTED\]@)([^\s/@]+)@`,
  "dgi",
);
/**
 * (e) The redaction memory had before P0.4, kept so the gate is never looser: a password, passphrase or API key
 * after `is`, `=` or `:`, of any length (D13's keyword rule wants 6 characters and has no "passphrase"), with the
 * value in group 1; and the short token prefixes it caught.
 */
const LEGACY_KEYWORD = new RegExp(
  String.raw`\b(?:passwords?|passwd|passphrase|api[_-]?keys?)\s*(?:=|:|is)\s+(?!\[REDACTED\])([^\s,.;]+)`,
  "dgi",
);
const LEGACY_TOKEN = /\b(?:sk-|ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9/_-]+/g;
/** (a′): the bare shapes, with no keyword, marker or entropy condition. */
const PROVIDER_SHAPES: [string, RegExp][] = [
  ["eden-cfat", /\bcfat_[A-Za-z0-9_-]{20,}/g],
  ["eden-openai", /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g],
  ["eden-mailgun", /\bkey-[0-9a-f]{32}\b/g],
  ["eden-telegram", /\b\d{8,10}:AA[A-Za-z0-9_-]{32,}/g],
  ["eden-aws-key-id", /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g],
];
const ENTROPY_TOKEN = /\S{32,}/g;
/** How far from a long token rule (d) looks for a secret keyword. */
const KEYWORD_REACH = 40;
/**
 * (a″) An AWS secret access key: 40 characters of base64's alphabet, unpadded. Alone the shape is too common to
 * redact (a SHA-1, a long name), so it needs an anchor within KEYWORD_REACH: its key id (`AKIA`/`ASIA`), a key id an
 * earlier pass already replaced by `[REDACTED]`, or the word "secret". Rule (d) missed it beside a bare key id (no
 * keyword) and whenever it holds `/` (as most real ones do); the sim world's "AWS access" mail leaked it so.
 *
 * Runs of the alphabet are found by one walk over the text's char codes (`BASE64_CHAR`), and only a run of exactly 40
 * is sliced, so a token inside a longer run never qualifies. A regex was slower on the texts that reach the rule:
 * `matchAll` over every run allocated a match per word (doubling the gate's cost there), and `{40,}` retried up to 40
 * steps at each position (~8.6 µs a 2 KB text; docs/research/edge-secret.md).
 */
const BASE64_CHAR = new Uint8Array(128);
for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+") {
  BASE64_CHAR[char.charCodeAt(0)] = 1;
}
const AWS_SECRET_LENGTH = 40;
const AWS_SECRET_ANCHOR = /(?:AKIA|ASIA)[0-9A-Z]{16}|\[REDACTED\]/;
/**
 * The word "secret" as a word of its own or a key's name ("secret key", `aws_secret_access_key`, `secretAccessKey`),
 * never inside another word ("Secretary", "secretly", "secretariat"). Its own regex, as it folds case and the key id
 * (`AKIA`) must not ("Asia").
 */
const AWS_SECRET_WORD = /(?<![a-z])secrets?(?:[_ -]?access)?(?:[_ -]?key)?(?![a-z])/i;
const HEX = /^[0-9A-Fa-f]+$/;
/**
 * A random 40-character base64 string has Shannon entropy ≥ 4.04 bits a character in 10^6 draws (median 4.78); a
 * 40-character path or CamelCase name sits near 3.8–4.0. Measured for docs/research/edge-secret.md.
 */
const AWS_SECRET_ENTROPY = 4.0;
/**
 * A path segment: a word, CamelCase words, then digits. Written without nested ambiguous repeats (each group opens
 * on a capital), so it cannot backtrack. A random key with two slashes whose every segment is so: about 5 in 10^5.
 */
const PATH_SEGMENT = /^(?:[A-Za-z][a-z]*(?:[A-Z][a-z]*)*[0-9]*)?$/;

/** The POSIX classes the vendored rules use, as JavaScript class contents; any other throws. */
const POSIX: Record<string, string> = { alnum: "a-zA-Z0-9" };

/**
 * Translates a Go (RE2) regular expression to JavaScript. A leading `(?i)` becomes the `i` flag. Any other
 * `(?flags)` holds to the end of its group in Go, across later alternatives, so it becomes a `(?flags:…)` group
 * closed before each `|` and at the group's end, and reopened after each `|`. `[[:class:]]`, `\z`, `\A` and
 * `(?P<name>` become their JavaScript forms; an unknown POSIX class throws.
 */
export function goRegex(pattern: string): RegExp {
  let source = pattern;
  let flags = "";
  if (source.startsWith("(?i)")) {
    flags = "i";
    source = source.slice(4);
  }
  let out = "";
  /** Per open group, the inline flag groups opened in it so far. */
  const groups: string[][] = [[]];
  const open = () => groups[groups.length - 1]!;
  for (let at = 0; at < source.length; at++) {
    const char = source[at]!;
    if (char === "\\") {
      const next = source[at + 1] ?? "";
      out += next === "z" ? "$" : next === "A" ? "^" : char + next;
      at++;
    } else if (char === "[") {
      const end = classEnd(source, at);
      out += jsClass(source.slice(at, end + 1));
      at = end;
    } else if (char === "(") {
      const inline = /^\(\?([a-zA-Z-]+)\)/.exec(source.slice(at));
      if (inline) {
        out += `(?${inline[1]}:`;
        open().push(inline[1]!);
        at += inline[0].length - 1;
      } else {
        const named = source.startsWith("(?P<", at);
        out += named ? "(?<" : char;
        at += named ? 3 : 0;
        groups.push([]);
      }
    } else if (char === ")") {
      out += ")".repeat(groups.pop()!.length) + char;
    } else if (char === "|") {
      out +=
        ")".repeat(open().length) +
        char +
        open()
          .map((inline) => `(?${inline}:`)
          .join("");
    } else {
      out += char;
    }
  }
  return new RegExp(out + ")".repeat(open().length), flags);
}

/** The index of the `]` that closes the class opening at `start`, skipping escapes and `[:name:]`. */
function classEnd(source: string, start: number): number {
  let at = start + 1;
  if (source[at] === "^") at++;
  if (source[at] === "]") at++;
  for (; at < source.length; at++) {
    if (source[at] === "\\") at++;
    else if (source.startsWith("[:", at)) at = source.indexOf(":]", at) + 1;
    else if (source[at] === "]") return at;
  }
  throw new Error(`unterminated class in ${source}`);
}

/** A Go class in JavaScript: a leading literal `]` escaped (`[^]]` is "any character" in JavaScript), POSIX classes. */
function jsClass(cls: string): string {
  return cls.replace(/^\[(\^?)\]/, "[$1\\]").replace(/\[:(\w+):\]/g, (_, name: string) => {
    const body = POSIX[name];
    if (body === undefined) throw new Error(`unsupported POSIX class [:${name}:]`);
    return body;
  });
}

/** Shannon entropy in bits per character, as gitleaks computes it. */
function shannon(text: string): number {
  if (!text) return 0;
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const share = count / text.length;
    entropy -= share * Math.log2(share);
  }
  return entropy;
}

/**
 * A compiled rule or allowlist regex. Two engines implement it: `linearEngine` (RE2 semantics through re2js, linear
 * in the text whatever the input) and `backtrackingEngine` (JavaScript's own RegExp via `goRegex`). The gate runs
 * `RE2_RULES` and every allowlist on the first and the other rules on the second (`GATE_ENGINES`, D24).
 */
export interface Pattern {
  /** Whether `text` holds a match. */
  test(text: string): boolean;
  /** Every match, leftmost-first and non-overlapping, as `[start, end)`. */
  matches(text: string): Span[];
  /** The group spans of the first match in `text` (0: the whole match), undefined for a group that took no part. */
  groups(text: string): (Span | undefined)[] | null;
}

export type Engine = (goPattern: string) => Pattern;

/** JavaScript's `\s` set (WhiteSpace and LineTerminator), in RE2 class syntax. */
const JS_SPACE = String.raw`\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}`;
/** JavaScript's `.` without the `s` flag: anything but a line terminator. */
const JS_DOT = String.raw`[^\n\r\x{2028}\x{2029}]`;

/**
 * A Go pattern rewritten so RE2 matches what its `goRegex` translation matches in JavaScript: Go's `\s` is ASCII
 * and its `.` excludes only `\n`, JavaScript's `\s` adds Unicode spaces (NBSP, U+2028, …) and its `.` also excludes
 * `\r`, U+2028 and U+2029. What remains different: RE2's `(?i)` folds by Unicode simple case folding (`s` also
 * matches U+017F, `k` U+212A), and RE2 reads text by code point where JavaScript reads UTF-16 units. On 10,000
 * texts sprinkled with such characters and lone surrogates, every rule on RE2 fired as often or more, and kept every
 * character JavaScript's engine redacted (docs/research/architecture-alternatives.md); linear.test.ts pins equal
 * spans on ordinary text.
 */
export function re2Source(pattern: string): string {
  // `[\S]` is the only class with a lone `\S` in the rules; outside a class it becomes the complement below.
  const source = pattern.replaceAll(String.raw`[\S]`, String.raw`\S`);
  let out = "";
  let inClass = false;
  for (let at = 0; at < source.length; at++) {
    const char = source[at]!;
    if (char === "\\") {
      const next = source[at + 1] ?? "";
      if (next === "s") out += inClass ? JS_SPACE : `[${JS_SPACE}]`;
      else if (next === "S") {
        // In a class only `[\s\S…]` (any character, in both dialects) is exact; refuse anything else.
        if (inClass && !/\\s/.test(source.slice(source.lastIndexOf("[", at), source.indexOf("]", at)))) {
          throw new Error(`\\S alone in a class: ${pattern}`);
        }
        out += inClass ? char + next : `[^${JS_SPACE}]`;
      } else out += char + next;
      at++;
    } else if (inClass) {
      if (source.startsWith("[:", at)) {
        const end = source.indexOf(":]", at) + 2;
        out += source.slice(at, end);
        at = end - 1;
      } else {
        if (char === "]") inClass = false;
        out += char;
      }
    } else if (char === "[") {
      inClass = true;
      out += char;
      if (source[at + 1] === "^") out += source[++at];
      if (source[at + 1] === "]") out += source[++at];
    } else out += char === "." ? JS_DOT : char;
  }
  return out;
}

/**
 * RE2 through re2js: time linear in the text for every pattern, so no input can make a rule backtrack (D24). A
 * capture-free DFA `test` runs first, since most candidate rules find nothing and the capturing search costs more.
 */
export const linearEngine: Engine = (goPattern) => {
  const pattern = RE2JS.compile(re2Source(goPattern));
  return {
    test: (text) => pattern.test(text),
    matches(text) {
      const out: Span[] = [];
      if (!pattern.test(text)) return out;
      const matcher = pattern.matcher(text);
      while (matcher.find()) out.push([matcher.start(), matcher.end()]);
      return out;
    },
    groups(text) {
      const matcher = pattern.matcher(text);
      if (!matcher.find()) return null;
      const out: (Span | undefined)[] = [];
      for (let group = 0; group <= matcher.groupCount(); group++) {
        const start = matcher.start(group);
        out.push(start < 0 ? undefined : [start, matcher.end(group)]);
      }
      return out;
    },
  };
};

/** JavaScript's backtracking RegExp, via `goRegex`: the reference for tests and benchmarks. */
export const backtrackingEngine: Engine = (goPattern) => {
  const regex = goRegex(goPattern);
  const indices = new RegExp(regex.source, regex.flags + "d");
  const scan = new RegExp(regex.source, regex.flags + "g");
  return {
    test: (text) => regex.test(text),
    matches: (text) => [...text.matchAll(scan)].map((found): Span => [found.index, found.index + found[0].length]),
    groups: (text) => (indices.exec(text)?.indices as (Span | undefined)[] | undefined) ?? null,
  };
};

function compileAllowlist(list: Allowlist, engine: Engine): CompiledAllowlist {
  return {
    target: list.regexTarget ?? "secret",
    and: list.condition === "AND",
    regexes: (list.regexes ?? []).map(engine),
    stopwords: (list.stopwords ?? []).map((word) => word.toLowerCase()),
    hasPaths: (list.paths ?? []).length > 0,
  };
}

/**
 * One finding of a rule. `line` is read only by allowlists that target the line; `lines` caches it per line, so a
 * long line with many findings is sliced once rather than once per finding.
 */
interface Finding {
  match: string;
  secret: string;
  text: string;
  index: number;
  lines: Map<number, string>;
}

/** Whether an allowlist excuses a finding (gitleaks `checkFindingAllowed`, with no file path or commit). */
function allows(list: CompiledAllowlist, finding: Finding): boolean {
  const target =
    list.target === "match"
      ? finding.match
      : list.target === "line"
        ? lineAt(finding.text, finding.index, finding.lines)
        : finding.secret;
  const regexAllowed = list.regexes.some((regex) => regex.test(target));
  const lower = finding.secret.toLowerCase();
  const stopword = list.stopwords.some((word) => lower.includes(word));
  if (!list.and) return regexAllowed || stopword;
  // AND: every condition the list sets must hold, and a path condition never holds for text.
  if (list.hasPaths || !(list.regexes.length || list.stopwords.length)) return false;
  return (!list.regexes.length || regexAllowed) && (!list.stopwords.length || stopword);
}

/** The line of `text` that holds `index`, cached by the line's start. */
function lineAt(text: string, index: number, lines: Map<number, string>): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  let line = lines.get(start);
  if (line === undefined) {
    const end = text.indexOf("\n", index);
    line = text.slice(start, end < 0 ? text.length : end);
    lines.set(start, line);
  }
  return line;
}

const NEWLINE = 10;

/**
 * A gitleaks rule. As gitleaks does, each match (its ends' line breaks trimmed) is matched again on its own to find
 * the secret: the rule's group, else the first non-empty group, else the whole match. Compiled on first use, since
 * most rules never run (their keywords are absent).
 */
function gitleaksRule(
  rule: GitleaksRule & { regex: string },
  global: CompiledAllowlist,
  engine: Engine,
  allowlistEngine: Engine,
): SecretRule {
  let compiled: { pattern: Pattern; own: CompiledAllowlist[] } | undefined;
  const compile = () => ({
    pattern: engine(rule.regex),
    own: (rule.allowlists ?? []).map((list) => compileAllowlist(list, allowlistEngine)),
  });
  /** The secret's span within `match`; undefined when the rule's group did not take part. */
  const secretIn = (pattern: Pattern, match: string): Span | undefined => {
    const indices = pattern.groups(match);
    if (!indices || indices.length < 2) return [0, match.length];
    if (rule.secretGroup) return indices[rule.secretGroup];
    return indices.slice(1).find((span) => span && span[1] > span[0]) ?? [0, match.length];
  };
  return {
    id: rule.id,
    keywords: (rule.keywords ?? []).map((word) => word.toLowerCase()),
    prefilter: (rule.keywords ?? []).map((word) => word.toLowerCase()),
    spans(text) {
      const { pattern, own } = (compiled ??= compile());
      const out: Span[] = [];
      const lines = new Map<number, string>();
      for (const [start, end] of pattern.matches(text)) {
        // Trim the match's line breaks by index: `/\n+$/` retries from every break in an inner run (quadratic).
        let from = start;
        let to = end;
        while (from < to && text.charCodeAt(from) === NEWLINE) from++;
        while (to > from && text.charCodeAt(to - 1) === NEWLINE) to--;
        const match = text.slice(from, to);
        const at = from === to ? start : from;
        const span = secretIn(pattern, match);
        if (!span) continue;
        const secret = match.slice(span[0], span[1]);
        if (rule.entropy && shannon(secret) <= rule.entropy) continue;
        const finding = { match, secret, text, index: start, lines };
        if (allows(global, finding) || own.some((list) => allows(list, finding))) continue;
        out.push([at + span[0], at + span[1]]);
      }
      return out;
    },
  };
}

/** Rule (d): long letters-and-digits tokens with a secret keyword nearby. */
function entropyWithKeyword(text: string): Span[] {
  const out: Span[] = [];
  for (const found of text.matchAll(ENTROPY_TOKEN)) {
    const token = found[0];
    if (/[/.-]/.test(token) || !/[A-Za-z]/.test(token) || !/\d/.test(token)) continue;
    const before = text.slice(Math.max(0, found.index - KEYWORD_REACH), found.index);
    const after = text.slice(found.index + token.length, found.index + token.length + KEYWORD_REACH);
    if (SECRET_WORD.test(before) || SECRET_WORD.test(after)) out.push([found.index, found.index + token.length]);
  }
  return out;
}

/** Whether a token reads as a file path: two or more slashes, no `+`, and every segment a word (PATH_SEGMENT). */
function isPath(token: string): boolean {
  if (token.includes("+")) return false;
  const segments = token.split("/");
  return segments.length >= 3 && segments.every((segment) => PATH_SEGMENT.test(segment));
}

/**
 * (a″) AWS secret access keys beside an anchor. Pure hex (git SHAs, SHA-1 digests) never qualifies; the token must
 * mix upper and lower case (a random one fails that about once in 10^9) and clear AWS_SECRET_ENTROPY.
 */
function awsSecret(text: string): Span[] {
  const out: Span[] = [];
  const length = text.length;
  const inAlphabet = (at: number) => {
    const code = text.charCodeAt(at);
    return code < 128 && BASE64_CHAR[code] === 1;
  };
  let at = 0;
  while (at < length) {
    if (!inAlphabet(at)) {
      at++;
      continue;
    }
    const start = at;
    while (at < length && inAlphabet(at)) at++;
    const end = at;
    if (end - start !== AWS_SECRET_LENGTH) continue;
    const token = text.slice(start, end);
    if (HEX.test(token) || !/[A-Z]/.test(token) || !/[a-z]/.test(token)) continue;
    if (shannon(token) < AWS_SECRET_ENTROPY || isPath(token)) continue;
    const before = text.slice(Math.max(0, start - KEYWORD_REACH), start);
    const after = text.slice(end, end + KEYWORD_REACH);
    const anchored = (w: string) => AWS_SECRET_ANCHOR.test(w) || AWS_SECRET_WORD.test(w);
    if (anchored(before) || anchored(after)) out.push([start, end]);
  }
  return out;
}

/** Every match of a global regex: group 1 when the regex has one, else the whole match. */
function matchSpans(regex: RegExp, text: string): Span[] {
  return [...text.matchAll(regex)].map((found) => found.indices?.[1] ?? [found.index, found.index + found[0].length]);
}

const plain = (id: string, prefilter: string[], spans: (text: string) => Span[]): SecretRule => ({
  id,
  keywords: [],
  prefilter,
  spans,
});

/**
 * The secret words of KEYWORD_RULE and SECRET_WORD, as literals every match contains: `api[_-]?key` always holds
 * "api", `private[_-]?key` "private".
 */
const SECRET_WORDS = ["password", "passwd", "pwd", "secret", "token", "api", "private", "credential"];
/** Literals every match of each keyword-less shape contains (case-folded; a superset is safe, a miss is not). */
const SHAPE_LITERALS: Record<string, string[]> = {
  "eden-cfat": ["cfat_"],
  "eden-openai": ["sk-"],
  "eden-mailgun": ["key-"],
  "eden-telegram": [":aa"],
  "eden-aws-key-id": ["a3t", "akia", "asia", "abia", "acca"],
};

/**
 * The gitleaks rules whose regexes backtrack badly in JavaScript, found by searching every rule for super-linear
 * inputs (bench/redos.scan.ts in @eden/primitives; docs/research/architecture-alternatives.md): quadratic
 * (`curl-*`: a lazy `.*?` before a required option) or ~60 µs a character (`[\w.-]{0,50}?(?i:[\w.-]{0,50}?…)`: two
 * nested optional runs). On RE2 their worst measured input costs ~2 µs a character (re2js pays per match for the
 * capture groups), against up to ~60 µs and growing on JavaScript's engine.
 *
 * Every other rule stays on JavaScript's engine, which is as fast or faster on typical text, keeps no per-pattern DFA
 * cache (with every rule on RE2, re2js's caches held ~240 MB after crafted input) and is cheaper per match
 * (generic-api-key: ~1 µs a character at worst on JavaScript, ~5 on RE2, whose program for it is large).
 * linear.test.ts keeps those rules under a cost ceiling on crafted input, so a gitleaks update that adds a
 * backtracking rule fails a test rather than shipping.
 */
export const RE2_RULES: ReadonlySet<string> = new Set([
  "cisco-meraki-api-key",
  "cohere-api-token",
  "curl-auth-header",
  "curl-auth-user",
  "okta-access-token",
  "privateai-api-token",
  "sumologic-access-id",
]);

/** Which engine runs a gitleaks rule's regex, and which runs allowlist regexes. */
export interface EngineChoice {
  rule(id: string): Engine;
  allowlist: Engine;
}

/**
 * The gate's choice (D24): RE2 for `RE2_RULES` and for every allowlist regex (they run only on findings, but on
 * a whole line or match, and several are quadratic there in JavaScript: `.+EXAMPLE$`, `[^:]+:…`), JavaScript for
 * the rest.
 */
export const GATE_ENGINES: EngineChoice = {
  rule: (id) => (RE2_RULES.has(id) ? linearEngine : backtrackingEngine),
  allowlist: linearEngine,
};

let compiled: SecretRule[] | undefined;

/** Every rule: gitleaks' (those with a regex) and Eden's (`eden-…`), engines as `GATE_ENGINES` chooses. */
export function secretRules(): SecretRule[] {
  compiled ??= rulesWith(GATE_ENGINES);
  return compiled;
}

/**
 * The same rules with gitleaks' regexes and allowlists run by the engines `choice` picks; Eden's own rules are
 * JavaScript either way. Uncached: for tests and benchmarks that compare engines.
 */
export function rulesWith(choice: EngineChoice): SecretRule[] {
  const config = gitleaks as GitleaksConfig;
  const global = compileAllowlist(config.allowlist, choice.allowlist);
  const withRegex = config.rules.filter((rule): rule is GitleaksRule & { regex: string } => Boolean(rule.regex));
  return [
    ...withRegex.map((rule) => gitleaksRule(rule, global, choice.rule(rule.id), choice.allowlist)),
    // A shape without literals gets none: an empty prefilter means the rule always runs (safe, only slower).
    ...PROVIDER_SHAPES.map(([id, shape]) => plain(id, SHAPE_LITERALS[id] ?? [], (text) => matchSpans(shape, text))),
    plain("eden-keyword", SECRET_WORDS, (text) => matchSpans(KEYWORD_RULE, text)),
    plain("eden-url-userinfo", ["://"], (text) => matchSpans(URL_USERINFO, text)),
    plain("eden-entropy-keyword", SECRET_WORDS, entropyWithKeyword),
    // Every anchor holds one of these literals ("[redacted]" folded, as the matcher folds case).
    plain("eden-aws-secret", ["akia", "asia", "[redacted]", "secret"], awsSecret),
    plain("eden-legacy-keyword", ["passw", "passphrase", "api"], (text) => matchSpans(LEGACY_KEYWORD, text)),
    plain("eden-legacy-token", ["sk-", "ghp_", "gho_", "github_pat_", "akia"], (text) =>
      matchSpans(LEGACY_TOKEN, text),
    ),
  ];
}

/** One engine for every rule and allowlist: the all-RE2 and all-JavaScript gates the tests and benchmarks compare. */
export const everywhere = (engine: Engine): EngineChoice => ({ rule: () => engine, allowlist: engine });

/** A secret gate over a set of rules. */
export interface Gate {
  /** The ids of the rules `text` hits, sorted. */
  secretHits(text: string): string[];
  /** `text` with every secret the rules find replaced, then the structural redactor applied. */
  sanitizeForStore(text: string): string;
}

/**
 * One multi-pattern pass over the text for every rule's prefilter words (Aho–Corasick, `@eden/primitives`), instead
 * of an `includes` scan per word: the whole gate runs 5–8x faster on a 2 KB email across measured runs
 * (bench/gate.bench.ts in @eden/primitives; docs/research/primitives.md). The matcher folds case and accents, so it
 * reports a superset of `text.toLowerCase().includes(word)`: a rule it lets through still applies its own regex, so
 * results are unchanged (prefilter.test.ts checks this against the per-word scan).
 *
 * `gateOf` builds the gate over any rules: tests and benchmarks build reference gates with it.
 */
export function gateOf(rules: SecretRule[]): Gate {
  const words = [...new Set(rules.flatMap((rule) => rule.prefilter))];
  const index = new Map(words.map((word, i) => [word, i]));
  const rulesOf: number[][] = words.map(() => []);
  const always: number[] = [];
  rules.forEach((rule, r) => {
    // No words, or an empty word (which `includes` would always find): the rule always runs.
    if (rule.prefilter.length === 0 || rule.prefilter.some((word) => word.length === 0)) always.push(r);
    for (const word of new Set(rule.prefilter)) rulesOf[index.get(word)!]!.push(r);
  });
  const matcher = new MultiMatcher(words);

  const candidates = (text: string): SecretRule[] => {
    const hits = new Uint8Array(rulesOf.length);
    const chosen = new Uint8Array(rules.length);
    for (const r of always) chosen[r] = 1;
    if (matcher.markHits(text, hits) > 0) {
      for (let w = 0; w < hits.length; w++) if (hits[w] === 1) for (const r of rulesOf[w]!) chosen[r] = 1;
    }
    return rules.filter((_, r) => chosen[r] === 1);
  };
  /** The rules whose prefilter words `text` holds, each with the spans it finds there. */
  const findings = (text: string): { id: string; spans: Span[] }[] =>
    candidates(text)
      .map((rule) => ({ id: rule.id, spans: rule.spans(text) }))
      .filter((found) => found.spans.length > 0);

  return {
    secretHits: (text) =>
      findings(text)
        .map((found) => found.id)
        .sort(),
    sanitizeForStore(text) {
      const spans = findings(text)
        .flatMap((found) => found.spans)
        .sort((a, b) => a[0] - b[0]);
      let out = "";
      let at = 0;
      for (const [start, end] of spans) {
        if (end <= at) continue;
        out += text.slice(at, Math.max(start, at)) + (start >= at ? REDACTED : "");
        at = end;
      }
      const gated = out + text.slice(at);
      const redacted = redact(gated);
      return typeof redacted === "string" ? redacted : gated;
    },
  };
}

let gate: Gate | undefined;

/** The ids of the rules `text` hits, sorted; empty when it carries no secret D13 knows. */
export function secretHits(text: string): string[] {
  gate ??= gateOf(secretRules());
  return gate.secretHits(text);
}

/**
 * D13's one gate (A6 §2.2, A4 §3.0): the text a memory writer may store. Every secret a rule finds is replaced by
 * `[REDACTED]` (overlapping finds as one), so "the staging password is [REDACTED]" keeps what the value is for and
 * nothing of the value. With rule (e) and the IR redactor (`@eden/ir`, the trace redactor), which runs after it, the
 * gate is never looser than the redaction memory had before. A text with no secret is returned as it is.
 */
export function sanitizeForStore(text: string): string {
  gate ??= gateOf(secretRules());
  return gate.sanitizeForStore(text);
}
