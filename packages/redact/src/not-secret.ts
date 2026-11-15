/**
 * D1850: values that cannot be a secret, which the keyword rules and the structural assignment pass leave in place.
 * The keyword rule (D13) takes the value after `password`, `token`, `secret`, `api_key`… whatever its entropy, so in
 * code it redacted `apiKey: string;`, `token = this.options.token` and `${API_KEY}`. Each shape below is code or a
 * placeholder: a reference to where a secret lives, a type, or a mask; none is how a secret is written.
 * `not-secret.test.ts` holds, for each, a real secret of the nearest shape that is still caught.
 *
 * Every shape is the whole value, anchored at both ends: the review of 2026-11-14 found the first version checking
 * only how a value started, so `${DB_PASSWORD:-S3cr3tP4ssw0rdXq9}`, `process.env.X||Hunt3rPass2Real9` and
 * `%PASS%Xk39dKf93kdKf8` were stored in clear. `never-less.ts` checks every value let through against a grammar
 * written apart from this one.
 *
 * What is not here, on purpose: a plain word (`password is sunshine` is a real, weak password), a short value, a low
 * entropy value, an ALL_CAPS name (random keys can be upper case), a number however written (`123_456_789` is a
 * password too), a call or a command (`$(…)`), a member chain on an arbitrary name (`dragon.fire`), a reference with
 * a default (`${X:-…}` holds the secret), and `changeme`-style defaults (often the real password).
 */

import { Last, Recent } from "./memo.ts";

/** TypeScript types as a value (`apiKey: string;`, `tokens: Set<number>`, `secret: number[]`). */
const TYPE =
  /^(?:string|number|boolean|bigint|undefined|null|unknown|never|void|object)(?:\[\])*$|^(?:Set|Map|WeakMap|WeakSet|Array|ReadonlyArray|Promise|Record|Partial|Readonly)<[A-Za-z$, |[\]]*(?:<[A-Za-z$, |[\]]*>[A-Za-z$, |[\]]*)*>$|^(?:Uint8|Int8|Uint16|Int16|Uint32|Int32|Float32|Float64|BigInt64|BigUint64|Uint8Clamped)Array$/;
/**
 * An environment variable read in code: `process.env.API_KEY`, `import.meta.env.VITE_KEY` (upper case, no digit), or
 * `env.API_KEY` (there also with an underscore inside, as environments name variables: `env.X` is any member).
 */
const ENV = /^(?:(?:process\.env|import\.meta\.env)\.[A-Z_]+|env\.[A-Z]+_[A-Z_]+)$/;
/**
 * A member chain on a well-known receiver, to the end of the value: where the secret is read from, not the secret
 * (`this.options.apiKey`, `res.usage.inputTokens`). At least two members after the receiver, each letters only: one
 * member after a broad receiver (`data.Hunter2isMyPassw0rd`, `self.Pa55w0rdIsHere`) can be a password.
 */
const MEMBER =
  /^(?:this|process|env|options|opts|config|cfg|settings|req|request|res|response|data|body|usage|ctx|context|args|params|props|state|self|window|globalThis)(?:\??\.[A-Za-z_$][A-Za-z_$]*){2,}$/;
/**
 * A reference as the whole value: `${API_KEY}` (no default: `${X:-…}`, `${X=…}`, `${X-…}` hold the value itself),
 * `$API_KEY` (with an underscore, as shells and dotenv write names; `$ALES2024` could be a password), `%API_KEY%`,
 * `{{secret}}`, and a placeholder in angle brackets (`<your-key>`). A name is letters and underscores in one case, no
 * digit: `${a8f5f167f44f4964}` or `<Xk39dKf93kdKf8>` is a key in braces.
 */
// The first letter picks the case, so no name has two readings (a regex with two would backtrack exponentially).
const NAME = String.raw`_?(?:[A-Z][A-Z_]*|[a-z][a-z_]*)`;
// In `${…}` also a camelCase name, as template literals interpolate variables (`Bearer ${apiKey}`): lower case,
// then capitals each followed by lower case, no digit.
const CAMEL = String.raw`[a-z]+(?:[A-Z][a-z]+)+`;
const REFERENCE = new RegExp(
  String.raw`^(?:\$\{(?:${NAME}|${CAMEL})\}|\$[A-Z]+_[A-Z_]+|%${NAME}%|\{\{${NAME}(?:\.${NAME})*\}\}|<(?:[a-z]+(?:[-_][a-z]+)*|[A-Z]+(?:[-_][A-Z]+)*)>)$`,
);
/** A mask: `xxxxxxxx`, `****`, `•••`, `####`, alone or after a short prefix of letters (`hf_xxxx…`, `pplx-XXXX…`). */
const MASK = /^(?:[A-Za-z]{1,8}[_~.-])?[xX*•#]{8,}$/;
/**
 * One character sixteen or more times to the end (then up to two `=`), alone or after a short prefix of letters
 * (`AIzaaaaaaaaaaaaaaaaa…`, `AKIAXXXXXXXXXXXXXXXX`, `glc_1111…=`): a placeholder. A random secret holds such a run
 * with probability under 62^-15 a position, and the run must fill the rest of the value, so a secret cannot hide
 * behind one; the prefix is letters, at most 8 (12 random characters before a run would be a secret). Read by hand:
 * as a regex (`(.)\1{15,}=*$`) a run of `=` backtracked quadratically.
 */
function isRun(v: string): boolean {
  let end = v.length;
  let pad = 0;
  while (pad < 2 && v[end - 1 - pad] === "=") pad++;
  if (pad > 0 && v[end - 1 - pad] !== "=") end -= pad;
  const c = v.charCodeAt(end - 1);
  let start = end - 1;
  while (start > 0 && v.charCodeAt(start - 1) === c) start--;
  return end - start >= 16 && RUN_PREFIX.test(v.slice(0, start));
}
const RUN_PREFIX = /^(?:[A-Za-z]{0,8}[_~.-]?)$/;
/** Longer values are never excused: no shape above is longer, and every test stays linear. */
const VALUE_LIMIT = 512;
/** The punctuation code puts after a value: `,;):]}`. */
const TRAILING = new Set([...",;):]}"].map((c) => c.charCodeAt(0)));

/** Strips one pair of quotes or backticks around `value`, and the punctuation code puts after one. */
function core(value: string): string {
  // By hand: `/[,;):\]}]+$/` re-read a long run of those characters from each of its positions (quadratic). A
  // closing bracket goes only while it closes nothing in the value (`${API_KEY}` keeps its brace, `${X})` loses `)`).
  let open = 0;
  let close = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 123 || c === 40 || c === 91) open++;
    else if (c === 125 || c === 41 || c === 93) close++;
  }
  let end = value.length;
  while (end > 0 && TRAILING.has(value.charCodeAt(end - 1))) {
    const c = value.charCodeAt(end - 1);
    if (c === 125 || c === 41 || c === 93) {
      if (close <= open) break;
      close--;
    }
    end--;
  }
  let v = value.slice(0, end);
  const first = v[0];
  if (v.length >= 2 && (first === '"' || first === "'" || first === "`") && v[v.length - 1] === first) {
    v = v.slice(1, -1);
  }
  return v;
}

/** Whether `value` (a keyword's or an assignment's value, as written) is code or a placeholder, never a secret. */
export function notSecret(value: string): boolean {
  if (value.length > VALUE_LIMIT * 2) return false;
  // The last few verdicts, within one call (memo.ts): the keyword rules, the assignment pass and the composer each ask
  // about the same values, and a text dense in assignments repeats one (`token:"token:"…`).
  return VERDICTS.has(value) ? VERDICTS.value : VERDICTS.set(value, judge(value));
}
const VERDICTS = new Recent<boolean>(8);

function judge(value: string): boolean {
  const v = core(value);
  // One token: a value with a space or a quote inside is prose or more than one value (`'process.env.X"API key: …'`).
  if (v.length === 0 || v.length > VALUE_LIMIT || /[\s"'`]/.test(v)) return false;
  return TYPE.test(v) || ENV.test(v) || MEMBER.test(v) || REFERENCE.test(v) || MASK.test(v) || isRun(v);
}

/** Whether a provider-shaped token is a placeholder (`MASK` or `RUN`): for the bare-shape rules. */
export function placeholderToken(token: string): boolean {
  if (token.length > VALUE_LIMIT * 2) return false;
  const v = core(token);
  if (v.length === 0 || v.length > VALUE_LIMIT || /[\s"'`]/.test(v)) return false;
  return MASK.test(v) || isRun(v);
}

const QUOTES = new Set([34, 39, 96, 0x201c, 0x2018]);
/** The most characters a value is read past its span. */
const VALUE_MAX = 256;
/** JavaScript's `\s` on one code unit. */
const isSpace = (c: number): boolean =>
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

/** The value a rule's span starts: the span itself when it opens with a quote, else the run of non-spaces from it. */
export function valueAt(text: string, start: number, end: number): string {
  if (QUOTES.has(text.charCodeAt(start))) return text.slice(start, end);
  // Read at most VALUE_MAX past the span: a run of non-spaces holds many spans on crafted text, and each read to its
  // end was quadratic. A value cut there ends in U+0000, which no anchored shape above matches.
  const limit = Math.min(text.length, Math.max(end, start) + VALUE_MAX);
  let stop = start;
  while (stop < limit && !isSpace(text.charCodeAt(stop))) stop++;
  const value = text.slice(start, Math.max(stop, end));
  return stop === limit && limit < text.length && !isSpace(text.charCodeAt(limit)) ? value + "\u0000" : value;
}

/**
 * `rule` with the spans whose value `excuse` calls code or a placeholder left out of `spans` (the rule's scan is
 * unchanged), and `split` giving both: the secret gate still gates the excused ones as main did (compose.ts).
 */
export function excused<R extends { spans(text: string, found?: never, ids?: never): [number, number][] }>(
  rule: R,
  excuse: (value: string) => boolean,
): R & {
  split(text: string, found?: unknown, ids?: unknown): { spans: [number, number][]; excused: [number, number][] };
} {
  // Fixed arguments, not a rest parameter and a bound function: the gate calls this for every text that holds a
  // keyword, and the spread cost more than the rule on a text with no finding (D1850).
  const spans = rule.spans as (text: string, found: unknown, ids: unknown) => [number, number][];
  // The last value's verdict, within one call (memo.ts): a text dense in findings repeats its value.
  const last = new Last<boolean>();
  const split = (text: string, found?: unknown, ids?: unknown) => {
    const kept: [number, number][] = [];
    const left: [number, number][] = [];
    const all = spans.call(rule, text, found, ids);
    if (all.length === 0) return { spans: all, excused: left };
    for (const span of all) {
      // Longer than any excused value (and too long to compare with the last one each time): kept.
      if (span[1] - span[0] > VALUE_LIMIT * 2) {
        kept.push(span);
        continue;
      }
      const value = valueAt(text, span[0], span[1]);
      const verdict = last.has(value) ? last.value! : last.set(value, excuse(value));
      (verdict ? left : kept).push(span);
    }
    return { spans: kept, excused: left };
  };
  return { ...rule, split, spans: (text: string, found?: unknown, ids?: unknown) => split(text, found, ids).spans };
}
