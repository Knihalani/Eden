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

/**
 * Fold consecutive duplicate lines after minifyCli. 50 identical CLI lines
 * become `line ×50` — still a string the model can read. Applied only when the
 * folded run is strictly shorter; unique lines are left alone. v1 keeps
 * minifyCli only.
 */
function foldRepeatedLines(text: string): string {
  if (!text.includes("\n")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    let n = 1;
    while (i + n < lines.length && lines[i + n] === line) n++;
    if (n >= 2) {
      const folded = `${line} ×${n}`;
      const original = lines.slice(i, i + n).join("\n");
      if (folded.length < original.length) out.push(folded);
      else for (let k = 0; k < n; k++) out.push(line);
    } else {
      out.push(line);
    }
    i += n;
  }
  const result = out.join("\n");
  return result.length < text.length ? result : text;
}

function densifyString(text: string, version: 1 | 2): string {
  const min = minifyCli(text);
  if (version < 2) return min;
  const folded = foldRepeatedLines(min);
  return folded.length < min.length ? folded : min;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sortKeys(obj: Record<string, unknown>, ancestors: WeakSet<object>, depth: number, version: 1 | 2): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = densifyWalk(obj[k], ancestors, depth + 1, version);
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
  return densifyWalk(value, new WeakSet<object>(), 0, 2);
}

/** Wave-12 walk: columnar `{keys, rows}` only. Kept so the gated table can score v2 against v1. */
export function densifyValueV1(value: unknown): unknown {
  return densifyWalk(value, new WeakSet<object>(), 0, 1);
}

function densifyWalk(value: unknown, ancestors: WeakSet<object>, depth: number, version: 1 | 2): unknown {
  if (typeof value === "string") return densifyString(value, version);
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
          const packed = {
            keys,
            rows: rows.map((row) => keys.map((k) => densifyWalk(row[k], ancestors, depth + 1, version))),
          };
          return version >= 2 ? internColumns(packed) : packed;
        }
        return rows.map((row) => sortKeys(row, ancestors, depth + 1, version));
      }
      return value.map((v) => densifyWalk(v, ancestors, depth + 1, version));
    }
    return sortKeys(value, ancestors, depth, version);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Dictionary-encode repeated cells in a columnar table.
 *
 * v1 already lifts key names out of every row; the leftover waste is values
 * spelled out per row (`"octocat"`, `"open"`, ISO timestamps, nested
 * `{name:"bug"}` labels). Replace a low-cardinality column with indices into a
 * parallel intern table `d`. `d[i] === 0` means column i is stored literally.
 * `d[i]` of length 1 is a constant: the value lives once in `d` and is omitted
 * from every row (invoice-class repeated keys). Longer `d[i]` is an intern
 * table and the row stores an index.
 *
 * `d` is omitted unless it strictly reduces JSON bytes vs `{keys, rows}` — it
 * is not a type tag, and unique-value tables keep the v1 shape so they cannot
 * inflate. `{keys, rows, total, page}` still has extra fields and is not
 * treated as columnar on the way back.
 */
function internColumns(table: { keys: string[]; rows: unknown[][] }): unknown {
  const { keys, rows } = table;
  const n = rows.length;
  const d: unknown[] = [];
  const kind: ("lit" | "idx" | "const")[] = [];
  const idxsPerCol: number[][] = [];
  let any = false;

  for (let c = 0; c < keys.length; c++) {
    const firstIndex = new Map<string, number>();
    const unique: unknown[] = [];
    const idxs: number[] = [];
    let internable = true;
    for (let r = 0; r < n; r++) {
      const cell = rows[r]![c];
      let sig: string | undefined;
      try {
        sig = JSON.stringify(cell);
      } catch {
        internable = false;
        break;
      }
      if (typeof sig !== "string") {
        internable = false;
        break;
      }
      let i = firstIndex.get(sig);
      if (i === undefined) {
        i = unique.length;
        firstIndex.set(sig, i);
        unique.push(cell);
      }
      idxs.push(i);
    }
    if (!internable || unique.length === 0 || unique.length === n) {
      d.push(0);
      kind.push("lit");
      idxsPerCol.push([]);
      continue;
    }
    any = true;
    d.push(unique);
    idxsPerCol.push(idxs);
    // A single unique value is stored once in `d` and omitted from every row.
    kind.push(unique.length === 1 ? "const" : "idx");
  }

  if (!any) return table;

  const internedRows: unknown[][] = [];
  for (let r = 0; r < n; r++) {
    const packed: unknown[] = [];
    for (let c = 0; c < keys.length; c++) {
      if (kind[c] === "const") continue;
      packed.push(kind[c] === "idx" ? idxsPerCol[c]![r]! : rows[r]![c]);
    }
    internedRows.push(packed);
  }

  const withDict = { keys, rows: internedRows, d };
  return jsonBytes(withDict) < jsonBytes(table) ? withDict : table;
}

function rowWidth(keys: string[], d: unknown[] | undefined): number {
  if (!d) return keys.length;
  let w = 0;
  for (const e of d) {
    if (e === 0) w++;
    else if (Array.isArray(e) && e.length !== 1) w++;
  }
  return w;
}

/**
 * Is this exactly the shape densifyValue() emits for a uniform object array?
 *
 * The columnar form is structural — `{keys, rows}` or `{keys, rows, d}` — with
 * nothing marking it as Eden's. The previous check was just "has array-valued
 * `keys` and `rows`", which matched plenty of real payloads: SQL-over-HTTP
 * APIs return precisely that. Worse, it kept only those two properties, so
 * `{keys, rows, total, page}` came back as a row array with `total` and `page`
 * silently gone.
 *
 * Tightening to the exact emitted shape — those two keys (plus optional intern
 * table `d`) and no others, keys all strings, every row an array of matching
 * length — removes the data loss and almost all false positives. It cannot
 * remove them entirely: a payload that is genuinely `{keys: string[], rows:
 * unknown[][]}` is indistinguishable from a densified table, and the only real
 * cure is a discriminator in the emitted form. That would change
 * densified_bytes, which is the billing unit, so it is deliberately not done
 * here. `d` is an intern table, not a type tag: unique-value tables still emit
 * `{keys, rows}` only. All-zero `d` (`[0,0,…]`) is user data — v2 never emits
 * that, so it must not match and `d` must survive undensify.
 */
function isInternTable(e: unknown): e is unknown[] {
  return Array.isArray(e) && e.length >= 1;
}

function isColumnar(
  value: Record<string, unknown>,
): value is { keys: string[]; rows: unknown[][]; d?: unknown[] } {
  const names = Object.keys(value);
  if (!names.includes("keys") || !names.includes("rows")) return false;
  for (const n of names) {
    if (n !== "keys" && n !== "rows" && n !== "d") return false;
  }
  const { keys, rows, d } = value;
  if (!Array.isArray(keys) || !Array.isArray(rows)) return false;
  if (!keys.every((k) => typeof k === "string")) return false;
  if (d !== undefined) {
    if (!Array.isArray(d) || d.length !== keys.length) return false;
    if (!d.every((e) => e === 0 || Array.isArray(e))) return false;
    // All-zero (or empty) `d` is not an intern table we emit.
    if (!d.some(isInternTable)) return false;
  }
  const width = rowWidth(keys, d as unknown[] | undefined);
  return rows.every((row) => Array.isArray(row) && row.length === width);
}

export function undensifyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(undensifyValue);
  if (isPlainObject(value) && isColumnar(value)) {
    const { keys, rows, d } = value;
    return rows.map((row) => {
      const obj: Record<string, unknown> = {};
      let slot = 0;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        const table = d?.[i];
        if (Array.isArray(table) && table.length === 1) {
          obj[k] = undensifyValue(table[0]);
          continue;
        }
        const cell = row[slot++];
        obj[k] = undensifyValue(Array.isArray(table) && typeof cell === "number" ? table[cell] : cell);
      }
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
  const packed = densifyValue(value);
  const packed_bytes = jsonBytes(packed);
  // Never inflate billing bytes: a transform that grew the payload is a no-op.
  if (packed_bytes > raw_bytes) {
    return { densified: value, raw_bytes, densified_bytes: raw_bytes };
  }
  return { densified: packed, raw_bytes, densified_bytes: packed_bytes };
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
