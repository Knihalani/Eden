const SEG = /(?:^|\.)([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]|\[['\"]([^'\"]+)['\"]\]/g;
const DANGEROUS = new Set(["__proto__", "prototype", "constructor"]);

export function parsePath(path: string): string[] | null {
  const raw = path.trim();
  if (!raw || raw === "$") return [];
  const stripped = raw.startsWith("$.") ? raw.slice(2) : raw.startsWith("$") ? raw.slice(1) : raw;
  if (!stripped) return [];
  if (!/[.\[]/.test(stripped)) return DANGEROUS.has(stripped) ? null : [stripped];
  const parts: string[] = [];
  let idx = 0;
  SEG.lastIndex = 0;
  let m: RegExpExecArray | null;
  const s = stripped;
  while ((m = SEG.exec(s))) {
    if (m.index !== idx) return null;
    const part = m[1] ?? m[2] ?? m[3]!;
    if (DANGEROUS.has(part)) return null;
    parts.push(part);
    idx = m.index + m[0].length;
  }
  if (idx < s.length) return null;
  return parts;
}

export function getPath(obj: unknown, path: string): unknown {
  const parts = parsePath(path);
  if (parts === null) return undefined;
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    if (DANGEROUS.has(p) || !Object.hasOwn(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function keySeg(k: string): { path: string; dotted: boolean } {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return { path: k, dotted: true };
  return { path: `[${JSON.stringify(k)}]`, dotted: false };
}

function childPath(path: string, k: string): string {
  const seg = keySeg(k);
  if (!path) return seg.path;
  return seg.dotted ? `${path}.${seg.path}` : `${path}${seg.path}`;
}

/**
 * Memo for flatten().
 *
 * Holds the *entries*, not the Map that was handed out. The cache used to
 * store and return the live Map, so every caller shared one mutable object:
 * anything that wrote into a returned Map corrupted it for every later
 * caller, and bind.ts consumes these in three places. Handing back a fresh
 * Map each time costs a copy and removes the coupling entirely.
 */
const flattenCache = new WeakMap<object, Array<[string, unknown]>>();

export function flatten(value: unknown, opts: { maxDepth?: number; maxArray?: number } = {}): Map<string, unknown> {
  const custom = opts.maxDepth != null || opts.maxArray != null;
  const cached = !custom && value && typeof value === "object" ? flattenCache.get(value) : undefined;
  if (cached) return new Map(cached);
  const maxDepth = opts.maxDepth ?? 6;
  const maxArray = opts.maxArray ?? 32;
  const out = new Map<string, unknown>();
  // Ancestors on the current path only. A value reachable by two different
  // paths must be expanded under both — skipping the second occurrence would
  // hide its sub-paths from producersFor(), losing bindings the compiler needs
  // and turning determinable slots into refusals.
  const ancestors = new WeakSet<object>();
  const walk = (v: unknown, path: string, depth: number) => {
    out.set(path, v);
    if (depth >= maxDepth || v == null || typeof v !== "object") return;
    if (ancestors.has(v)) return;
    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        const n = Math.min(v.length, maxArray);
        for (let i = 0; i < n; i++) walk(v[i], path ? `${path}[${i}]` : `[${i}]`, depth + 1);
        return;
      }
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        walk(val, childPath(path, k), depth + 1);
      }
    } finally {
      ancestors.delete(v);
    }
  };
  walk(value, "", 0);
  if (!custom && value && typeof value === "object") flattenCache.set(value, [...out]);
  return out;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

export function interpolate(expr: string, value: unknown): string {
  return expr.replace(/\{\{([^}]+)\}\}|\{([^}]+)\}|\$\{([^}]+)\}/g, (_, a, b, c) => {
    const path = String(a ?? b ?? c ?? "").trim();
    const v = getPath(value, path);
    return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  });
}

/**
 * Slot-only interpolation for templates embedded in structured data.
 *
 * Unlike interpolate(), which matches any `{…}` pattern, this only replaces
 * `{path}` where `path` resolves to a defined value in the record. Literal
 * braces (JSON objects, shell expansions) pass through untouched — so a
 * template binding on a JSON body works: `{"text":"Status: {status}"}`
 * resolves `{status}` while preserving the surrounding JSON structure.
 *
 * Dotted paths (`{db.host}`) walk nested records via getPath.
 */
export function interpolateSlots(expr: string, value: unknown): string {
  return expr.replace(/\{([\w.]+)\}/g, (match, path: string) => {
    const v = getPath(value, path);
    if (v === undefined || v === null) return match; // preserve unresolvable slots
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}
