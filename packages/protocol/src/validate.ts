/**
 * Runtime checks for what arrives over the wire. Hand-written rather than schema-library based: the shapes are
 * small, and the server must reject a malformed event with a clear message rather than a stack trace.
 */
import { itemId } from "./ids";
import type { AgentEvent, AskRequest, ContextItem } from "./types";

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** The longest text an event field may carry. */
const MAX_TEXT_CHARS = 1_000_000;
const isText = (v: unknown, max = MAX_TEXT_CHARS): v is string => typeof v === "string" && v.length <= max;
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
 * Whether `v` serializes to JSON of at most `max` characters. The engine stringifies a tool call's input, so input it
 * cannot stringify (nested past the stack limit) or that is huge is the caller's error, not a 503 later. The shape
 * walk runs first so deep input is refused before the stringify that would stall on it (D100).
 */
function jsonUnder(v: unknown, max: number): boolean {
  try {
    // Inside the try: an embedder's object may have a throwing getter, and validation must not throw.
    if (!shapeUnder(v, MAX_INPUT_DEPTH, MAX_INPUT_NODES)) return false;
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

export function checkEvent(v: unknown): Checked<AgentEvent> {
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
      if (!jsonUnder(v.input, 1_000_000)) {
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
  return {
    ok: true,
    value: {
      tenantId: v.tenantId as string,
      userId: v.userId as string,
      sessionId: v.sessionId as string,
      question: v.question,
      maxItems,
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
): Checked<{ tenantId: string; userId: string; sourceId: string; items: ContextItem[] }> {
  const head = checkSourceChanged(v);
  if (!head.ok) return head;
  const raw = (v as Record<string, unknown>).items;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "items must be a non-empty array" };
  if (raw.length > MAX_PUSHED_ITEMS) return { ok: false, error: `at most ${MAX_PUSHED_ITEMS} items per call` };
  const { sourceId } = head.value;
  const items: ContextItem[] = [];
  for (const [n, x] of raw.entries()) {
    if (!isRecord(x)) return { ok: false, error: `items[${n}] must be an object` };
    if (!isText(x.ref, 512) || !x.ref) return { ok: false, error: `items[${n}].ref must be 1-512 characters` };
    if (x.title !== undefined && !isText(x.title, 2_000))
      return { ok: false, error: textError(`items[${n}].title`, 2_000) };
    if (!isText(x.text, MAX_PUSHED_TEXT)) return { ok: false, error: textError(`items[${n}].text`, MAX_PUSHED_TEXT) };
    if (x.url !== undefined && !isText(x.url, 2_000)) return { ok: false, error: textError(`items[${n}].url`, 2_000) };
    if (x.updatedAt !== undefined && !(typeof x.updatedAt === "number" && Number.isFinite(x.updatedAt))) {
      return { ok: false, error: `items[${n}].updatedAt must be epoch milliseconds` };
    }
    let meta: Record<string, string> | undefined;
    if (x.meta !== undefined) {
      if (!isRecord(x.meta)) return { ok: false, error: `items[${n}].meta must be an object of strings` };
      const entries = Object.entries(x.meta);
      if (entries.length > 20 || entries.some(([k, m]) => k.length > 64 || !isText(m, 2_000))) {
        return { ok: false, error: `items[${n}].meta must be at most 20 short string values` };
      }
      meta = Object.fromEntries(entries) as Record<string, string>;
    }
    items.push({
      id: itemId(sourceId, x.ref),
      sourceId,
      ref: x.ref,
      title: (x.title as string | undefined) ?? "",
      text: x.text,
      ...(x.url !== undefined ? { url: x.url as string } : {}),
      ...(x.updatedAt !== undefined ? { updatedAt: x.updatedAt as number } : {}),
      ...(meta ? { meta } : {}),
    });
  }
  return { ok: true, value: { ...head.value, items } };
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
