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
 * - (b) D13's keyword rule, whatever the value's entropy, with `is` read as a word ("secrets in this" assigns
 *   nothing) and an already redacted value left alone;
 * - (c) URL userinfo, `scheme://user:pass@`;
 * - (d) entropy only with a keyword: a whitespace-delimited token of ≥ 32 characters that mixes letters and
 *   digits and holds no `/`, `.` or `-`, with a secret keyword within 40 characters. ULIDs, UUIDs, `sha512-`
 *   integrity strings and paths never qualify on their own;
 * - (e) the redaction memory had before P0.4 (a password, passphrase or API key of any length; short token
 *   prefixes), so the gate is never looser than it was.
 */
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
  regexes: RegExp[];
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
/** URL userinfo, with the password in group 1: the user and host stay, as they say where the secret is for. */
const URL_USERINFO = new RegExp(String.raw`\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?!\[REDACTED\]@)([^\s/@]+)@`, "dgi");
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

function compileAllowlist(list: Allowlist): CompiledAllowlist {
  return {
    target: list.regexTarget ?? "secret",
    and: list.condition === "AND",
    regexes: (list.regexes ?? []).map(goRegex),
    stopwords: (list.stopwords ?? []).map((word) => word.toLowerCase()),
    hasPaths: (list.paths ?? []).length > 0,
  };
}

interface Finding {
  match: string;
  secret: string;
  line: string;
}

/** Whether an allowlist excuses a finding (gitleaks `checkFindingAllowed`, with no file path or commit). */
function allows(list: CompiledAllowlist, finding: Finding): boolean {
  const target = list.target === "match" ? finding.match : list.target === "line" ? finding.line : finding.secret;
  const regexAllowed = list.regexes.some((regex) => regex.test(target));
  const lower = finding.secret.toLowerCase();
  const stopword = list.stopwords.some((word) => lower.includes(word));
  if (!list.and) return regexAllowed || stopword;
  // AND: every condition the list sets must hold, and a path condition never holds for text.
  if (list.hasPaths || !(list.regexes.length || list.stopwords.length)) return false;
  return (!list.regexes.length || regexAllowed) && (!list.stopwords.length || stopword);
}

/** The line of `text` that holds `index`. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end < 0 ? text.length : end);
}

/**
 * A gitleaks rule. As gitleaks does, each match (its ends' line breaks trimmed) is matched again on its own to find
 * the secret: the rule's group, else the first non-empty group, else the whole match. Compiled on first use, since
 * most rules never run (their keywords are absent).
 */
function gitleaksRule(rule: GitleaksRule & { regex: string }, global: CompiledAllowlist): SecretRule {
  let compiled: { regex: RegExp; scan: RegExp; own: CompiledAllowlist[] } | undefined;
  const compile = () => {
    const regex = goRegex(rule.regex);
    return {
      regex: new RegExp(regex.source, regex.flags + "d"),
      scan: new RegExp(regex.source, regex.flags + "g"),
      own: (rule.allowlists ?? []).map(compileAllowlist),
    };
  };
  /** The secret's span within `match`; undefined when the rule's group did not take part. */
  const secretIn = (regex: RegExp, match: string): Span | undefined => {
    const indices = regex.exec(match)?.indices;
    if (!indices || indices.length < 2) return [0, match.length];
    if (rule.secretGroup) return indices[rule.secretGroup];
    return indices.slice(1).find((span) => span && span[1] > span[0]) ?? [0, match.length];
  };
  return {
    id: rule.id,
    keywords: (rule.keywords ?? []).map((word) => word.toLowerCase()),
    spans(text) {
      const { regex, scan, own } = (compiled ??= compile());
      const out: Span[] = [];
      for (const found of text.matchAll(scan)) {
        const match = found[0].replace(/^\n+|\n+$/g, "");
        const at = found.index + found[0].indexOf(match);
        const span = secretIn(regex, match);
        if (!span) continue;
        const secret = match.slice(span[0], span[1]);
        if (rule.entropy && shannon(secret) <= rule.entropy) continue;
        const finding = { match, secret, line: lineAt(text, found.index) };
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

/** Every match of a global regex: group 1 when the regex has one, else the whole match. */
function matchSpans(regex: RegExp, text: string): Span[] {
  return [...text.matchAll(regex)].map((found) => found.indices?.[1] ?? [found.index, found.index + found[0].length]);
}

const plain = (id: string, spans: (text: string) => Span[]): SecretRule => ({ id, keywords: [], spans });

let compiled: SecretRule[] | undefined;

/** Every rule: gitleaks' (those with a regex) and Eden's (`eden-…`). */
export function secretRules(): SecretRule[] {
  if (compiled) return compiled;
  const config = gitleaks as GitleaksConfig;
  const global = compileAllowlist(config.allowlist);
  const withRegex = config.rules.filter((rule): rule is GitleaksRule & { regex: string } => Boolean(rule.regex));
  compiled = [
    ...withRegex.map((rule) => gitleaksRule(rule, global)),
    ...PROVIDER_SHAPES.map(([id, shape]) => plain(id, (text) => matchSpans(shape, text))),
    plain("eden-keyword", (text) => matchSpans(KEYWORD_RULE, text)),
    plain("eden-url-userinfo", (text) => matchSpans(URL_USERINFO, text)),
    plain("eden-entropy-keyword", entropyWithKeyword),
    plain("eden-legacy-keyword", (text) => matchSpans(LEGACY_KEYWORD, text)),
    plain("eden-legacy-token", (text) => matchSpans(LEGACY_TOKEN, text)),
  ];
  return compiled;
}

/** The rules whose keywords `text` holds, each with the spans it finds there. */
function findings(text: string): { id: string; spans: Span[] }[] {
  const lower = text.toLowerCase();
  return secretRules()
    .filter((rule) => !rule.keywords.length || rule.keywords.some((word) => lower.includes(word)))
    .map((rule) => ({ id: rule.id, spans: rule.spans(text) }))
    .filter((found) => found.spans.length > 0);
}

/** The ids of the rules `text` hits, sorted; empty when it carries no secret D13 knows. */
export function secretHits(text: string): string[] {
  return findings(text)
    .map((found) => found.id)
    .sort();
}

/**
 * D13's one gate (A6 §2.2, A4 §3.0): the text a memory writer may store. Every secret a rule finds is replaced by
 * `[REDACTED]` (overlapping finds as one), so "the staging password is [REDACTED]" keeps what the value is for and
 * nothing of the value. With rule (e) and the IR redactor (`@eden/ir`, the trace redactor), which runs after it, the
 * gate is never looser than the redaction memory had before. A text with no secret is returned as it is.
 */
export function sanitizeForStore(text: string): string {
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
}
