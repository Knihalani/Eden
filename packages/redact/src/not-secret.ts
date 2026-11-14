/**
 * D1850: values that cannot be a secret, which the keyword rules and the structural assignment pass leave in place.
 * The keyword rule (D13) takes the value after `password`, `token`, `secret`, `api_key`… whatever its entropy, so in
 * code it redacted `maxTokens: 2_000`, `apiKey: string;`, `token = this.options.token` and `${API_KEY}`: 93 of its
 * 222 findings on 13.6 MB of the repository's code, docs and the sim worlds' items, and the assignment pass the same
 * shapes. Each shape below is code or a placeholder: a reference to where a secret lives, a type, a number written
 * as code writes it, or a mask; none is how a secret is written. `not-secret.test.ts` holds, for each, a real secret
 * of the nearest shape that is still caught.
 *
 * What is not here, on purpose: a plain word (`password is sunshine` is a real, weak password), a short value, a low
 * entropy value, an ALL_CAPS name (random keys can be upper case), a decimal or a digit run (a PIN), a call
 * (`pass(word)`), a member chain on an arbitrary name (`dragon.fire`), and `changeme`-style defaults (often the real
 * password).
 */

/** TypeScript types as a value (`apiKey: string;`, `tokens: Set<number>`, `secret: number[]`). */
const TYPE =
  /^(?:string|number|boolean|bigint|undefined|null|unknown|never|void|object)(?:\[\])*$|^(?:Set|Map|WeakMap|WeakSet|Array|ReadonlyArray|Promise|Record|Partial|Readonly)<[\w$, |[\]]*(?:<[\w$, |[\]]*>[\w$, |[\]]*)*>$|^(?:Uint8|Int8|Uint16|Int16|Uint32|Int32|Float32|Float64|BigInt64|BigUint64|Uint8Clamped)Array$/;
/**
 * A member chain on a well-known receiver: where the secret is read from, not the secret (`this.options.apiKey`,
 * `process.env.TOKEN`, `res.usage.inputTokens`, `Math.ceil(…)`). The receivers are words no password starts with
 * followed by a dot and an identifier.
 */
const RECEIVER =
  /^(?:this|process|env|options|opts|config|cfg|settings|req|request|res|response|data|body|usage|ctx|context|args|params|props|state|self|os|window|globalThis|import\.meta|Math|JSON|Number|Object|Date)(?:\??\.[A-Za-z_$][\w$]*)+(?![\w$])/;
/**
 * An environment or template reference: `${API_KEY}`, `$(openssl …)`, `$API_KEY` (upper case with an underscore, as
 * shells and dotenv write names; `$ALES2024` could be a password), `%API_KEY%`, `{{ secret }}`, and a placeholder in
 * angle brackets that starts with a letter (`<your-key>`).
 */
const REFERENCE =
  /^(?:\$\{[A-Za-z_]|\$\(|\$[A-Z][A-Z0-9]*_[A-Z0-9_]+(?![\w$])|%[A-Z_][A-Z0-9_]*%|\{\{|<[A-Za-z][\w .:-]*>)/;
/** A number as code writes it, digits grouped by `_` (`2_000`, `3_600_000`): no password or PIN is written so. */
const GROUPED = /^\d{1,3}(?:_\d{3})+$/;
/** A mask: `xxxxxxxx`, `****`, `•••`, `####`, alone or after a short prefix (`hf_xxxx…`, `pplx-XXXX…`). */
const MASK = /^(?:[A-Za-z0-9]{1,12}[_~.-])?[xX*•#]{8,}$/;
/**
 * One character sixteen or more times to the end (then up to two `=`), alone or after a short prefix
 * (`AIzaaaaaaaaaaaaaaaaa…`, `AKIAXXXXXXXXXXXXXXXX`, `glc_1111…=`): a placeholder. A random secret holds such a run
 * with probability under 62^-15 a position, and the run must fill the rest of the value, so a secret cannot hide
 * behind one. Read by hand: as a regex (`(.)\1{15,}=*$`) a run of `=` backtracked quadratically.
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
const RUN_PREFIX = /^(?:[A-Za-z0-9]{0,12}[_~.-]?)$/;
/** Longer values are never excused: no shape above is longer, and every test stays linear. */
const VALUE_LIMIT = 512;
/** The punctuation code puts after a value: `,;):]}`. */
const TRAILING = new Set([...",;):]}"].map((c) => c.charCodeAt(0)));

/** Strips one pair of quotes or backticks around `value`, and the punctuation code puts after one. */
function core(value: string): string {
  // By hand: `/[,;):\]}]+$/` re-read a long run of those characters from each of its positions (quadratic).
  let end = value.length;
  while (end > 0 && TRAILING.has(value.charCodeAt(end - 1))) end--;
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
  const v = core(value);
  // One token: a value with a space or a quote inside is prose or more than one value (`'process.env.X"API key: …'`).
  if (v.length === 0 || v.length > VALUE_LIMIT || /[\s"'`]/.test(v)) return false;
  return TYPE.test(v) || RECEIVER.test(v) || REFERENCE.test(v) || GROUPED.test(v) || MASK.test(v) || isRun(v);
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
export function excused<R extends { spans(text: string, ...rest: never[]): [number, number][] }>(
  rule: R,
  excuse: (value: string) => boolean,
): R & { split(text: string, ...rest: unknown[]): { spans: [number, number][]; excused: [number, number][] } } {
  const spans = rule.spans.bind(rule) as (text: string, ...rest: unknown[]) => [number, number][];
  const split = (text: string, ...rest: unknown[]) => {
    const kept: [number, number][] = [];
    const left: [number, number][] = [];
    for (const span of spans(text, ...rest)) (excuse(valueAt(text, span[0], span[1])) ? left : kept).push(span);
    return { spans: kept, excused: left };
  };
  return { ...rule, split, spans: (text: string, ...rest: unknown[]) => split(text, ...rest).spans };
}
