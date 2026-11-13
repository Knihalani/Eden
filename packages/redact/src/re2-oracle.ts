/**
 * Test support, not part of the gate: the gate as D24 shipped it, on RE2 through re2js (a devDependency since
 * D1705). The differential checks (`differential.ts`) hold the gate's own matchers to it, span for span and group
 * for group; the benchmarks compare against it. Nothing in production imports this file, and index.ts does not
 * export it (own-matchers.test.ts checks both).
 */
import { RE2JS } from "re2js";
import { backtrackingEngine, LINEAR_RULES, type Engine, type EngineChoice } from "./secrets";

type Span = [number, number];

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
 * spans on ordinary text. Every `.` is rewritten, also under `(?s)`: the gate's own matchers keep that meaning.
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
 * RE2 through re2js: time linear in the text for every pattern (D24). A capture-free DFA `test` runs first, since
 * most candidate rules find nothing and the capturing search costs more.
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

/** D24's gate: RE2 for the seven rules that backtrack in JavaScript (`LINEAR_RULES`) and for every allowlist. */
export const D24_ENGINES: EngineChoice = {
  rule: (id) => (LINEAR_RULES.has(id) ? linearEngine : backtrackingEngine),
  allowlist: linearEngine,
};
