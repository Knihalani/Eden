/**
 * Runtime checks for what arrives over the wire. Hand-written rather than schema-library based: the shapes are
 * small, and the server must reject a malformed event with a clear message rather than a stack trace.
 */
import { createHash } from "node:crypto";
import { itemId } from "./ids";
import type { AgentEvent, AskRequest, ContextItem } from "./types";

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** The longest text an event field may carry; an integration cuts longer text to it rather than lose the event. */
export const MAX_TEXT_CHARS = 1_000_000;
const isText = (v: unknown, max = MAX_TEXT_CHARS): v is string => typeof v === "string" && v.length <= max;
/** The longest ref an item may carry; past it a ref is cut to a prefix plus a hash of the whole, so it stays unique. */
export const MAX_REF_CHARS = 8_192;
/**
 * A ref kept whole up to MAX_REF_CHARS, or cut to a prefix plus a sha256 of the whole: unique, bounded and
 * deterministic — the same long ref clamps the same way whether it was pushed or listed.
 */
export function clampRef(ref: string, max = MAX_REF_CHARS): string {
  if (ref.length <= max) return ref;
  const hash = createHash("sha256").update(ref).digest("hex").slice(0, 16);
  return `${ref.slice(0, max - 17)}-${hash}`;
}
/** The message for a field that is not a string of at most `max` characters: too long is named, not misread. */
const textError = (field: string, max: number) =>
  `${field} must be a string of at most ${max.toLocaleString("en-US")} characters`;
/** The id shape for tenants, users, sessions and injections: no `/` or `#`, which scope keys use as separators. */
export const isId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:@-]{1,128}$/.test(v);

/** How deep a tool call's input may nest (D100). No real tool input comes near it; JSON.parse handles far deeper. */
export const MAX_INPUT_DEPTH = 1_000;
/** The longest question an ask may carry (`checkAsk`); the engine cuts its internal asks to the same length. */
export const MAX_QUESTION_CHARS = 10_000;
/** Values a tool call's input may hold (D100). A 1,000,000-character flat array holds at most ~500,000. */
const MAX_INPUT_NODES = 1_000_000;

/**
 * Whether `v` nests at most `maxDepth` containers deep and holds at most `maxNodes` values (array elements and object
 * values). Iterative with an explicit stack: it must be cheap exactly where recursion and JSON.stringify are not,
 * because stringifying a 60,000-deep array runs ~1.5 s on the event loop before it overflows (D100). Objects are
 * walked with for-in + Object.hasOwn (own enumerable string keys, as JSON.stringify sees them) instead of collecting
 * each object's values into a fresh array: that allocation roughly doubled the walk on object-heavy input.
 */
function shapeUnder(root: unknown, maxDepth: number, maxNodes: number): boolean {
  if (root === null || typeof root !== "object") return true;
  const values: object[] = [root];
  const depths: number[] = [1];
  let nodes = 0;
  while (values.length > 0) {
    const v = values.pop()!;
    const depth = depths.pop()!;
    if (depth > maxDepth) return false;
    if (Array.isArray(v)) {
      const n = v.length;
      nodes += n;
      if (nodes > maxNodes) return false;
      for (let i = 0; i < n; i++) {
        const c: unknown = v[i];
        if (c !== null && typeof c === "object") {
          values.push(c);
          depths.push(depth + 1);
        }
      }
    } else {
      const o = v as Record<string, unknown>;
      for (const k in o) {
        if (!Object.hasOwn(o, k)) continue;
        if (++nodes > maxNodes) return false;
        const c = o[k];
        if (c !== null && typeof c === "object") {
          values.push(c);
          depths.push(depth + 1);
        }
      }
    }
  }
  return true;
}

/**
 * Whether a raw JSON body nests at most `MAX_INPUT_DEPTH` + 8 containers deep and holds at most `MAX_INPUT_NODES` +
 * 10,000 values, counted outside strings (each `[`, `{` and `,`); a byte scan, so it runs before `JSON.parse`. Under
 * D100's 8 MB cap, structure is what costs the parse: 4 M small numbers took 106-134 ms and 4 M nested arrays 453-665
 * ms where an 8 MB string took 4-7 ms. No valid request comes near either bound (a tool input is at most 1,000,000
 * characters, so ~500,000 values; the envelope adds a few levels and items), so only padded bodies are refused. Not
 * a JSON check: whatever passes is still parsed and validated as before.
 */
export function bodyShapeUnder(bytes: Uint8Array): boolean {
  return bodyShapeQuick(bytes, BODY_MAX_DEPTH, BODY_MAX_VALUES);
}

/**
 * `bodyShapeWithin`'s answer, mostly without its byte scan (D1940): a body of at most `maxValues` bytes holds at most
 * that many values (each is a byte), and one with at most `maxDepth` opening brackets anywhere, inside strings or not,
 * nests no deeper outside them; such a body passes on two native `indexOf` searches. Anything else is scanned.
 * Measured (median of 7 interleaved runs): a user message 0.26 → 0.09 µs, a 5.9 KB tool result 3.5 → 0.5, a 63 KB
 * one 57 → 6, 100 pushed items (45 KB) 19-28 → 3-4; bodies past the bracket bound cost the scan as before.
 */
export function bodyShapeQuick(bytes: Uint8Array, maxDepth: number, maxValues: number): boolean {
  return fewOpenings(bytes, maxDepth, maxValues) || bodyShapeWithin(bytes, maxDepth, maxValues);
}

/**
 * True only where `bodyShapeWithin` is (above); false decides nothing. A body dense in brackets gives up after 64 of
 * them when they come often enough that the whole body would pass `maxDepth`, so it costs at most those 64 searches
 * more than the scan alone (about 1 µs on a 4 KB string of brackets).
 */
function fewOpenings(bytes: Uint8Array, maxDepth: number, maxValues: number): boolean {
  const n = bytes.length;
  if (n > maxValues) return false;
  let found = 0;
  for (let k = 0; k < 2; k++) {
    const bracket = k === 0 ? 0x7b : 0x5b;
    for (let i = indexOfByte(bytes, bracket, 0); i >= 0; i = indexOfByte(bytes, bracket, i + 1)) {
      if (++found > maxDepth) return false;
      // At this rate the brackets would pass the bound: the scan is the cheaper answer.
      if (found === 64 && found * n > maxDepth * (i + 1)) return false;
    }
  }
  return true;
}

/** `bodyShapeUnder`'s bounds: levels and values (opening brackets and commas) outside strings. */
export const BODY_MAX_DEPTH = MAX_INPUT_DEPTH + 8;
export const BODY_MAX_VALUES = MAX_INPUT_NODES + 10_000;

/** `bodyShapeUnder` with its bounds given: the tests compare it with the plain byte loop at small bounds. */
export function bodyShapeWithin(bytes: Uint8Array, maxDepth: number, maxValues: number): boolean {
  const n = bytes.length;
  let depth = 0;
  let values = 0;
  for (let i = 0; i < n; i++) {
    // Most bytes outside strings are digits, letters and whitespace: one table load passes them.
    const k = SHAPE_BYTE[bytes[i]!]!;
    if (k === 0) continue;
    if (k === QUOTE) i = stringEnd(bytes, i + 1);
    else if (k === OPEN) {
      if (++depth > maxDepth || ++values > maxValues) return false;
    } else if (k === CLOSE) depth--;
    else if (++values > maxValues) return false;
  }
  return true;
}

const QUOTE = 1;
const OPEN = 2;
const CLOSE = 3;
const COMMA = 4;
/** What each byte is to the shape scan outside strings: 0 for nothing. */
const SHAPE_BYTE = new Uint8Array(256);
SHAPE_BYTE[0x22] = QUOTE;
SHAPE_BYTE[0x5b] = SHAPE_BYTE[0x7b] = OPEN;
SHAPE_BYTE[0x5d] = SHAPE_BYTE[0x7d] = CLOSE;
SHAPE_BYTE[0x2c] = COMMA;

/**
 * The next `byte` at or after `from`, or -1. On V8 (Node), `Uint8Array.prototype.indexOf` reads a byte at a time (627
 * µs a MiB) where `Buffer`'s searches natively (16 µs); on JSC (Bun) the typed array's own is the native one (13-16
 * µs), so it is kept there (D1870).
 */
type ByteSearch = (this: Uint8Array, byte: number, from: number) => number;
/** Node's `Buffer.prototype.indexOf`, off Bun only; it searches any `Uint8Array` it is called on. */
const bufferIndexOf: ByteSearch | undefined =
  typeof (globalThis as { Bun?: unknown }).Bun === "undefined"
    ? (globalThis as { Buffer?: { prototype?: { indexOf?: ByteSearch } } }).Buffer?.prototype?.indexOf
    : undefined;
const indexOfByte = bufferIndexOf
  ? (bytes: Uint8Array, byte: number, from: number) => bufferIndexOf.call(bytes, byte, from)
  : (bytes: Uint8Array, byte: number, from: number) => bytes.indexOf(byte, from);

/**
 * The index of the quote that ends the string whose text starts at `i`, or `bytes.length` when it does not end (an
 * unended string holds no structure). A backslash escapes the next byte (a quote among them), so a quote ends the
 * string when the run of backslashes right before it is even. UTF-8 never puts 0x22 or 0x5c inside a multi-byte
 * character, so a byte scan cannot misread one. Strings are most of a reply's bytes, and a byte loop over them cost
 * six times the parse (113 µs a 64 KB result against 19): past a short run read byte by byte (most strings are short),
 * the next quote is found with the native `indexOf` and only the backslashes right before it are read. D1840 searched
 * for the next backslash too and read on byte by byte from each one, so text with an escaped newline or quote every
 * few dozen bytes, as tool output is, cost 0.8-1.0 ms a MiB, as much as its parse; this reads it in 0.3 (D1870). Where
 * escaped quotes come less than 4 bytes apart (JSON written as text, a run of `\"`) a search each would cost more than
 * the loop, so the loop reads a window that doubles while they stay that close. Each search starts past the last quote
 * and each byte is read at most twice, so the scan stays linear.
 */
function stringEnd(bytes: Uint8Array, i: number): number {
  const n = bytes.length;
  let run = 32;
  for (;;) {
    const stop = i + run < n ? i + run : n;
    for (; i < stop; i++) {
      const s = bytes[i]!;
      if (s === 0x5c) i++;
      else if (s === 0x22) return i;
    }
    if (i >= n) return n;
    // No escape is open at `i`, so the run of backslashes before the next quote starts at or after it.
    const q = indexOfByte(bytes, 0x22, i);
    if (q < 0) return n;
    let b = q - 1;
    while (b >= i && bytes[b]! === 0x5c) b--;
    if (((q - 1 - b) & 1) === 0) return q;
    run = q - i < 4 ? Math.min(Math.max(run * 2, 16), 4096) : 0;
    i = q + 1;
  }
}

/**
 * Whether `v` serializes to JSON of at most `max` characters. The engine stringifies a tool call's input, so input it
 * cannot stringify (nested past the stack limit) or that is huge is the caller's error, not a 503 later. The shape
 * walk runs first so deep input is refused before the stringify that would stall on it (D100).
 */
function jsonUnder(v: unknown, max: number, sourceChars: number): boolean {
  try {
    // Inside the try: an embedder's object may have a throwing getter, and validation must not throw.
    if (!shapeUnder(v, MAX_INPUT_DEPTH, MAX_INPUT_NODES)) return false;
    // Parsed from JSON text at most a sixth of `max` long: its JSON is at most `max` (`JSON_GROWTH`), unbuilt.
    if (sourceChars * JSON_GROWTH <= max) return true;
    return (JSON.stringify(v ?? null)?.length ?? 0) <= max;
  } catch {
    return false;
  }
}

function scopeError(r: Record<string, unknown>): string | null {
  if (!isId(r.tenantId)) return "tenantId must be 1-128 characters of [A-Za-z0-9._:@-]";
  if (!isId(r.userId)) return "userId must be 1-128 characters of [A-Za-z0-9._:@-]";
  if (!isId(r.sessionId)) return "sessionId must be 1-128 characters of [A-Za-z0-9._:@-]";
  return null;
}

/**
 * How much longer than the JSON text it was parsed from a value's `JSON.stringify` can be: a number written short
 * grows most ("1e20" is 21 characters, 5.25x), a lone surrogate written raw becomes a 6-character escape, white space
 * and repeated keys go, and nothing else grows (an escape in the text is never shorter than what stringify writes).
 */
const JSON_GROWTH = 6;

/**
 * `sourceChars`, when given, is the length of the JSON text `v` was parsed from (the server's decoded body). A tool
 * call's input parsed from text at most a sixth of its 1,000,000-character bound fits that bound, so its
 * `JSON.stringify`, most of the check's cost (0.55 of 0.96 µs for a 206-character input, 3.0 of 3.6 at 1,466), is
 * skipped (D1940); the engine builds that JSON itself later. The default, Infinity, always stringifies.
 */
export function checkEvent(v: unknown, sourceChars = Infinity): Checked<AgentEvent> {
  if (!isRecord(v)) return { ok: false, error: "event must be an object" };
  const scope = scopeError(v);
  if (scope) return { ok: false, error: scope };
  const at = typeof v.at === "number" && Number.isFinite(v.at) ? v.at : Date.now();
  const base = { tenantId: v.tenantId as string, userId: v.userId as string, sessionId: v.sessionId as string, at };
  switch (v.kind) {
    case "session_start":
      return { ok: true, value: { ...base, kind: "session_start", agent: isText(v.agent, 200) ? v.agent : undefined } };
    case "session_end":
      return { ok: true, value: { ...base, kind: "session_end" } };
    case "context_reset":
      return { ok: true, value: { ...base, kind: "context_reset" } };
    case "user_message":
    case "agent_message":
      if (!isText(v.text)) return { ok: false, error: textError(`${v.kind}.text`, MAX_TEXT_CHARS) };
      // A draft the user is still typing: only `true` marks one, anything else is a sent message.
      if (v.kind === "user_message" && v.draft === true) {
        return { ok: true, value: { ...base, kind: "user_message", text: v.text, draft: true } };
      }
      return { ok: true, value: { ...base, kind: v.kind, text: v.text } };
    case "tool_call":
      if (!isText(v.tool, 200)) return { ok: false, error: textError("tool_call.tool", 200) };
      if (!jsonUnder(v.input, 1_000_000, sourceChars)) {
        return {
          ok: false,
          error: "tool_call.input must be JSON of at most 1,000,000 characters, nested at most 1,000 deep",
        };
      }
      return { ok: true, value: { ...base, kind: "tool_call", tool: v.tool, input: v.input } };
    case "tool_result":
      if (!isText(v.tool, 200) || !isText(v.output)) {
        return {
          ok: false,
          error: "tool_result needs tool (at most 200 characters) and output (at most 1,000,000) as strings",
        };
      }
      return {
        ok: true,
        value: { ...base, kind: "tool_result", tool: v.tool, output: v.output, isError: !!v.isError },
      };
    case "external":
      if (!isText(v.source, 200) || !isText(v.text)) {
        return {
          ok: false,
          error: "external needs source (at most 200 characters) and text (at most 1,000,000) as strings",
        };
      }
      return { ok: true, value: { ...base, kind: "external", source: v.source, text: v.text } };
    default:
      return { ok: false, error: `unknown event kind: ${String(v.kind)}` };
  }
}

export function checkAsk(v: unknown): Checked<AskRequest> {
  if (!isRecord(v)) return { ok: false, error: "ask must be an object" };
  const scope = scopeError(v);
  if (scope) return { ok: false, error: scope };
  if (!isText(v.question, MAX_QUESTION_CHARS)) return { ok: false, error: textError("question", MAX_QUESTION_CHARS) };
  if (!v.question.trim()) return { ok: false, error: "question must be non-empty" };
  const maxItems = typeof v.maxItems === "number" ? Math.max(1, Math.min(20, Math.floor(v.maxItems))) : undefined;
  // `itemId` (D2022): a citation's `sourceId:ref` id, bounded like a ref is, not a scope id.
  if (v.itemId !== undefined && !isText(v.itemId, 1_024)) {
    return { ok: false, error: textError("itemId", 1_024) };
  }
  return {
    ok: true,
    value: {
      tenantId: v.tenantId as string,
      userId: v.userId as string,
      sessionId: v.sessionId as string,
      question: v.question,
      maxItems,
      ...(typeof v.itemId === "string" ? { itemId: v.itemId } : {}),
    },
  };
}

/** Items one change notification may carry (`checkSourceItems`): a notification is a few items, never a listing. */
export const MAX_PUSHED_ITEMS = 100;
/** The longest item text a notification may carry; the engine cuts what it holds further (`maxTextChars`). */
const MAX_PUSHED_TEXT = 200_000;

/** A source change notification's body (`POST /v1/sources/changed`): the user and the source. */
export function checkSourceChanged(v: unknown): Checked<{ tenantId: string; userId: string; sourceId: string }> {
  if (!isRecord(v)) return { ok: false, error: "body must be an object" };
  if (!isId(v.tenantId)) return { ok: false, error: "tenantId must be 1-128 characters of [A-Za-z0-9._:@-]" };
  if (!isId(v.userId)) return { ok: false, error: "userId must be 1-128 characters of [A-Za-z0-9._:@-]" };
  if (!isId(v.sourceId)) return { ok: false, error: "sourceId must be 1-128 characters of [A-Za-z0-9._:@-]" };
  return { ok: true, value: { tenantId: v.tenantId, userId: v.userId, sourceId: v.sourceId } };
}

/**
 * The items a change notification carried (`POST /v1/sources/items`): each `{ref, title?, text, url?, updatedAt?,
 * meta?}` of the named source, at most `MAX_PUSHED_ITEMS`. Ids are made here from the source and ref, as a listing
 * makes them, so a pushed item and the same item listed later are one item.
 */
export function checkSourceItems(
  v: unknown,
): Checked<{ tenantId: string; userId: string; sourceId: string; items: ContextItem[]; skipped: number }> {
  const head = checkSourceChanged(v);
  if (!head.ok) return head;
  const raw = (v as Record<string, unknown>).items;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "items must be a non-empty array" };
  if (raw.length > MAX_PUSHED_ITEMS) return { ok: false, error: `at most ${MAX_PUSHED_ITEMS} items per call` };
  const { sourceId } = head.value;
  // Normalize, never reject (A4): a connector's odd-but-real item is trimmed and coerced, not a 400 that
  // drops the whole notification. An entry still needs a ref and some text; items that have neither are
  // skipped, and only a call with nothing usable at all is a caller error.
  const items: ContextItem[] = [];
  for (const [n, x] of raw.entries()) {
    if (!isRecord(x)) continue;
    // A long ref is kept whole, hashed only past MAX_REF_CHARS — truncating would merge two refs sharing a
    // prefix and stop a pushed copy matching its listed one.
    const ref = typeof x.ref === "string" && x.ref ? clampRef(x.ref) : null;
    if (!ref) continue;
    const text =
      typeof x.text === "string"
        ? x.text.slice(0, MAX_PUSHED_TEXT)
        : typeof x.text === "number" || typeof x.text === "boolean"
          ? String(x.text)
          : null;
    if (!text) continue;
    const title = typeof x.title === "string" ? x.title.slice(0, 2_000) : "";
    const url = typeof x.url === "string" && x.url.length <= 2_000 ? x.url : undefined;
    let updatedAt: number | undefined;
    if (typeof x.updatedAt === "number" && Number.isFinite(x.updatedAt)) updatedAt = x.updatedAt;
    else if (typeof x.updatedAt === "string") {
      // Non-epoch forms a connector may send: epoch digits ("1736546400000" or seconds) or an ISO date.
      const num = /^\d{9,13}$/.test(x.updatedAt) ? Number(x.updatedAt) : NaN;
      const parsed = Number.isFinite(num) ? num : Date.parse(x.updatedAt);
      if (Number.isFinite(parsed)) updatedAt = parsed < 10_000_000_000 ? parsed * 1000 : parsed;
    }
    let meta: Record<string, string> | undefined;
    if (isRecord(x.meta)) {
      meta = {};
      for (const [k, v] of Object.entries(x.meta).slice(0, 20)) {
        if (!k || k.length > 64 || v === undefined) continue;
        const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;
        if (s !== null) meta[k] = s.slice(0, 2_000);
      }
      if (Object.keys(meta).length === 0) meta = undefined;
    }
    items.push({
      id: itemId(sourceId, ref),
      sourceId,
      ref,
      title,
      text,
      ...(url !== undefined ? { url } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(meta ? { meta } : {}),
    });
  }
  if (items.length === 0) return { ok: false, error: "items must be a non-empty array" };
  // `skipped` lets the caller know entries were dropped: a partial push should still fall back to a plain
  // change signal so the source's listing re-reads (and normalizes) them.
  return { ok: true, value: { ...head.value, items, skipped: raw.length - items.length } };
}

/**
 * A notice naming what changed (`POST /v1/sources/refs`, D347): the source's refs it changed or added, at most 100,
 * with no content; Eden reads them itself. The same shape as a deletion's body.
 */
export function checkSourceRefs(
  v: unknown,
): Checked<{ tenantId: string; userId: string; sourceId: string; refs: string[] }> {
  return checkSourceRemoved(v);
}

/** A deletion notification's body (`POST /v1/sources/removed`): the source's refs it no longer has, at most 100. */
export function checkSourceRemoved(
  v: unknown,
): Checked<{ tenantId: string; userId: string; sourceId: string; refs: string[] }> {
  const head = checkSourceChanged(v);
  if (!head.ok) return head;
  const refs = (v as Record<string, unknown>).refs;
  if (!Array.isArray(refs) || refs.length === 0) return { ok: false, error: "refs must be a non-empty array" };
  if (refs.length > MAX_PUSHED_ITEMS) return { ok: false, error: `at most ${MAX_PUSHED_ITEMS} refs per call` };
  if (!refs.every((r) => isText(r, 512) && r.length > 0))
    return { ok: false, error: "each ref must be 1-512 characters" };
  return { ok: true, value: { ...head.value, refs: refs as string[] } };
}

/**
 * Whether a request with this `Origin` header may be served without a key (the server's dev mode, the proxy with no
 * `proxyKey`; audit A20). Every browser POST carries an Origin and no agent's HTTP client sends one, so a page on
 * another site, which can reach 127.0.0.1 by a blind cross-site POST or read the answer by DNS rebinding, is refused;
 * a page served from this machine (localhost, 127.0.0.1, [::1], any port) is not. A keyed request needs no such check.
 */
export function keylessOriginAllowed(origin: string | null): boolean {
  if (origin === null) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // "null" (a sandboxed frame, a file:// page) and anything unparseable.
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
}
