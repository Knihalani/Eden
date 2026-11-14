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
import { MultiMatcher } from "./primitives/matcher.ts";
import {
  type Analyses,
  AnchoredRegex,
  anchorsOf,
  anchorsOfRegex,
  lazyPrefixOf,
  Occurrences,
  useAnalyses,
} from "./anchor.ts";
import { compileAllowlistRegex, parseRegex, type Tester } from "./automaton.ts";
import {
  assignmentSpans,
  redactAssignments,
  REDACTED,
  redactTokensIn,
  TOKEN_LITERALS,
  TOKEN_PASSES,
} from "./redact.ts";
import { SCANNERS } from "./scanners.ts";
import generated from "./rules.generated.json" with { type: "json" };

// The vendored gitleaks config (`vendor/gitleaks/gitleaks.toml`, as data any runtime imports) and each regex's
// anchors, worked out ahead by `generate.ts`; `generated.test.ts` fails when either is stale.
useAnalyses(generated.analyses as Analyses);

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
  regexes: Tester[];
  stopwords: Stopwords;
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
  /**
   * Lower-case literals that tell where the rule's matches can start (anchor.ts); absent when the rule scans the whole
   * text. The gate passes their occurrences, found in its one prefilter pass, to `spans`.
   */
  anchorWords?: string[];
  /**
   * Where the rule's secrets sit in `text`; none when it finds none. `found` holds the occurrences of `anchorWords`,
   * `ids[i]` being the id there of `anchorWords[i]`; without them the rule scans the whole text, with the same result.
   */
  spans(text: string, found?: Occurrences, ids?: Int32Array): Span[];
  /** Compiles what the rule would compile on its first `spans` call (`warmGate`); absent when nothing is deferred. */
  warm?(): void;
}

/**
 * D13's keyword rule, case-insensitive (env lines spell it `PASSWORD=`), with `is` read as a word and the value in
 * group 1. A value already redacted is no secret. A quoted value is taken whole, up to 256 characters (audit A5:
 * `\S{6,}` took `"correct` of `my password is "correct horse battery staple"` and left the rest), in double, single or
 * typographic quotes (audit A20: prose quotes a passphrase in any of them).
 */
const KEYWORD_RULE = new RegExp(
  String.raw`(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential)s?\b[^\n]{0,20}?(?:\bis\b|=|:)\s*(?!\[REDACTED\])("[^"\n]{4,256}"|'[^'\n]{4,256}'|“[^”\n]{4,256}”|‘[^’\n]{4,256}’|\S{6,})`,
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
  // A Discord webhook URL is a bearer capability (anyone holding it posts as the webhook); gitleaks has no rule for
  // it. The token is 68 characters today; 60+ leaves room without matching a path that merely names a webhook. A
  // versioned path (`/api/v10/webhooks/`, what REST clients log) is the same capability, and hosts ignore case.
  ["eden-discord-webhook", /\bdiscord(?:app)?\.com\/api\/(?:v\d{1,2}\/)?webhooks\/\d{17,20}\/[A-Za-z0-9_-]{60,}/gi],
  // A New Relic user API key (D220). gitleaks' rule wants "new relic" within reach of it, so a key pasted alone
  // (a chat message, a runbook line) passed. The prefix and the exact length make the bare shape specific enough.
  ["eden-new-relic", /\bNRAK-[A-Z0-9]{27}\b/gi],
];
/**
 * A presigned or signed object URL (S3 SigV4, GCS V4) is a bearer capability until it expires, up to 7 days: anyone
 * holding it reads (or writes) the object (D220, which reverses D187's note). Only the value goes, so the URL still
 * says which object it was; an STS session token in the URL goes too. Before the name, `;` covers `&amp;` in HTML
 * mail, `\u0026` JSON from Go servers (encoding/json escapes `&`), and `%3F`/`%26` a URL percent-encoded inside
 * another (a redirect's `next=`), whose `=` is `%3D`. The value stops at a backslash or `%26` for the same reasons.
 *
 * The regex finds only the name; the value is read by a walk over its characters to the first stop or `%26`. Each
 * walk ends where the next name can begin, so the text is read about once. Written in the regex the value was not
 * linear: a lookahead at every character cost 240 ms per MB on one long value; an unrolled loop over `%` kept engine
 * state per `%` (215 ms for a 1 MB value of `%`, and past that the engine gave up and matched nothing, leaving the
 * value in clear); a greedy class cut at `%26` afterwards re-read the rest of the text for every parameter.
 */
const PRESIGNED_NAME = new RegExp(
  String.raw`(?:[?&;]|\\u0026|%3F|%26)(?:x-amz-signature|x-goog-signature|x-amz-security-token)(?:=|%3D)`,
  "gi",
);
/** The shortest value taken for a signature or token: shorter is a placeholder or a name, not a credential. */
const PRESIGNED_MIN = 16;
/** Where a value stops: whitespace, `&`, `#`, quotes, `<`, `>`, backslash (char codes; `%26` is checked apart). */
const VALUE_STOP = new Set([...`&#"'<>\\`].map((c) => c.charCodeAt(0)));

function presignedSpans(text: string): Span[] {
  const spans: Span[] = [];
  const name = new RegExp(PRESIGNED_NAME); // its own lastIndex
  for (let m = name.exec(text); m; m = name.exec(text)) {
    const start = m.index + m[0].length;
    let end = start;
    for (; end < text.length; end++) {
      const c = text.charCodeAt(end);
      if (VALUE_STOP.has(c) || isSpace(c)) break;
      // `%26` ends the value (an encoded `&`).
      if (c === 37 && text.charCodeAt(end + 1) === 50 && text.charCodeAt(end + 2) === 54) break;
    }
    if (end - start >= PRESIGNED_MIN) spans.push([start, end]);
    name.lastIndex = Math.max(end, m.index + 1); // the next name may begin at the stop (`%26`, `&`)
  }
  return spans;
}

/** JavaScript's `\s` on one code unit (WhiteSpace and LineTerminator; secrets.test.ts checks every code unit). */
export const isSpace = (c: number): boolean =>
  c <= 32
    ? c === 32 || (c >= 9 && c <= 13)
    : c >= 0xa0 &&
      (c === 0xa0 ||
        c === 0x1680 ||
        (c >= 0x2000 && c <= 0x200a) ||
        c === 0x2028 ||
        c === 0x2029 ||
        c === 0x202f ||
        c === 0x205f ||
        c === 0x3000 ||
        c === 0xfeff);

/** Rule (d)'s tokens: `/\S{32,}/g`, as `entropyWithKeyword` walks them (ENTROPY_MIN). */
const ENTROPY_MIN = 32;
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
 * A compiled rule regex. The gate runs `LINEAR_RULES` on their own linear matchers (`scanners.ts`, D1705) and the
 * other rules on `backtrackingEngine` (JavaScript's own RegExp via `goRegex`); tests compare both with re2js
 * (`linearEngine` in re2-oracle.ts, the gate D24 shipped).
 */
export interface Pattern extends Tester {
  /** Every match, leftmost-first and non-overlapping, as `[start, end)`. */
  matches(text: string): Span[];
  /** The group spans of the first match in `text` (0: the whole match), undefined for a group that took no part. */
  groups(text: string): (Span | undefined)[] | null;
}

export type Engine = (goPattern: string) => Pattern;
/** Compiles an allowlist regex: allowlists only ask whether a regex occurs. */
export type AllowlistEngine = (goPattern: string) => Tester;

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

function compileAllowlist(list: Allowlist, engine: AllowlistEngine): CompiledAllowlist {
  return {
    target: list.regexTarget ?? "secret",
    and: list.condition === "AND",
    regexes: (list.regexes ?? []).map((regex) => engine(regex)),
    stopwords: new Stopwords((list.stopwords ?? []).map((word) => word.toLowerCase())),
    hasPaths: (list.paths ?? []).length > 0,
  };
}

/**
 * One finding of a rule. Its line is read only by allowlists that target the line, through `lines` (one per rule
 * call), which finds and tests each line once however many findings it holds.
 */
interface Finding {
  match: string;
  secret: string;
  index: number;
  lines: Lines;
}

/** Whether an allowlist excuses a finding (gitleaks `checkFindingAllowed`, with no file path or commit). */
function allows(list: CompiledAllowlist, finding: Finding): boolean {
  const regexAllowed =
    list.target === "line"
      ? finding.lines.allowed(list, finding.index)
      : list.regexes.some((regex) => regex.test(list.target === "match" ? finding.match : finding.secret));
  // Both tests are pure, so the stopwords are read only when their answer can change the verdict.
  const stopword = () => list.stopwords.size > 0 && list.stopwords.occurIn(finding.secret.toLowerCase());
  if (!list.and) return regexAllowed || stopword();
  // AND: every condition the list sets must hold, and a path condition never holds for text.
  if (list.hasPaths || !(list.regexes.length || list.stopwords.size)) return false;
  return (!list.regexes.length || regexAllowed) && (!list.stopwords.size || stopword());
}

/**
 * An allowlist's stopwords: `occurIn(lower)` is `words.some((word) => lower.includes(word))`, read position by
 * position against the words that start with the two characters there (generic-api-key has 1,477 stopwords, and
 * an `includes` for each cost more than the rest of a finding).
 */
class Stopwords {
  readonly size: number;
  /** Words of two or more characters by their first two (`c0 << 16 | c1`); one-character words; an empty word. */
  private readonly byPair = new Map<number, string[]>();
  private readonly single = new Set<number>();
  private readonly empty: boolean;

  constructor(words: string[]) {
    this.size = words.length;
    this.empty = words.includes("");
    for (const word of words) {
      if (word.length === 1) this.single.add(word.charCodeAt(0));
      if (word.length < 2) continue;
      const key = (word.charCodeAt(0) << 16) | word.charCodeAt(1);
      const list = this.byPair.get(key);
      if (list) list.push(word);
      else this.byPair.set(key, [word]);
    }
  }

  occurIn(lower: string): boolean {
    if (this.empty) return true;
    const n = lower.length;
    for (let i = 0; i < n; i++) {
      const c = lower.charCodeAt(i);
      if (this.single.size > 0 && this.single.has(c)) return true;
      if (i + 1 >= n) break;
      const list = this.byPair.get((c << 16) | lower.charCodeAt(i + 1));
      if (list) for (const word of list) if (lower.startsWith(word, i)) return true;
    }
    return false;
  }
}

/**
 * The lines of one text as a rule's findings reach them, and whether each line-targeted allowlist's regexes occur in
 * each. The verdict depends on the line alone, so it is worked out once a line: tested once a finding, a line holding
 * many findings was read again for each (a 64 KB line of `bedrock-api-key-='` took 3.4 s and 128 KB 13 s, quadratic;
 * so was the search back to each finding's line start). Findings come in increasing order, so the line breaks are
 * found by one forward walk.
 */
class Lines {
  private readonly text: string;
  /** The line holding `last`: its start, and its end (the first `\n` at or after `last`, or the text's length). */
  private start = 0;
  private end = -1;
  private last = 0;
  private readonly verdicts = new Map<CompiledAllowlist, boolean>();

  constructor(text: string) {
    this.text = text;
  }

  /** Whether one of `list`'s regexes occurs in the line that holds `index` (a line ends before its `\n`). */
  allowed(list: CompiledAllowlist, index: number): boolean {
    if (this.end < 0 || index < this.last) {
      // The first finding, or one before the last (no rule reports one, but the answer must not depend on order).
      this.start = this.text.lastIndexOf("\n", index - 1) + 1;
      this.end = this.breakFrom(index);
      this.verdicts.clear();
    } else if (this.end < index) {
      // A break lies before `index`: walk the breaks forward to the line that holds it.
      let start = this.end + 1;
      let end = this.breakFrom(start);
      while (end < index) {
        start = end + 1;
        end = this.breakFrom(start);
      }
      this.start = start;
      this.end = end;
      this.verdicts.clear();
    }
    this.last = index;
    let verdict = this.verdicts.get(list);
    if (verdict === undefined) {
      const line = this.text.slice(this.start, this.end);
      verdict = list.regexes.some((regex) => regex.test(line));
      this.verdicts.set(list, verdict);
    }
    return verdict;
  }

  private breakFrom(at: number): number {
    const end = this.text.indexOf("\n", at);
    return end < 0 ? this.text.length : end;
  }
}

const NEWLINE = 10;
/** A cheap first test for `lazyPrefixOf`, so the other rules build no JavaScript regex before they run. */
export const LAZY_PREFIX = /^(?:\(\?i\))?\[\\w\.-\]\{0,\d+\}\?/;

/**
 * A gitleaks rule. As gitleaks does, each match (its ends' line breaks trimmed) is matched again on its own to find
 * the secret: the rule's group, else the first non-empty group, else the whole match. Compiled on first use, since
 * most rules never run (their keywords are absent).
 */
function gitleaksRule(
  rule: GitleaksRule & { regex: string },
  global: CompiledAllowlist,
  engine: Engine,
  allowlistEngine: AllowlistEngine,
): SecretRule {
  let compiled: { pattern: Pattern; own: CompiledAllowlist[]; anchored?: AnchoredRegex } | undefined;
  // Only JavaScript's engine scans every position: the own matchers (scanners.ts) are linear already. A rule with a
  // lazy `[\w.-]{0,50}?` prefix reads it by hand (anchor.ts); any other tries its regex where its anchors allow.
  const lazy =
    engine === backtrackingEngine && LAZY_PREFIX.test(rule.regex)
      ? lazyPrefixOf(rule.regex, () => goRegex(rule.regex))
      : undefined;
  const anchors = engine === backtrackingEngine && !lazy ? anchorsOf(rule.regex) : undefined;
  const anchorWords = lazy ? lazy.words : anchors && [...new Set(anchors.flatMap((anchor) => anchor.literals))];
  const compile = () => ({
    pattern: engine(rule.regex),
    own: (rule.allowlists ?? []).map((list) => compileAllowlist(list, allowlistEngine)),
    anchored: anchors && new AnchoredRegex(goRegex(rule.regex), anchors),
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
    ...(anchorWords ? { anchorWords } : {}),
    spans(text, found, ids) {
      const { pattern, own, anchored } = (compiled ??= compile());
      const out: Span[] = [];
      const lines = new Lines(text);
      const onMatch = (start: number, end: number) => {
        // Trim the match's line breaks by index: `/\n+$/` retries from every break in an inner run (quadratic).
        let from = start;
        let to = end;
        while (from < to && text.charCodeAt(from) === NEWLINE) from++;
        while (to > from && text.charCodeAt(to - 1) === NEWLINE) to--;
        const match = text.slice(from, to);
        const at = from === to ? start : from;
        const span = secretIn(pattern, match);
        if (!span) return;
        const secret = match.slice(span[0], span[1]);
        if (rule.entropy && shannon(secret) <= rule.entropy) return;
        const finding = { match, secret, index: start, lines };
        if (allows(global, finding) || own.some((list) => allows(list, finding))) return;
        out.push([at + span[0], at + span[1]]);
      };
      if (lazy) {
        lazy.each(text, found, ids, onMatch);
        return out;
      }
      const tried = anchored?.each(text, found, ids, (m) => onMatch(m.index, m.index + m[0].length));
      if (!tried) for (const [start, end] of pattern.matches(text)) onMatch(start, end);
      return out;
    },
    warm() {
      const { pattern, own, anchored } = (compiled ??= compile());
      // One match on the empty text makes the engine build its matcher too (JavaScriptCore compiles a RegExp on its
      // first run, an allowlist automaton its first states), so the first real text pays for neither.
      pattern.test("");
      anchored?.warm();
      lazy?.warm();
      for (const list of [global, ...own]) for (const regex of list.regexes) regex.test("");
    },
  };
}

/**
 * Rule (d): long letters-and-digits tokens with a secret keyword nearby. The tokens are `/\S{32,}/g`'s matches,
 * found by a walk over the text's code units: global and greedy, it matches exactly the maximal runs of non-space
 * code units at least 32 long (a match ends at a space or the end, and a shorter run fails from every position in
 * it), so the walk reports those runs. As a regex it tried each position of a shorter run again.
 */
function entropyWithKeyword(text: string): Span[] {
  const out: Span[] = [];
  const n = text.length;
  // `start` is where a run may begin: 0, or just after a space. A run of ENTROPY_MIN or more from there has no space
  // in its first ENTROPY_MIN units, so the window is read from its far end: the last space in it (most windows of
  // prose have one near the end) moves `start` past it, and only a window without one is a run, walked to its end.
  let start = 0;
  while (start + ENTROPY_MIN <= n) {
    let back = start + ENTROPY_MIN - 1;
    while (back >= start && !isSpace(text.charCodeAt(back))) back--;
    if (back >= start) {
      start = back + 1;
      continue;
    }
    let at = start + ENTROPY_MIN;
    while (at < n && !isSpace(text.charCodeAt(at))) at++;
    const from = start;
    start = at + 1; // `at` is a space or the end
    const token = text.slice(from, at);
    if (/[/.-]/.test(token) || !/[A-Za-z]/.test(token) || !/\d/.test(token)) continue;
    const before = text.slice(Math.max(0, from - KEYWORD_REACH), from);
    const after = text.slice(at, at + KEYWORD_REACH);
    if (SECRET_WORD.test(before) || SECRET_WORD.test(after)) out.push([from, at]);
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

/** A match's group 1 when the regex has one and it took part, else the whole match. */
const spanOf = (found: RegExpExecArray): Span =>
  (found.indices?.[1] as Span | undefined) ?? [found.index, found.index + found[0].length];

/** Every match of a global regex: group 1 when the regex has one, else the whole match. */
function matchSpans(regex: RegExp, text: string): Span[] {
  return [...text.matchAll(regex)].map(spanOf);
}

/**
 * One of Eden's regex rules (`matchSpans`), tried only where its anchors allow when the gate passes the occurrences
 * of their literals (anchor.ts; the regex's lookarounds do not count). Without them it scans, with the same spans.
 */
function regexRule(id: string, prefilter: string[], regex: RegExp): SecretRule {
  const anchors = anchorsOfRegex(regex);
  const anchored = anchors && new AnchoredRegex(regex, anchors);
  return {
    id,
    keywords: [],
    prefilter,
    ...(anchored ? { anchorWords: anchored.words } : {}),
    spans(text, found, ids) {
      const out: Span[] = [];
      if (anchored?.each(text, found, ids, (m) => out.push(spanOf(m)))) return out;
      return matchSpans(regex, text);
    },
    ...(anchored ? { warm: () => anchored.warm() } : {}),
  };
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
  "eden-discord-webhook": ["discord"],
  "eden-new-relic": ["nrak-"],
  "eden-presigned-url": ["x-amz-", "x-goog-"],
};

/**
 * The gitleaks rules whose regexes backtrack badly in JavaScript, found by searching every rule for super-linear
 * inputs (bench/redos.scan.ts in @eden/primitives; docs/research/architecture-alternatives.md): quadratic
 * (`curl-*`: a lazy `.*?` before a required option) or ~60 µs a character (`[\w.-]{0,50}?(?i:[\w.-]{0,50}?…)`: two
 * nested optional runs). Each runs on a hand-written matcher (`SCANNERS`, scanners.ts) that is linear in the text and
 * reports what RE2 reports for its regex (D1705; D24 ran them on re2js).
 *
 * Every other rule stays on JavaScript's engine, which is fast on typical text and keeps no per-pattern cache.
 * The redos tests keep those rules under a cost ceiling on crafted input, so a gitleaks update that adds a
 * backtracking rule fails a test rather than shipping; one that changes a scanned rule's regex fails `rulesWith`.
 */
export const LINEAR_RULES: ReadonlySet<string> = new Set(SCANNERS.keys());

/** Which engine runs a gitleaks rule's regex, and which runs allowlist regexes. */
export interface EngineChoice {
  rule(id: string): Engine;
  allowlist: AllowlistEngine;
}

/** A scanned rule's matcher, for the regex it was written for; any other regex throws. */
export function scannerEngine(id: string): Engine {
  return (goPattern) => {
    const scanner = SCANNERS.get(id);
    if (!scanner || scanner.regex !== goPattern) throw new Error(`no matcher for ${id}'s regex: ${goPattern}`);
    return scanner.pattern;
  };
}

/**
 * The gate's choice (D1705): the scanned rules on their matchers, every allowlist regex on the allowlist automaton
 * (automaton.ts: allowlists run on a whole line or match, and several are quadratic there in JavaScript:
 * `.+EXAMPLE$`, `[^:]+:…`), JavaScript for the rest. No production dependency: re2js is the tests' oracle.
 */
export const GATE_ENGINES: EngineChoice = {
  rule: (id) => (LINEAR_RULES.has(id) ? scannerEngine(id) : backtrackingEngine),
  allowlist: compileAllowlistRegex,
};

/**
 * Throws unless every scanned rule is in the vendored config with exactly the regex its matcher implements: a
 * gitleaks update that changes one must fail loudly, never run a matcher written for another regex.
 */
function checkScanners(rules: GitleaksRule[]): void {
  for (const [id, scanner] of SCANNERS) {
    const rule = rules.find((r) => r.id === id);
    if (!rule || rule.regex !== scanner.regex) {
      throw new Error(`gitleaks rule ${id} changed: update its matcher in scanners.ts (D1705) before vendoring`);
    }
  }
}

/**
 * Throws unless every rule's own allowlist regexes parse in the allowlist automaton's subset. Those compile only when
 * their rule first runs, so without this an unsupported one (`(?m)…`) would throw on the first text that rule finds
 * something in. `generate.ts` runs it when it writes the config the gate imports, so a gitleaks update with one fails
 * there (and `generated.test.ts` fails until it is regenerated), not at the first call.
 */
export function checkAllowlists(rules: GitleaksRule[]): void {
  for (const rule of rules) {
    for (const list of rule.allowlists ?? []) for (const regex of list.regexes ?? []) parseRegex(regex);
  }
}

let compiled: SecretRule[] | undefined;

/**
 * Throws unless this JavaScript engine runs RegExp modifiers (`(?-i:…)`, ES2025) as the standard says: gitleaks rules
 * use them (generic-api-key's `(?-i:[Aa]pi|API)`), and `goRegex` keeps them. Bun and Node 24 do; Node 22 rejects
 * them, and with `--js-regexp-modifiers` lets one leak into the rest of its alternation (`/(?:(?-i:a)|b)/i` then
 * misses "B"), so generic-api-key missed `GITHUB_TOKEN=…`. A gate that would miss secrets must not build.
 */
function checkRegexModifiers(): void {
  let sound = false;
  try {
    sound = new RegExp("(?:(?-i:a)|b)", "i").test("B") && !new RegExp("(?-i:a)", "i").test("A");
  } catch {
    // A syntax error: no modifiers at all.
  }
  if (!sound) {
    throw new Error(
      "@eden/redact needs RegExp modifiers as ES2025 defines them (Bun; Node 24 or later): this engine lacks them or " +
        "runs them wrongly, and the gitleaks rules would miss secrets",
    );
  }
}

/** Eden's own regex rules' regexes, for `generate.ts` (their anchors are in the tables too). */
export const EDEN_REGEXES: RegExp[] = [
  ...PROVIDER_SHAPES.map(([, shape]) => shape),
  KEYWORD_RULE,
  URL_USERINFO,
  LEGACY_KEYWORD,
  LEGACY_TOKEN,
];

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
  const config = generated.gitleaks as GitleaksConfig;
  checkRegexModifiers();
  checkScanners(config.rules);
  const global = compileAllowlist(config.allowlist, choice.allowlist);
  const withRegex = config.rules.filter((rule): rule is GitleaksRule & { regex: string } => Boolean(rule.regex));
  return [
    ...withRegex.map((rule) => gitleaksRule(rule, global, choice.rule(rule.id), choice.allowlist)),
    // A shape without literals gets none: an empty prefilter means the rule always runs (safe, only slower).
    ...PROVIDER_SHAPES.map(([id, shape]) => regexRule(id, SHAPE_LITERALS[id] ?? [], shape)),
    regexRule("eden-keyword", SECRET_WORDS, KEYWORD_RULE),
    regexRule("eden-url-userinfo", ["://"], URL_USERINFO),
    plain("eden-presigned-url", SHAPE_LITERALS["eden-presigned-url"]!, presignedSpans),
    plain("eden-entropy-keyword", SECRET_WORDS, entropyWithKeyword),
    // Every anchor holds one of these literals ("[redacted]" folded, as the matcher folds case).
    plain("eden-aws-secret", ["akia", "asia", "[redacted]", "secret"], awsSecret),
    regexRule("eden-legacy-keyword", ["passw", "passphrase", "api"], LEGACY_KEYWORD),
    regexRule("eden-legacy-token", ["sk-", "ghp_", "gho_", "github_pat_", "akia"], LEGACY_TOKEN),
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
  /** Each rule that finds something in `text`, in rule order, with the spans it finds (for differential tests). */
  findings(text: string): { id: string; spans: Span[] }[];
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
  const words = [
    ...new Set([...rules.flatMap((rule) => [...rule.prefilter, ...(rule.anchorWords ?? [])]), ...TOKEN_LITERALS]),
  ];
  const index = new Map(words.map((word, i) => [word, i]));
  /** Per rule, its anchor words' ids; per word, whether some rule anchors on it (its occurrences are kept). */
  const anchorIds = rules.map((rule) => rule.anchorWords && Int32Array.from(rule.anchorWords, (w) => index.get(w)!));
  const anchorWord = new Uint8Array(words.length);
  for (const ids of anchorIds) if (ids) for (const id of ids) anchorWord[id] = 1;
  const found = new Occurrences(words.length, anchorWord);
  /** The token passes whose literals the last text scanned holds (`redactTokensIn`'s mask; the others are no-ops). */
  let tokens = 0;
  const rulesOf: number[][] = words.map(() => []);
  const always: number[] = [];
  rules.forEach((rule, r) => {
    // No words, or an empty word (which `includes` would always find): the rule always runs.
    if (rule.prefilter.length === 0 || rule.prefilter.some((word) => word.length === 0)) always.push(r);
    for (const word of new Set(rule.prefilter)) rulesOf[index.get(word)!]!.push(r);
  });
  const matcher = new MultiMatcher(words);

  // Scratch reused from text to text: the gate is synchronous and no rule calls back into it.
  const hits = new Uint8Array(words.length);
  const firsts = new Int32Array(words.length);
  const chosen = new Uint8Array(rules.length);
  /** Per word, the token passes it is a literal of (a bit each). */
  const tokenPasses = new Uint8Array(words.length);
  TOKEN_PASSES.forEach((pass, i) => {
    for (const word of pass.literals) {
      const id = index.get(word)!;
      tokenPasses[id] = tokenPasses[id]! | (1 << i);
    }
  });
  /** The rules whose prefilter words `text` holds, in rule order. */
  const candidates = (text: string): number[] => {
    found.clear(text.length);
    tokens = 0;
    const out = [...always];
    for (const r of always) chosen[r] = 1;
    const distinct = matcher.scan(text, hits, firsts, found.keep, found);
    for (let k = 0; k < distinct; k++) {
      const w = firsts[k]!;
      hits[w] = 0; // reset for the next text
      tokens |= tokenPasses[w]!;
      for (const r of rulesOf[w]!) {
        if (chosen[r] === 1) continue;
        chosen[r] = 1;
        out.push(r);
      }
    }
    for (const r of out) chosen[r] = 0;
    return out.length > 1 ? out.sort((a, b) => a - b) : out;
  };
  /** The rules whose prefilter words `text` holds, each with the spans it finds there. */
  const findings = (text: string): { id: string; spans: Span[] }[] =>
    candidates(text)
      .map((r) => ({ id: rules[r]!.id, spans: rules[r]!.spans(text, found, anchorIds[r]) }))
      .filter((f) => f.spans.length > 0);

  return {
    findings,
    secretHits: (text) =>
      findings(text)
        .map((found) => found.id)
        .sort(),
    sanitizeForStore(text) {
      const found = findings(text).flatMap((f) => f.spans);
      // A rule's span can cut a quoted credential value short, and hide the next key from the assignment pass below:
      // with any finding, that pass's spans on the original text join the rules' (audit A5). No finding, no extra scan.
      const spans = (found.length > 0 ? [...found, ...assignmentSpans(text)] : found).sort((a, b) => a[0] - b[0]);
      let out = "";
      let at = 0;
      for (const [start, end] of spans) {
        if (end <= at) continue;
        out += text.slice(at, Math.max(start, at)) + (start >= at ? REDACTED : "");
        at = end;
      }
      const gated = out + text.slice(at);
      // `redact(gated)`, as it was: `redactString`, its token passes and then its assignment pass. Every token literal
      // in `gated` was in `text` (the sentinel holds none and no literal spans its brackets), so a pass whose literals
      // `text` lacks would return its input unchanged and is left out (TOKEN_PASSES).
      return redactAssignments(redactTokensIn(gated, tokens));
    },
  };
}

let gate: Gate | undefined;
let warmed = false;

/**
 * Builds the rules, compiles every rule's pattern and allowlists and builds the gate, so the first `sanitizeForStore`
 * on live traffic does not pay for it (36-44 ms then, against 1.0-1.8 ms after it; packages/server/CLAUDE.md
 * has the runs). Idempotent: a second call returns at once. A server calls it before it listens; importing the
 * module stays cheap for everyone else.
 */
export function warmGate(): void {
  if (warmed) return;
  const rules = secretRules();
  for (const rule of rules) rule.warm?.();
  gate ??= gateOf(rules);
  // Runs the prefilter and the structural redactor once, with no keyword, so no rule regex runs.
  gate.sanitizeForStore("warm");
  warmed = true;
}

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
