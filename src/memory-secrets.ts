/**
 * D13's secret gate, as A6 §2.2 details it: which rules a text hits. Nothing here redacts or writes; callers
 * decide (`eden eval build-negatives` drops the prompt; P0.4's `sanitizeForStore` will redact).
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
 * - (b) D13's keyword rule, whatever the value's entropy;
 * - (c) URL userinfo, `scheme://user:pass@`;
 * - (d) entropy only with a keyword: a whitespace-delimited token of ≥ 32 characters that mixes letters and
 *   digits and holds no `/`, `.` or `-`, with a secret keyword within 40 characters. ULIDs, UUIDs, `sha512-`
 *   integrity strings and paths never qualify on their own.
 */
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

export interface SecretRule {
  id: string;
  /** Lower-case words of which at least one must occur in the text for the rule to run; none: always runs. */
  keywords: string[];
  hits(text: string): boolean;
}

/** D13's keyword rule, verbatim, and case-insensitive: env lines spell it `PASSWORD=`. */
const KEYWORD_RULE =
  /(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential)s?\b[^\n]{0,20}?(is|=|:)\s*\S{6,}/i;
const SECRET_WORD = /(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential)/i;
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@/i;
/** (a′): the bare shapes, with no keyword, marker or entropy condition. */
const PROVIDER_SHAPES: [string, RegExp][] = [
  ["eden-cfat", /\bcfat_[A-Za-z0-9_-]{20,}/],
  ["eden-openai", /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/],
  ["eden-mailgun", /\bkey-[0-9a-f]{32}\b/],
  ["eden-telegram", /\b\d{8,10}:AA[A-Za-z0-9_-]{32,}/],
  ["eden-aws-key-id", /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/],
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

function gitleaksRule(rule: GitleaksRule & { regex: string }, global: CompiledAllowlist): SecretRule {
  const regex = goRegex(rule.regex);
  const scan = new RegExp(regex.source, regex.flags + "g");
  const own = (rule.allowlists ?? []).map(compileAllowlist);
  /** gitleaks: the rule's group, else the first non-empty group, else the whole match. */
  const secretOf = (match: string): string | undefined => {
    const groups = regex.exec(match);
    if (!groups || groups.length < 2) return match;
    if (rule.secretGroup) return groups[rule.secretGroup];
    return groups.slice(1).find((group) => group) ?? match;
  };
  return {
    id: rule.id,
    keywords: (rule.keywords ?? []).map((word) => word.toLowerCase()),
    hits(text) {
      for (const found of text.matchAll(scan)) {
        const match = found[0].replace(/^\n+|\n+$/g, "");
        const secret = secretOf(match);
        if (secret === undefined) continue;
        if (rule.entropy && shannon(secret) <= rule.entropy) continue;
        const finding = { match, secret, line: lineAt(text, found.index) };
        if (allows(global, finding) || own.some((list) => allows(list, finding))) continue;
        return true;
      }
      return false;
    },
  };
}

/** Rule (d): a long letters-and-digits token with a secret keyword nearby. */
function entropyWithKeyword(text: string): boolean {
  for (const found of text.matchAll(ENTROPY_TOKEN)) {
    const token = found[0];
    if (/[/.-]/.test(token) || !/[A-Za-z]/.test(token) || !/\d/.test(token)) continue;
    const before = text.slice(Math.max(0, found.index - KEYWORD_REACH), found.index);
    const after = text.slice(found.index + token.length, found.index + token.length + KEYWORD_REACH);
    if (SECRET_WORD.test(before) || SECRET_WORD.test(after)) return true;
  }
  return false;
}

const plain = (id: string, test: (text: string) => boolean): SecretRule => ({ id, keywords: [], hits: test });

let compiled: SecretRule[] | undefined;

/** Every rule: gitleaks' (those with a regex) and Eden's (`eden-…`). Compiled once. */
export function secretRules(): SecretRule[] {
  if (compiled) return compiled;
  const config = gitleaks as GitleaksConfig;
  const global = compileAllowlist(config.allowlist);
  const withRegex = config.rules.filter((rule): rule is GitleaksRule & { regex: string } => Boolean(rule.regex));
  compiled = [
    ...withRegex.map((rule) => gitleaksRule(rule, global)),
    ...PROVIDER_SHAPES.map(([id, shape]) => plain(id, (text) => shape.test(text))),
    plain("eden-keyword", (text) => KEYWORD_RULE.test(text)),
    plain("eden-url-userinfo", (text) => URL_USERINFO.test(text)),
    plain("eden-entropy-keyword", entropyWithKeyword),
  ];
  return compiled;
}

/** The ids of the rules `text` hits, sorted; empty when it carries no secret D13 knows. */
export function secretHits(text: string): string[] {
  const lower = text.toLowerCase();
  return secretRules()
    .filter((rule) => !rule.keywords.length || rule.keywords.some((word) => lower.includes(word)))
    .filter((rule) => rule.hits(text))
    .map((rule) => rule.id)
    .sort();
}
