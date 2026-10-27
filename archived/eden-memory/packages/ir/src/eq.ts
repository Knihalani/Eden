function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * The contract between the two functions in this file.
 *
 * `canonicalize` is the content hash behind agreement(), divergeSameArgs(),
 * hashProgram, hashTrace and every dedupe key in the compiler. `eq` is the
 * value comparison used to decide whether two witnesses agree. They have to
 * answer the same question, and they did not:
 *
 *   canonicalize walked non-plain objects with Object.keys(), which returns
 *   nothing for a Date, a Map, a Set or an Error — so every one of them
 *   canonicalized to `{}`. `new Date(1000)` and `new Date(999999)` had the
 *   same hash. So did a Map and a Set. A Uint8Array collided with the plain
 *   object of its indices. Meanwhile eq returned false for all of those pairs,
 *   because they are not plain objects.
 *
 * Equal hashes are read as "the witnesses agree", and an agreed slot is bound
 * into the compiled program as a literal. A hash collision between values that
 * are not equal therefore bakes one witness's value in as though it were
 * everyone's. The direction that matters is: if eq says false, canonicalize
 * must differ.
 *
 * So both are type-aware now, over the same set of types, and anything neither
 * recognises is given an identity token rather than a structural one — because
 * that is exactly what eq does with it (returns false unless it is the same
 * object).
 */

function tag(v: object): string {
  if (v instanceof Date) return "Date";
  if (v instanceof RegExp) return "RegExp";
  if (v instanceof Map) return "Map";
  if (v instanceof Set) return "Set";
  if (v instanceof ArrayBuffer) return "ArrayBuffer";
  if (ArrayBuffer.isView(v)) return (v.constructor as { name?: string })?.name ?? "TypedArray";
  if (v instanceof Error) return "Error";
  return "";
}

function bytesOf(v: ArrayBufferView | ArrayBuffer): Uint8Array {
  return v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function eq(a: unknown, b: unknown, seen?: WeakMap<object, WeakSet<object>>): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return Number.isNaN(a as number) && Number.isNaN(b as number);
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i], seen)) return false;
    return true;
  }
  if (Array.isArray(b)) return false;

  const ta = tag(a as object);
  const tb = tag(b as object);
  if (ta !== tb) return false;
  if (ta) return eqTagged(ta, a as object, b as object, seen);

  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const map = seen ?? new WeakMap<object, WeakSet<object>>();
  let pair = map.get(a);
  if (!pair) {
    pair = new WeakSet<object>();
    map.set(a, pair);
  }
  if (pair.has(b)) return true;
  pair.add(b);
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!eq(a[k], b[k], map)) return false;
  }
  return true;
}

function eqTagged(t: string, a: object, b: object, seen?: WeakMap<object, WeakSet<object>>): boolean {
  if (t === "Date") {
    const x = (a as Date).getTime();
    const y = (b as Date).getTime();
    return x === y || (Number.isNaN(x) && Number.isNaN(y));
  }
  if (t === "RegExp") return String(a) === String(b);
  if (t === "Error") {
    return (a as Error).name === (b as Error).name && (a as Error).message === (b as Error).message;
  }
  if (t === "ArrayBuffer" || ArrayBuffer.isView(a)) {
    if (a.constructor !== b.constructor) return false;
    return sameBytes(bytesOf(a as ArrayBuffer), bytesOf(b as ArrayBuffer));
  }
  if (t === "Set" || t === "Map") {
    // Cut self-referential containers the same way plain objects are cut:
    // register the (a, b) pair before comparing elements, so a set or map
    // that contains itself terminates as equal instead of overflowing.
    const map = seen ?? new WeakMap<object, WeakSet<object>>();
    let pair = map.get(a);
    if (!pair) {
      pair = new WeakSet<object>();
      map.set(a, pair);
    }
    if (pair.has(b)) return true;
    pair.add(b);
    if (t === "Set") return eqSet(a as Set<unknown>, b as Set<unknown>, map);
    return eqMap(a as Map<unknown, unknown>, b as Map<unknown, unknown>, map);
  }
  return false;
}

function eqSet(x: Set<unknown>, y: Set<unknown>, seen: WeakMap<object, WeakSet<object>>): boolean {
  if (x.size !== y.size) return false;
  // Order-insensitive, and by value rather than by reference, so two sets
  // built from equal-but-distinct objects agree.
  const rest = [...y];
  for (const v of x) {
    const i = rest.findIndex((w) => eq(v, w, seen));
    if (i < 0) return false;
    rest.splice(i, 1);
  }
  return true;
}

function eqMap(x: Map<unknown, unknown>, y: Map<unknown, unknown>, seen: WeakMap<object, WeakSet<object>>): boolean {
  if (x.size !== y.size) return false;
  const rest = [...y];
  for (const [k, v] of x) {
    const i = rest.findIndex(([k2, v2]) => eq(k, k2, seen) && eq(v, v2, seen));
    if (i < 0) return false;
    rest.splice(i, 1);
  }
  return true;
}

/**
 * Bounds on the walk.
 *
 * `stack` holds only the ancestors on the current traversal path, so a genuine
 * cycle is cut while a value merely *shared* between two branches (a DAG) is
 * still expanded in full. Tracking every visited object instead would make
 * canonicalize() reference-sensitive: `{a: x, b: x}` and `{a: {…}, b: {…}}`
 * would hash differently despite being deeply equal, silently breaking
 * agreement(), divergeSameArgs() and every content hash built on top.
 *
 * Expanding a DAG in full is exponential in its depth, though, and this runs
 * on the ingest path. Thirty objects arranged as a diamond are 2^30 nodes;
 * depth 22 measured 3.7s and an 88MB string, and two more levels is ~15s and
 * 350MB. The memo below keeps the value semantics — a shared object yields the
 * same *string*, not a back-reference — while collapsing the repeated work,
 * and the budget bounds whatever the memo cannot.
 */
const MAX_OUTPUT = 4_000_000;

/** Unforgeable: JSON.stringify always quotes a string, so a bare token cannot collide. */
const CYCLE = "$cycle";
const TRUNCATED = "$truncated";

let identitySeq = 0;
const identities = new WeakMap<object, string>();

/** A stable per-object token, for values eq only considers equal to themselves. */
function identityOf(v: object): string {
  let id = identities.get(v);
  if (!id) {
    id = `$opaque${++identitySeq}`;
    identities.set(v, id);
  }
  return id;
}

type Canon = {
  path: WeakSet<object>;
  memo: WeakMap<object, string>;
  cycles: number;
  size: number;
};

export function canonicalize(value: unknown, stack?: WeakSet<object>): string {
  return canon(value, { path: stack ?? new WeakSet<object>(), memo: new WeakMap(), cycles: 0, size: 0 });
}

function canon(value: unknown, c: Canon): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `$bigint:${value}`;
  if (typeof value === "function") return identityOf(value);
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  if (c.path.has(value)) {
    c.cycles++;
    return CYCLE;
  }
  // Past the budget, fall back to identity rather than a shared sentinel. A
  // bare "$truncated" would make two different oversized values hash alike,
  // which reads as agreement — the one direction a content hash must never
  // fail in. Identity can only ever say "these are different", which is the
  // safe answer once we have stopped looking.
  if (c.size > MAX_OUTPUT) return `${TRUNCATED}:${identityOf(value)}`;
  const hit = c.memo.get(value);
  if (hit !== undefined) return hit;

  c.path.add(value);
  const cyclesBefore = c.cycles;
  try {
    const out = canonBody(value, c);
    c.size += out.length;
    // Only memoise a result that stands on its own. If a cycle sentinel was
    // emitted while building it, that sentinel refers to an ancestor of *this*
    // traversal, and the same object reached by another path would need a
    // different answer.
    if (c.cycles === cyclesBefore) c.memo.set(value, out);
    return out;
  } finally {
    c.path.delete(value);
  }
}

function canonBody(value: object, c: Canon): string {
  if (Array.isArray(value)) return `[${value.map((v) => canon(v, c)).join(",")}]`;

  const t = tag(value);
  if (t === "Date") {
    const ms = (value as Date).getTime();
    return `$Date:${Number.isNaN(ms) ? "NaN" : ms}`;
  }
  if (t === "RegExp") return `$RegExp:${String(value)}`;
  if (t === "Error") return `$Error:${JSON.stringify([(value as Error).name, (value as Error).message])}`;
  if (t === "ArrayBuffer" || ArrayBuffer.isView(value)) {
    const name =
      value instanceof ArrayBuffer ? "ArrayBuffer" : ((value.constructor as { name?: string })?.name ?? "TypedArray");
    return `$${name}:${[...bytesOf(value as ArrayBuffer)].join(",")}`;
  }
  if (t === "Set") {
    // Sorted, so insertion order is not a difference — matching eq, which
    // compares sets without regard to order.
    return `$Set:[${[...(value as Set<unknown>)]
      .map((v) => canon(v, c))
      .sort()
      .join(",")}]`;
  }
  if (t === "Map") {
    const entries = [...(value as Map<unknown, unknown>)].map(([k, v]) => `${canon(k, c)}:${canon(v, c)}`);
    return `$Map:[${entries.sort().join(",")}]`;
  }

  if (!isPlainObject(value)) {
    // A class instance. eq only considers one of these equal to itself, so
    // giving it a structural hash would make two distinct instances collide
    // and read as agreement.
    return identityOf(value);
  }
  const keys = Object.keys(value).sort();
  const rec = value as Record<string, unknown>;
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(rec[k], c)}`).join(",")}}`;
}

export function isWeakValue(v: unknown): boolean {
  return v == null || v === "" || typeof v === "boolean" || (typeof v === "number" && (v === 0 || !Number.isFinite(v)));
}

export function cloneJson<T>(v: T): T {
  if (v == null || typeof v !== "object") return v;
  return JSON.parse(JSON.stringify(v)) as T;
}
