const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export function minifyCli(text: string): string {
  const noAnsi = stripAnsi(text);
  return noAnsi
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sortKeys(obj: Record<string, unknown>, ancestors: WeakSet<object>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = densifyWalk(obj[k], ancestors, depth + 1);
  }
  return out;
}

function uniformKeys(arr: Record<string, unknown>[]): string[] | null {
  if (arr.length < 2) return null;
  const keys = Object.keys(arr[0]!).sort();
  if (keys.length === 0) return null;
  for (const row of arr) {
    const k = Object.keys(row).sort();
    if (k.length !== keys.length) return null;
    for (let i = 0; i < keys.length; i++) if (k[i] !== keys[i]) return null;
  }
  return keys;
}

/** Deep enough for any real payload; past this the walk is a runaway, not data. */
const DENSIFY_MAX_DEPTH = 200;

/**
 * Ancestors on the current traversal path only, mirroring redact() in
 * @eden/ir. A back-edge to an ancestor is a real cycle — without the check,
 * densifyValue recursed until the stack blew. A value shared between sibling
 * branches is not a cycle and must still be densified under both parents, so
 * marking every visited object would corrupt legitimate repeated data.
 */
export function densifyValue(value: unknown): unknown {
  return densifyWalk(value, new WeakSet<object>(), 0);
}

function densifyWalk(value: unknown, ancestors: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return minifyCli(value);
  // Non-plain exotics (Map, Date, …) pass through as before.
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  if (depth >= DENSIFY_MAX_DEPTH) return "[TRUNCATED]";
  if (ancestors.has(value)) return "[CYCLE]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const objects = value.every(isPlainObject);
      if (objects) {
        const rows = value as Record<string, unknown>[];
        const keys = uniformKeys(rows);
        if (keys) {
          return {
            keys,
            rows: rows.map((row) => keys.map((k) => densifyWalk(row[k], ancestors, depth + 1))),
          };
        }
        return rows.map((row) => sortKeys(row, ancestors, depth + 1));
      }
      return value.map((v) => densifyWalk(v, ancestors, depth + 1));
    }
    return sortKeys(value, ancestors, depth);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Is this exactly the shape densifyValue() emits for a uniform object array?
 *
 * The columnar form is structural — `{keys, rows}` — with nothing marking it as
 * Eden's. The previous check was just "has array-valued `keys` and `rows`",
 * which matched plenty of real payloads: SQL-over-HTTP APIs return precisely
 * that. Worse, it kept only those two properties, so
 * `{keys, rows, total, page}` came back as a row array with `total` and `page`
 * silently gone.
 *
 * Tightening to the exact emitted shape — those two keys and no others, keys all
 * strings, every row an array of matching length — removes the data loss and
 * almost all false positives. It cannot remove them entirely: a payload that is
 * genuinely `{keys: string[], rows: unknown[][]}` is indistinguishable from a
 * densified table, and the only real cure is a discriminator in the emitted
 * form. That would change densified_bytes, which is the billing unit, so it is
 * deliberately not done here.
 */
function isColumnar(value: Record<string, unknown>): value is { keys: string[]; rows: unknown[][] } {
  const names = Object.keys(value);
  if (names.length !== 2 || !names.includes("keys") || !names.includes("rows")) return false;
  const { keys, rows } = value;
  if (!Array.isArray(keys) || !Array.isArray(rows)) return false;
  if (!keys.every((k) => typeof k === "string")) return false;
  return rows.every((row) => Array.isArray(row) && row.length === keys.length);
}

export function undensifyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(undensifyValue);
  if (isPlainObject(value) && isColumnar(value)) {
    const { keys, rows } = value;
    return rows.map((row) => {
      const obj: Record<string, unknown> = {};
      keys.forEach((k, i) => {
        obj[k] = undensifyValue(row[i]);
      });
      return obj;
    });
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = undensifyValue(v);
    return out;
  }
  return value;
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function densifyPayload(value: unknown, opts: { rawBytes?: number } = {}): {
  densified: unknown;
  raw_bytes: number;
  densified_bytes: number;
} {
  // Callers that already hold the response text (playback's liveLoad) pass
  // its byte length; stringifying the whole payload again just to measure it
  // was pure waste on the latency+billing path.
  const raw_bytes = opts.rawBytes ?? jsonBytes(value);
  const densified = densifyValue(value);
  const densified_bytes = jsonBytes(densified);
  return { densified, raw_bytes, densified_bytes };
}

export function cellsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = canonicalize(obj[k]);
    return out;
  }
  return value;
}
