function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
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

// `stack` holds only the ancestors on the current traversal path, so a genuine
// cycle is cut while a value merely *shared* between two branches (a DAG) is
// still expanded in full. Tracking every visited object instead would make
// canonicalize() reference-sensitive: `{a: x, b: x}` and `{a: {…}, b: {…}}`
// would hash differently despite being deeply equal, silently breaking
// agreement(), divergeSameArgs() and every content hash built on top.
export function canonicalize(value: unknown, stack?: WeakSet<object>): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const path = stack ?? new WeakSet<object>();
  if (path.has(value)) return '"$cycle"';
  path.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v, path)).join(",")}]`;
    const keys = Object.keys(value as object).sort();
    const rec = value as Record<string, unknown>;
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(rec[k], path)}`).join(",")}}`;
  } finally {
    path.delete(value);
  }
}

export function isWeakValue(v: unknown): boolean {
  return v == null || v === "" || typeof v === "boolean" || (typeof v === "number" && (v === 0 || !Number.isFinite(v)));
}

export function cloneJson<T>(v: T): T {
  if (v == null || typeof v !== "object") return v;
  return JSON.parse(JSON.stringify(v)) as T;
}
