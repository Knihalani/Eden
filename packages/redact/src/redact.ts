/**
 * Credential nouns, written down once.
 *
 * These used to be spelled out three times: a fast-path gate inside
 * redactString(), the replacing regex itself, and a third hand-copy in
 * containsSecret(). The copies drifted, in both directions and silently.
 *
 * The gate was case-sensitive (`[Bb]earer`, `[Pp]assword`, `\bsk-`) where the
 * replacer carried `i`, so it rejected the string before the replacer ever saw
 * it and `redactString` handed back "API_KEY=sk_live_…", "PASSWORD=…" and
 * "Authorization: BEARER …" verbatim — which emitTrace() then posted to the
 * collector. Uppercase is the *normal* spelling for these: they come from
 * environment dumps and config echoes.
 *
 * Collapsing the gate into the replacer fixed the case drift but left a second,
 * worse split: key-matching knew twenty credential families and value-matching
 * knew eight. `redact({secret: x})` redacted, `redactString("SECRET=x")` did
 * not — so AWS_SECRET_ACCESS_KEY, ACCESS_TOKEN, PASSWD and Set-Cookie all
 * survived in trace text. That is not only a leak: `containsRedaction` is the
 * gate that stops a compiler binding a credential into a program as a literal,
 * and it can only see credentials that were rewritten to the sentinel. A
 * credential redactString never touched passed the gate and got shipped to a
 * live API.
 *
 * So both matchers are now derived from this one list. Inline `key = value`
 * text is matched structurally and classified with the very same
 * `isSecretKey()` that object keys go through, which makes the two impossible
 * to drift apart again.
 */
import { notSecret } from "./not-secret.ts";
const SECRET_NOUNS = [
  "apikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "authorization",
  "credential",
  "credentials",
  "cookie",
  "setcookie",
  "jwt",
  "bearer",
  "session",
  "auth",
] as const;

/**
 * A key is a credential if, once punctuation and case are normalised away, it
 * *ends* with one of the nouns (optionally pluralised).
 *
 * Suffix rather than substring, because substring matching redacts "author"
 * for containing "auth" and "tokenizer" for containing "token" — and a
 * redactor that eats ordinary fields gets switched off. Suffix still catches
 * the compound spellings the anchored `^…$` version missed: user_password,
 * authToken, github_token, apiSecret, x_api_key, AWS_SECRET_ACCESS_KEY.
 */
const SECRET_KEY_SUFFIX = new RegExp(`(?:${SECRET_NOUNS.join("|")})s?[0-9]?$`, "i");

/**
 * Standalone credential shapes — things that are secret by their own syntax,
 * with no key next to them to give them away.
 */
const SECRET_TOKEN_PATTERNS = [
  String.raw`\bBearer\s+[A-Za-z0-9._\-+=/]+`,
  // Dashed sk- keys (sk-ant-api03-…, sk-proj-…) are SK_DASHED below.
  String.raw`\bsk-[A-Za-z0-9]{8,}`,
  String.raw`\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}`,
  // Tokens shorter than GitHub's 36 characters are still tokens; 8 is the
  // floor sk- already had. Memory's SECRET_INLINE (src/index.ts) is the ceiling.
  String.raw`\bghp_[A-Za-z0-9]{8,}`,
  String.raw`\bgho_[A-Za-z0-9]{8,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{8,}`,
  String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}`,
  // The per-install key a loopback `eden wrap` writes to config.json (packages/cli home.ts). No \b:
  // it is still a key after a word character, as in token%3Deden_local_… or x_eden_local_….
  String.raw`eden_local_[0-9a-f]{8,}`,
  String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
  // Private-key blocks are redacted by `redactPem`, a linear pass: the lazy `BEGIN[\s\S]*?END` alternative that
  // used to sit here rescanned to the end of the text from every BEGIN with no END after it (quadratic: 25 s at
  // 1 MB; docs/research/architecture-alternatives.md).
] as const;

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/gi;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/gi;
const PEM_ANY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

/**
 * Redacts private-key blocks, banner to END line (matching only the banner left the base64 body in the clear under a
 * "[REDACTED]" hat); a banner with no END after it is redacted alone. Same result as the old lazy regex, in one pass:
 * each END search starts where the previous block ended, and once no END is left, later banners are not searched for
 * one again.
 */
export function redactPem(s: string): string {
  if (s.indexOf("-----") < 0) return s;
  PEM_BEGIN.lastIndex = 0;
  let out = "";
  let cursor = 0;
  let endsLeft = true;
  for (let m = PEM_BEGIN.exec(s); m !== null; m = PEM_BEGIN.exec(s)) {
    let stop = m.index + m[0].length;
    if (endsLeft) {
      PEM_END.lastIndex = stop;
      const e = PEM_END.exec(s);
      if (e === null) endsLeft = false;
      else stop = e.index + e[0].length;
    }
    out += s.slice(cursor, m.index) + REDACTED;
    cursor = stop;
    PEM_BEGIN.lastIndex = stop;
  }
  return cursor === 0 ? s : out + s.slice(cursor);
}

/** Global, for replacing every occurrence. */
const SECRET_INLINE = new RegExp(SECRET_TOKEN_PATTERNS.join("|"), "gi");
/** Non-global, so `.test()` carries no lastIndex between calls. */
const SECRET_ANY = new RegExp(SECRET_TOKEN_PATTERNS.join("|"), "i");

/**
 * sk- keys with dashes: sk-ant-api03-…, sk-proj-…. The alphanumeric sk- shape
 * above stops at the first dash, so every one of these went through.
 *
 * A dashed body is a key only if it holds a digit. "sk-fix-login" and
 * "sk-canvas-node" are words, and shadow compares tool args after redact(), so
 * redacting them made two different branch pushes compare equal.
 *
 * This is a pass of its own, not one more alternative in SECRET_INLINE. Inside
 * one regex, "holds a digit" needs a lookahead: without a lookbehind it goes
 * quadratic on "sk-sk-sk-…", and with one the whole alternation ran about ten
 * times slower on ordinary logs. Here each match takes its whole run of key
 * characters once, and the digit test runs on the match.
 */
const SK_DASHED = /\bsk-[A-Za-z0-9_-]{8,}/gi;
const DIGIT = /[0-9]/;

function redactDashedSk(s: string): string {
  SK_DASHED.lastIndex = 0;
  return s.replace(SK_DASHED, (m) => (DIGIT.test(m) ? REDACTED : m));
}

function hasDashedSk(s: string): boolean {
  for (const m of s.matchAll(SK_DASHED)) if (DIGIT.test(m[0])) return true;
  return false;
}

/**
 * HTTP Basic credentials: "Basic " and base64 of user:password. A pass of its own, like dashed sk- keys: the token is
 * a credential only if it decodes to printable text holding a ":", which prose after the word ("Basic Input/Output
 * System") never does.
 */
const BASIC_AUTH = /\bBasic\s+([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/gi;

function isBasicCredential(b64: string): boolean {
  if (b64.length % 4 === 1) return false;
  // UTF-8, so a user or password with accents still counts; control characters or invalid bytes mean it is not text.
  const decoded = Buffer.from(b64, "base64").toString("utf8");
  return decoded.includes(":") && !/[\u0000-\u001f\u007f\ufffd]/.test(decoded);
}

function redactBasic(s: string): string {
  BASIC_AUTH.lastIndex = 0;
  return s.replace(BASIC_AUTH, (m, b64: string) => (isBasicCredential(b64) ? REDACTED : m));
}

function hasBasic(s: string): boolean {
  for (const m of s.matchAll(BASIC_AUTH)) if (isBasicCredential(m[1]!)) return true;
  return false;
}

/** Longest key we will look back over from a separator. */
const MAX_KEY_LEN = 128;

function isKeyChar(c: number): boolean {
  return (
    (c >= 97 && c <= 122) || // a-z
    (c >= 65 && c <= 90) || // A-Z
    (c >= 48 && c <= 57) || // 0-9
    c === 95 || // _
    c === 46 || // .
    c === 45 // -
  );
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
}

/** Where a value ends: whitespace, or a separator that starts a *different* field. */
function endsValue(c: number): boolean {
  return isSpace(c) || c === 38 /* & */ || c === 59; /* ; */
}

/** Sentinel substituted for anything that looked like a credential. */
export const REDACTED = "[REDACTED]";
/** Sentinel substituted for a back-edge to an ancestor (a genuine cycle). */
export const CYCLE = "[CYCLE]";
/** Sentinel for a subtree the walker refused to keep expanding. */
export const TRUNCATED = "[TRUNCATED]";
/** Sentinel for a property whose getter threw. */
export const UNREADABLE = "[UNREADABLE]";

/**
 * Bounds on the walk.
 *
 * `stack` tracks only the current path, so a value shared between sibling
 * branches is re-walked rather than cut — which is correct (see redact()) but
 * means a deduplicated graph expands to its tree size. A 30-node diamond DAG
 * expands to 2^30 nodes; at depth 24 that already took 23 seconds of blocked
 * event loop, on the agent's hot path. The node budget keeps the correct
 * semantics for real payloads and bounds the pathological ones. The depth cap
 * separately keeps deep-but-thin structures from exhausting the JS stack,
 * which threw RangeError out of a *successful* tool call.
 */
const MAX_NODES = 50_000;
const MAX_DEPTH = 200;

/**
 * Memo for isSecretKey.
 *
 * redact() walks every key of every argument and result of every trace event,
 * and the key set of a given agent is tiny and endlessly repeated — "name",
 * "args", "command", "stdout", "ok". Normalising and matching each one afresh
 * showed up as the single largest cost on the hot path.
 */
const secretKeyMemo = new Map<string, boolean>();
const SECRET_KEY_MEMO_MAX = 4096;

export function isSecretKey(key: string): boolean {
  const memo = secretKeyMemo.get(key);
  if (memo !== undefined) return memo;
  const verdict = SECRET_KEY_SUFFIX.test(key.replace(/[^A-Za-z0-9]/g, ""));
  // Keys come from tool payloads, so the space is attacker-influenced and the
  // memo has to be bounded. Clearing wholesale keeps it O(1) and the steady
  // state of a real agent never reaches the cap.
  if (secretKeyMemo.size >= SECRET_KEY_MEMO_MAX) secretKeyMemo.clear();
  secretKeyMemo.set(key, verdict);
  return verdict;
}

/** Each noun's characters, last first (`secretKeyAt` reads a key from its end), by the noun's last character. */
const NOUNS_BY_LAST: Int32Array[][] = Array.from({ length: 128 }, () => []);
for (const noun of SECRET_NOUNS) {
  NOUNS_BY_LAST[noun.charCodeAt(noun.length - 1)]!.push(Int32Array.from([...noun].reverse(), (c) => c.charCodeAt(0)));
}
/** The longest key tail a noun can need: the longest noun, an `s` and a digit. */
const KEY_TAIL = Math.max(...SECRET_NOUNS.map((noun) => noun.length)) + 2;
/** The last KEY_TAIL alphanumerics of a key, lower case, last first (scratch for `secretKeyAt`). */
const tail = new Int32Array(KEY_TAIL);

/**
 * `isSecretKey(s.slice(start, end))` for a key of key characters (`[A-Za-z0-9_.-]`, as `scanAssignments` reads them),
 * without making the string: the same test on the key's last alphanumerics. SECRET_KEY_SUFFIX holds when, with the
 * other characters removed, the key ends in a noun, then an optional `s`, then an optional digit; letters compare
 * ASCII case-insensitively, as the regex's `i` flag does on ASCII.
 */
function secretKeyAt(s: string, start: number, end: number): boolean {
  let n = 0;
  for (let at = end - 1; at >= start && n < KEY_TAIL; at--) {
    const c = s.charCodeAt(at);
    if (c >= 65 && c <= 90) tail[n++] = c | 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) tail[n++] = c;
  }
  // A trailing digit can only be the optional digit; then the noun ends at the `s` or just before it.
  const from = n > 0 && tail[0]! >= 48 && tail[0]! <= 57 ? 1 : 0;
  if (endsWithNoun(n, from)) return true;
  return from < n && tail[from] === 115 /* s */ && endsWithNoun(n, from + 1);
}

/** Whether `tail` from `from` (read backwards from the key's end) starts with a reversed noun. */
function endsWithNoun(n: number, from: number): boolean {
  if (from >= n) return false;
  for (const noun of NOUNS_BY_LAST[tail[from]!]!) {
    if (noun.length > n - from) continue;
    let k = 0;
    while (k < noun.length && tail[from + k] === noun[k]) k++;
    if (k === noun.length) return true;
  }
  return false;
}

/**
 * Rewrite the value of every `key = value` / `key: value` whose key names a
 * credential.
 *
 * Hand-rolled rather than a regex on purpose. The obvious pattern —
 * `([A-Za-z0-9_.\-]{1,128})(\s*[=:]\s*)(\S+)` — is quadratic: on a long run of
 * key characters with no separator it tries all 128 lengths at every offset,
 * measured at 502ms for 1MB. Anchoring on the separator instead and walking
 * back over the key visits each character a constant number of times.
 *
 * The `indexOf` gate below is a structural precondition of the scan, not a
 * hand-copied list of credential shapes: an assignment without `=` or `:` is
 * not an assignment. That is what makes it safe where the old case-sensitive
 * fast-path gate was not — there is nothing here that can drift out of step
 * with the nouns.
 */
function scanAssignments(
  s: string,
  onSecret: null | ((keyEnd: number, valueStart: number, valueEnd: number) => void),
  excuse: boolean,
): boolean {
  // The next `=` and `:` at or after the cursor, by indexOf (native), rather than a test of every character.
  let eq = s.indexOf("=");
  let colon = s.indexOf(":");
  if (eq < 0 && colon < 0) return false;
  let found = false;
  for (let i = 0; i < s.length; i++) {
    if (eq >= 0 && eq < i) eq = s.indexOf("=", i);
    if (colon >= 0 && colon < i) colon = s.indexOf(":", i);
    if (eq < 0 && colon < 0) break;
    i = eq < 0 ? colon : colon < 0 ? eq : Math.min(eq, colon);

    // Key: walk back over key characters, stepping over one optional quote so
    // that serialised JSON ("token":"…") is covered too.
    let keyEnd = i;
    if (keyEnd > 0) {
      const q = s.charCodeAt(keyEnd - 1);
      if (q === 34 || q === 39) keyEnd--;
    }
    let keyStart = keyEnd;
    const floor = Math.max(0, keyEnd - MAX_KEY_LEN);
    while (keyStart > floor && isKeyChar(s.charCodeAt(keyStart - 1))) keyStart--;
    if (keyStart === keyEnd) continue;

    // Value: whitespace, then a run that stops at the next field. A quoted
    // value runs to its closing quote — commas inside it belong to the value
    // ("password":"a,b","n":1 must keep n) and an escaped quote (`\"`) does
    // not close it, or the tail of the secret survives in the clear.
    let valueStart = i + 1;
    while (valueStart < s.length && isSpace(s.charCodeAt(valueStart))) valueStart++;
    let valueEnd = valueStart;
    const vq = s.charCodeAt(valueStart);
    if (vq === 34 || vq === 39) {
      valueEnd++;
      while (valueEnd < s.length) {
        const c = s.charCodeAt(valueEnd);
        if (c === 92 /* \ */) {
          valueEnd += 2;
          continue;
        }
        valueEnd++;
        if (c === vq) break;
      }
    } else {
      while (valueEnd < s.length && !endsValue(s.charCodeAt(valueEnd))) valueEnd++;
    }
    if (valueEnd === valueStart) continue;

    i = valueEnd - 1;
    if (!secretKeyAt(s, keyStart, keyEnd)) continue;
    // Code or a placeholder as the value (`maxTokens: 2_000`, `apiKey: string`) is no credential (D1850), where
    // the caller excuses them: the secret gate runs this pass as main did and takes them back itself (compose.ts).
    if (excuse && notSecret(s.slice(valueStart, valueEnd))) continue;
    found = true;
    if (!onSecret) return true;
    onSecret(keyEnd, valueStart, valueEnd);
  }
  return found;
}

/**
 * Where `redactString`'s assignment pass would put a sentinel in `s`: each credential key's whole value, quotes
 * included. The gate (`sanitizeForStore`) adds these to its rules' spans when a rule fires, since a rule's span can
 * start inside a quoted value (D13's keyword rule takes `"correct` of `"correct horse battery staple"`), and the
 * pass run afterwards on the gated text then sees a bare sentinel where the quoted value began and stops there
 * (audit A5: the rest of the passphrase was stored).
 */
export function assignmentSpans(s: string): [number, number][] {
  const spans: [number, number][] = [];
  scanAssignments(s, (_keyEnd, valueStart, valueEnd) => spans.push([valueStart, valueEnd]), false);
  return spans;
}

/** `assignmentSpans`, and the ones whose value is not code or a placeholder (D1850, compose.ts). */
export function assignmentSpansSplit(s: string): { all: [number, number][]; strict: [number, number][] } {
  const all: [number, number][] = [];
  const strict: [number, number][] = [];
  scanAssignments(
    s,
    (_keyEnd, valueStart, valueEnd) => {
      all.push([valueStart, valueEnd]);
      if (!notSecret(s.slice(valueStart, valueEnd))) strict.push([valueStart, valueEnd]);
    },
    false,
  );
  return { all, strict };
}

export function redactString(s: string): string {
  // No separate pre-filter for the token patterns: `replace` already returns
  // `s` untouched when nothing matches, so a gate would only scan the string a
  // second time — and a hand-written gate is exactly what drifted out of step
  // with the replacer. (The secret gate has a scan of its own anyway, and skips
  // the token passes on its strength: `redactTokensIn`, TOKEN_PASSES.)
  return redactAssignments(redactTokensIn(s, ALL_TOKEN_PASSES));
}

/**
 * The token passes of `redactString` in order (PEM blocks, dashed sk- keys, Basic credentials, the inline token
 * shapes), each with its regexes and lower-case literals one of which every match of the pass holds. Each regex
 * matches ASCII letters in either case and nothing else for them, so a text that holds none of a pass's literals, in
 * any case, comes out of that pass unchanged; and a pass only puts in `[REDACTED]`, which holds no literal of a later
 * pass, nor makes one across its brackets. `gate-differential.test.ts` checks every regex against its literals.
 */
export const TOKEN_PASSES: readonly { regexes: readonly RegExp[]; literals: readonly string[] }[] = [
  { regexes: [PEM_BEGIN], literals: ["-----begin "] },
  { regexes: [SK_DASHED], literals: ["sk-"] },
  { regexes: [BASIC_AUTH], literals: ["basic"] },
  {
    regexes: SECRET_TOKEN_PATTERNS.map((source) => new RegExp(source, "gi")),
    literals: [
      "bearer",
      "sk-",
      "k_live_",
      "k_test_",
      "ghp_",
      "gho_",
      "github_pat_",
      "xox",
      "eden_local_",
      "akia",
      "asia",
    ],
  },
];
/** Every pass's literals. */
export const TOKEN_LITERALS = [...new Set(TOKEN_PASSES.flatMap((pass) => pass.literals))];
/** `redactTokensIn`'s mask with every pass: bit i runs TOKEN_PASSES[i]. */
export const ALL_TOKEN_PASSES = (1 << TOKEN_PASSES.length) - 1;

/**
 * The token passes of `redactString` whose bit is set in `passes` (TOKEN_PASSES' order). The secret gate leaves out
 * the passes none of whose literals its text holds: they would return their input unchanged.
 */
export function redactTokensIn(s: string, passes: number): string {
  let t = s;
  if ((passes & 1) !== 0) t = redactPem(t);
  if ((passes & 2) !== 0) t = redactDashedSk(t);
  if ((passes & 4) !== 0) t = redactBasic(t);
  if ((passes & 8) !== 0) {
    SECRET_INLINE.lastIndex = 0;
    t = t.replace(SECRET_INLINE, REDACTED);
  }
  return t;
}

/**
 * The assignment pass of `redactString`: `redactString(s)` is `redactAssignments(redactTokensIn(s, ALL_TOKEN_PASSES))`.
 * `excuse`: leave values that are code or placeholders (D1850). Off by default, so `redactString`, `redact` and
 * `containsSecret` redact what main did; the secret gate runs it off too, learns through `seen` whether it took one,
 * and takes such values back itself (compose.ts), where never-less checks them.
 */
export function redactAssignments(t: string, excuse = false, seen?: { excusable: boolean }): string {
  let out = "";
  let cursor = 0;
  scanAssignments(
    t,
    (_keyEnd, valueStart, valueEnd) => {
      // Already reduced to the sentinel by the token pass; leave it alone rather
      // than nesting sentinels.
      if (valueEnd - valueStart === REDACTED.length && t.startsWith(REDACTED, valueStart)) return;
      if (seen && !seen.excusable && notSecret(t.slice(valueStart, valueEnd))) seen.excusable = true;
      out += t.slice(cursor, valueStart) + REDACTED;
      cursor = valueEnd;
    },
    excuse,
  );
  return cursor === 0 ? t : out + t.slice(cursor);
}

/** True if `s` looks like it carries a credential. */
function stringHasSecret(s: string): boolean {
  // Shortest token pattern is `Bearer a` (8). Assignment scan needs `=` or `:`.
  // Plain short strings (synth ids, tags) cannot match either.
  if (s.length < 8 && s.indexOf("=") < 0 && s.indexOf(":") < 0) return false;
  return SECRET_ANY.test(s) || PEM_ANY.test(s) || hasDashedSk(s) || hasBasic(s) || scanAssignments(s, null, false);
}

/**
 * How a non-plain object should be represented, or null if it should be walked
 * as an ordinary object.
 *
 * `Object.entries` returns nothing for a Map, a Set, a Date or an Error, so all
 * of them used to redact to `{}` — the trace recorded an empty object where the
 * tool had returned an error message or a credential-bearing map, and
 * `containsRedaction` saw nothing to refuse. Typed arrays had the opposite
 * problem: `Object.entries(new Uint8Array(n))` yields one entry per byte, so a
 * binary result became an n-key object. 200 KB measured at 627 ms and a
 * multi-megabyte trace body.
 */
function exotic(value: object): { done: true; as: unknown } | { done: false } {
  // Almost everything on the hot path is a plain object or an array straight
  // out of JSON.parse. One prototype comparison skips the whole ladder.
  if (isPlain(value)) return { done: false };
  if (ArrayBuffer.isView(value)) {
    const kind = (value.constructor as { name?: string } | undefined)?.name ?? "TypedArray";
    return { done: true, as: `[${kind}:${(value as { length?: number }).length ?? value.byteLength}]` };
  }
  if (value instanceof ArrayBuffer) return { done: true, as: `[ArrayBuffer:${value.byteLength}]` };
  if (value instanceof Date) {
    const t = value.getTime();
    return { done: true, as: Number.isNaN(t) ? "[Invalid Date]" : value.toISOString() };
  }
  if (value instanceof RegExp) return { done: true, as: String(value) };
  return { done: false };
}

type Walk = { nodes: number; path: WeakSet<object> };

/** A plain object or array: nothing exotic to special-case, walk it directly. */
function isPlain(value: object): boolean {
  const p = Object.getPrototypeOf(value) as unknown;
  return p === Object.prototype || p === null || p === Array.prototype;
}

function readProp(o: object, k: string): unknown {
  try {
    return (o as Record<string, unknown>)[k];
  } catch {
    // An accessor that throws must not take the tool call down with it:
    // emitTrace runs inside the success path, so a throw here was rethrown as
    // a failure and the real result was discarded.
    return UNREADABLE;
  }
}

function ownKeys(o: object): string[] {
  try {
    return Object.keys(o);
  } catch {
    return [];
  }
}

/**
 * Assign without triggering the inherited `__proto__` setter.
 *
 * `out[k] = …` runs that setter rather than adding a key, so a payload with a
 * literal "__proto__" — ordinary in JSON from a tool or the collector — lost
 * that key *and* had the payload installed as the result's prototype.
 * defineProperty always defines, but it is several times slower than
 * assignment and this runs for every key of every trace event, so only the one
 * key that needs it pays.
 */
export function setKey(out: Record<string, unknown>, k: string, v: unknown): void {
  if (k === "__proto__") {
    Object.defineProperty(out, k, { value: v, writable: true, enumerable: true, configurable: true });
  } else {
    out[k] = v;
  }
}

// `stack` tracks only the current traversal path. A back-edge to an ancestor is
// a real cycle and is cut; a value shared between sibling branches is not, and
// must still be redacted in full. Marking every visited object would replace
// legitimate repeated data with the "[CYCLE]" sentinel — silent corruption
// that then gets baked into compiled programs as a literal.
export function redact(value: unknown, stack?: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return `[Function:${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return String(value);
  if (value == null || typeof value !== "object") return value;
  // Hot path: a plain {flag: true} / {n: 1} snapshot without walking a WeakSet.
  // Anything with a string, nested object, or secret key falls through.
  if (!stack && isPlain(value) && !Array.isArray(value)) {
    const fast = redactPlainPrimitives(value);
    if (fast) return fast;
  }
  return walk(value, { nodes: 0, path: stack ?? new WeakSet<object>() }, 0);
}

const EMPTY_SNAPSHOT: Record<string, unknown> = Object.freeze({});

function redactPlainPrimitives(value: object): Record<string, unknown> | null {
  const keys = ownKeys(value);
  if (keys.length === 0) return EMPTY_SNAPSHOT;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (isSecretKey(k)) return null;
    const v = readProp(value, k);
    if (typeof v === "string" || typeof v === "bigint" || typeof v === "function" || typeof v === "symbol") return null;
    if (v != null && typeof v === "object") return null;
    setKey(out, k, v);
  }
  return out;
}

function walk(value: unknown, w: Walk, depth: number): unknown {
  if (typeof value === "string") return redactString(value);
  // JSON.stringify throws outright on a bigint, and sendPost's bare catch
  // swallowed it — the trace never posted and burned all five retries with no
  // diagnostic. Any tool touching 64-bit database ids hit this.
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return `[Function:${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return String(value);
  if (value == null || typeof value !== "object") return value;

  if (depth >= MAX_DEPTH || w.nodes >= MAX_NODES) return TRUNCATED;
  w.nodes++;

  const plain = isPlain(value);
  if (!plain) {
    const special = exotic(value);
    if (special.done) return special.as;
  }

  if (w.path.has(value)) return CYCLE;
  w.path.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => walk(v, w, depth + 1));
    if (plain) {
      const out: Record<string, unknown> = {};
      for (const k of ownKeys(value)) {
        setKey(out, k, isSecretKey(k) ? REDACTED : walk(readProp(value, k), w, depth + 1));
      }
      return out;
    }
    if (value instanceof Map) {
      return {
        "[Map]": [...value.entries()].map(([k, v]) => [
          walk(k, w, depth + 1),
          typeof k === "string" && isSecretKey(k) ? REDACTED : walk(v, w, depth + 1),
        ]),
      };
    }
    if (value instanceof Set) return { "[Set]": [...value.values()].map((v) => walk(v, w, depth + 1)) };
    if (value instanceof Error) {
      // `message`, `name` and `stack` are non-enumerable, so the generic walk
      // reported every thrown error as `{}`.
      const out: Record<string, unknown> = {
        name: String(value.name),
        message: redactString(String(value.message)),
      };
      for (const k of ownKeys(value)) {
        if (k in out) continue;
        setKey(out, k, isSecretKey(k) ? REDACTED : walk(readProp(value, k), w, depth + 1));
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const k of ownKeys(value)) {
      setKey(out, k, isSecretKey(k) ? REDACTED : walk(readProp(value, k), w, depth + 1));
    }
    return out;
  } finally {
    w.path.delete(value);
  }
}

/**
 * True if `value` contains the redaction sentinel at any depth.
 *
 * A slot whose witnessed values all agree looks bindable as a literal, but if
 * that agreed-upon value is (or contains) a redacted credential, baking it in
 * would compile a program that ships the string "[REDACTED]" to a live API.
 * Such a slot has to be refused, not bound.
 *
 * TRUNCATED and UNREADABLE count too: they mark a subtree the redactor could
 * not fully inspect, and "we did not look" is not the same as "there was
 * nothing there". Refusing to bind is the safe side of that uncertainty.
 */
export function containsRedaction(value: unknown, stack?: WeakSet<object>): boolean {
  return scan(
    value,
    { nodes: 0, path: stack ?? new WeakSet<object>() },
    0,
    (s) => s.includes(REDACTED) || s.includes(TRUNCATED) || s.includes(UNREADABLE),
  );
}

export function containsSecret(value: unknown, seen?: WeakSet<object>): boolean {
  return scan(value, { nodes: 0, path: seen ?? new WeakSet<object>() }, 0, stringHasSecret, true);
}

function scan(value: unknown, w: Walk, depth: number, hit: (s: string) => boolean, bySecretKey = false): boolean {
  if (typeof value === "string") return hit(value);
  if (value == null || typeof value !== "object") return false;
  // Out of budget means "not fully inspected". containsRedaction treats that as
  // a hit via its own sentinel test; containsSecret is a best-effort reporter
  // and stops.
  if (depth >= MAX_DEPTH || w.nodes >= MAX_NODES) return !bySecretKey;
  w.nodes++;
  if (exotic(value).done) return false;
  if (w.path.has(value)) return false;
  w.path.add(value);
  try {
    if (Array.isArray(value)) return value.some((v) => scan(v, w, depth + 1, hit, bySecretKey));
    if (value instanceof Map) {
      for (const [k, v] of value.entries()) {
        if (bySecretKey && typeof k === "string" && isSecretKey(k)) return true;
        if (scan(k, w, depth + 1, hit, bySecretKey)) return true;
        if (scan(v, w, depth + 1, hit, bySecretKey)) return true;
      }
      return false;
    }
    if (value instanceof Set) {
      for (const v of value.values()) if (scan(v, w, depth + 1, hit, bySecretKey)) return true;
      return false;
    }
    if (value instanceof Error) {
      if (hit(String(value.message)) || hit(String(value.name))) return true;
    }
    for (const k of ownKeys(value)) {
      if (bySecretKey && isSecretKey(k)) return true;
      if (scan(readProp(value, k), w, depth + 1, hit, bySecretKey)) return true;
    }
    return false;
  } finally {
    w.path.delete(value);
  }
}

/**
 * D1850: which characters of `s` the structural pass (`redactAssignments(redactTokensIn(s, passes))`) takes out, as a
 * mask over `s` (1: removed). The passes run as they do there, each on the last one's output, with each character
 * of that output traced back to `s` (a sentinel's characters to none). `strict`: an assignment value that is code or
 * a placeholder (not-secret.ts) is not counted as removed, and its text goes to `values` when given. The secret
 * gate uses it to add its D1850 rules' spans to what the passes removed without letting them change what the passes
 * see (`sanitizeForStore`).
 */
export function structuralMask(s: string, passes: number, strict = false, values?: string[]): Uint8Array {
  const removed = new Uint8Array(s.length);
  let cur = s;
  /** Per character of `cur`, its index in `s`, or -1 inside a sentinel. */
  let map = new Int32Array(s.length);
  for (let i = 0; i < map.length; i++) map[i] = i;
  /** Replaces `ranges` of `cur` (increasing, apart) by the sentinel, marking what they held as removed. */
  const replace = (ranges: [number, number][]) => {
    if (ranges.length === 0) return;
    let out = "";
    const next = new Int32Array(cur.length + ranges.length * REDACTED.length);
    let n = 0;
    let at = 0;
    for (const [start, end] of ranges) {
      out += cur.slice(at, start) + REDACTED;
      for (let i = at; i < start; i++) next[n++] = map[i]!;
      for (let i = start; i < end; i++) if (map[i]! >= 0) removed[map[i]!] = 1;
      for (let i = 0; i < REDACTED.length; i++) next[n++] = -1;
      at = end;
    }
    out += cur.slice(at);
    for (let i = at; i < cur.length; i++) next[n++] = map[i]!;
    cur = out;
    map = next.subarray(0, n);
  };
  const matches = (regex: RegExp, keep: (m: RegExpExecArray) => boolean): [number, number][] => {
    const out: [number, number][] = [];
    regex.lastIndex = 0;
    for (const m of cur.matchAll(regex)) if (keep(m)) out.push([m.index, m.index + m[0].length]);
    return out;
  };
  if ((passes & 1) !== 0 && cur.indexOf("-----") >= 0) {
    // redactPem's walk: each banner to the END line after it, or alone once no END is left.
    const ranges: [number, number][] = [];
    PEM_BEGIN.lastIndex = 0;
    let endsLeft = true;
    for (let m = PEM_BEGIN.exec(cur); m !== null; m = PEM_BEGIN.exec(cur)) {
      let stop = m.index + m[0].length;
      if (endsLeft) {
        PEM_END.lastIndex = stop;
        const e = PEM_END.exec(cur);
        if (e === null) endsLeft = false;
        else stop = e.index + e[0].length;
      }
      ranges.push([m.index, stop]);
      PEM_BEGIN.lastIndex = stop;
    }
    replace(ranges);
  }
  if ((passes & 2) !== 0) replace(matches(SK_DASHED, (m) => DIGIT.test(m[0])));
  if ((passes & 4) !== 0) replace(matches(BASIC_AUTH, (m) => isBasicCredential(m[1]!)));
  if ((passes & 8) !== 0) replace(matches(SECRET_INLINE, () => true));
  // The assignment pass, last: only what it removes is wanted, not its output.
  scanAssignments(
    cur,
    (_keyEnd, valueStart, valueEnd) => {
      if (valueEnd - valueStart === REDACTED.length && cur.startsWith(REDACTED, valueStart)) return;
      if (strict && notSecret(cur.slice(valueStart, valueEnd))) {
        values?.push(cur.slice(valueStart, valueEnd));
        return;
      }
      for (let i = valueStart; i < valueEnd; i++) if (map[i]! >= 0) removed[map[i]!] = 1;
    },
    false,
  );
  return removed;
}
