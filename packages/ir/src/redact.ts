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
const SECRET_KEY_SUFFIX = new RegExp(`(?:${SECRET_NOUNS.join("|")})s?$`, "i");

/**
 * Standalone credential shapes — things that are secret by their own syntax,
 * with no key next to them to give them away.
 */
const SECRET_TOKEN_PATTERNS = [
  String.raw`\bBearer\s+[A-Za-z0-9._\-+=/]+`,
  String.raw`\bsk-[A-Za-z0-9]{8,}`,
  String.raw`\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}`,
  String.raw`\bghp_[A-Za-z0-9]{20,}`,
  String.raw`\bgho_[A-Za-z0-9]{20,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
  String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}`,
  String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
] as const;

/** Global, for replacing every occurrence. */
const SECRET_INLINE = new RegExp(SECRET_TOKEN_PATTERNS.join("|"), "gi");
/** Non-global, so `.test()` carries no lastIndex between calls. */
const SECRET_ANY = new RegExp(SECRET_TOKEN_PATTERNS.join("|"), "i");

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
  return isSpace(c) || c === 38 /* & */ || c === 59 /* ; */;
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
function scanAssignments(s: string, onSecret: null | ((keyEnd: number, valueStart: number, valueEnd: number) => void)): boolean {
  if (s.indexOf("=") < 0 && s.indexOf(":") < 0) return false;
  let found = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 61 /* = */ && c !== 58 /* : */) continue;

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

    // Value: whitespace, then a run that stops at the next field.
    let valueStart = i + 1;
    while (valueStart < s.length && isSpace(s.charCodeAt(valueStart))) valueStart++;
    let valueEnd = valueStart;
    while (valueEnd < s.length && !endsValue(s.charCodeAt(valueEnd))) valueEnd++;
    if (valueEnd === valueStart) continue;

    i = valueEnd - 1;
    if (!isSecretKey(s.slice(keyStart, keyEnd))) continue;
    found = true;
    if (!onSecret) return true;
    onSecret(keyEnd, valueStart, valueEnd);
  }
  return found;
}

export function redactString(s: string): string {
  // No separate pre-filter for the token patterns: `replace` already returns
  // `s` untouched when nothing matches, so a gate would only scan the string a
  // second time — and a hand-written gate is exactly what drifted out of step
  // with the replacer.
  SECRET_INLINE.lastIndex = 0;
  const t = s.replace(SECRET_INLINE, REDACTED);

  let out = "";
  let cursor = 0;
  scanAssignments(t, (_keyEnd, valueStart, valueEnd) => {
    // Already reduced to the sentinel by the token pass; leave it alone rather
    // than nesting sentinels.
    if (valueEnd - valueStart === REDACTED.length && t.startsWith(REDACTED, valueStart)) return;
    out += t.slice(cursor, valueStart) + REDACTED;
    cursor = valueEnd;
  });
  return cursor === 0 ? t : out + t.slice(cursor);
}

/** True if `s` looks like it carries a credential. */
function stringHasSecret(s: string): boolean {
  return SECRET_ANY.test(s) || scanAssignments(s, null);
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
  return walk(value, { nodes: 0, path: stack ?? new WeakSet<object>() }, 0);
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
  return scan(value, { nodes: 0, path: stack ?? new WeakSet<object>() }, 0, (s) =>
    s.includes(REDACTED) || s.includes(TRUNCATED) || s.includes(UNREADABLE),
  );
}

export function containsSecret(value: unknown, seen?: WeakSet<object>): boolean {
  return scan(value, { nodes: 0, path: seen ?? new WeakSet<object>() }, 0, stringHasSecret, true);
}

function scan(
  value: unknown,
  w: Walk,
  depth: number,
  hit: (s: string) => boolean,
  bySecretKey = false,
): boolean {
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
