/**
 * Structure miners for shapes that are not a single-array foreach:
 * cursor page walks, flatten-concat, filter, zip, chunk, group, lookup.
 *
 * Keys are structural (next-cursor chains, concat widths, predicates), never
 * a tool-name allowlist. A random subset still returns null so compile can
 * refuse read_set_mismatch.
 */
import type { Binding, StretchTrace, TraceEvent } from "@eden/ir";
import { eq, getPath } from "@eden/ir";
import { effectiveEventName } from "./mine";

const NEXT_PATHS = [
  "nextCursor",
  "next_cursor",
  "endCursor",
  "pageInfo.endCursor",
  "next",
  "nextPage",
  "next_page",
  "cursor",
] as const;

const HAS_MORE_PATHS = ["has_more", "hasMore", "hasNextPage", "pageInfo.hasNextPage"] as const;

export type CursorWalk = {
  until: string;
  maxIters: number;
  cursorArg: string;
  nextPath: string;
  itemsPath: string;
  init: Binding;
};

export type OffsetWalk = {
  until: string;
  maxIters: number;
  pageArg: string;
  pageResultPath: string;
  delta: number;
  itemsPath: string;
  init: Binding;
};

function okNamed(t: StretchTrace, tool: string): TraceEvent[] {
  return t.events.filter((e) => e.ok && !e.skipped && effectiveEventName(e) === tool);
}

function isSeedCursor(v: unknown): boolean {
  return v == null || v === "" || v === 0 || v === "0";
}

function nextValue(result: unknown, path: string): unknown {
  return getPath(result, path);
}

function pathChains(pages: TraceEvent[], path: string): boolean {
  for (let i = 0; i < pages.length - 1; i++) {
    const n = nextValue(pages[i]!.result, path);
    if (n == null || n === false) return false;
    const args = pages[i + 1]!.args ?? {};
    if (!Object.values(args).some((v) => eq(v, n))) return false;
  }
  return true;
}

function pathIsTerminal(pages: TraceEvent[], path: string): boolean {
  const last = nextValue(pages[pages.length - 1]!.result, path);
  return last == null || last === false || last === "";
}

/**
 * Cursor-chain field: NEXT_PATHS win when they chain, then any string/number
 * field that chains and is empty on the last page. Not a name allowlist.
 */
function findNextPath(pages: TraceEvent[]): string | null {
  if (pages.length < 2) return null;
  const first = flattenPrimitive(pages[0]!.result);
  const preferred = NEXT_PATHS.filter((p) => first.has(p) || nextValue(pages[0]!.result, p) != null);
  const rest: string[] = [];
  for (const [k, v] of first) {
    if (typeof v !== "string" && typeof v !== "number") continue;
    if (preferred.includes(k as (typeof NEXT_PATHS)[number])) continue;
    rest.push(k);
  }
  rest.sort();
  for (const path of [...preferred, ...rest]) {
    if (!pathChains(pages, path)) continue;
    if (!pathIsTerminal(pages, path)) continue;
    return path;
  }
  return null;
}

function findCursorArg(pages: TraceEvent[], nextPath: string): string | null {
  if (!pages.length) return null;
  const first = pages[0]!.args ?? {};
  const keys = Object.keys(first);
  const hits: string[] = [];
  for (const k of keys) {
    if (!isSeedCursor(first[k])) continue;
    let ok = true;
    for (let i = 1; i < pages.length; i++) {
      const want = nextValue(pages[i - 1]!.result, nextPath);
      if (!eq((pages[i]!.args ?? {})[k], want)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(k);
  }
  return hits.length === 1 ? hits[0]! : null;
}

function findItemsPath(pages: TraceEvent[]): string | null {
  if (!pages.length) return null;
  const arrays = collectArrays(pages[0]!.result);
  const hits: string[] = [];
  for (const { path } of arrays) {
    if (pages.every((p) => Array.isArray(path ? getPath(p.result, path) : p.result))) hits.push(path);
  }
  // Prefer the widest array that is present on every page.
  hits.sort((a, b) => {
    const la = (getPath(pages[0]!.result, a) as unknown[]).length;
    const lb = (getPath(pages[0]!.result, b) as unknown[]).length;
    return lb - la;
  });
  return hits[0] ?? null;
}

function collectArrays(result: unknown, prefix = "", depth = 0): Array<{ path: string; arr: unknown[] }> {
  if (Array.isArray(result)) return [{ path: prefix, arr: result }];
  if (!result || typeof result !== "object" || depth > 4) return [];
  const out: Array<{ path: string; arr: unknown[] }> = [];
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) out.push({ path, arr: v });
    else if (v && typeof v === "object") out.push(...collectArrays(v, path, depth + 1));
  }
  return out;
}

function untilExpr(pages: TraceEvent[], nextPath: string): string | null {
  for (const hp of HAS_MORE_PATHS) {
    const vals = pages.map((p) => getPath(p.result, hp));
    if (vals.every((v) => typeof v === "boolean") && vals.at(-1) === false && vals.slice(0, -1).every(Boolean)) {
      return `${hp} == false`;
    }
  }
  const last = nextValue(pages[pages.length - 1]!.result, nextPath);
  if (last == null || last === "") return `${nextPath} == null`;
  return null;
}

/**
 * Repeating listPage-shaped calls whose cursor arg is the previous page's next
 * token, last page terminal. Not same-args poll. Not a foreach over one array.
 */
export function inferCursorWalk(traces: StretchTrace[], tool: string, times: number): CursorWalk | null {
  if (times < 2 || traces.length === 0) return null;
  let agreed: CursorWalk | null = null;
  for (const t of traces) {
    const pages = okNamed(t, tool);
    if (pages.length < 2) return null;
    const nextPath = findNextPath(pages);
    if (!nextPath) return null;
    const cursorArg = findCursorArg(pages, nextPath);
    if (!cursorArg) return null;
    const itemsPath = findItemsPath(pages);
    if (!itemsPath) return null;
    const until = untilExpr(pages, nextPath);
    if (!until) return null;
    const initVals = traces.map((x) => (okNamed(x, tool)[0]?.args ?? {})[cursorArg]);
    const init: Binding = initVals.every(isSeedCursor)
      ? { kind: "literal", value: null }
      : { kind: "literal", value: initVals[0] };
    const row: CursorWalk = {
      until,
      maxIters: pages.length,
      cursorArg,
      nextPath,
      itemsPath,
      init,
    };
    if (!agreed) agreed = row;
    else if (
      agreed.cursorArg !== row.cursorArg ||
      agreed.nextPath !== row.nextPath ||
      agreed.itemsPath !== row.itemsPath ||
      agreed.until !== row.until
    ) {
      return null;
    } else {
      agreed.maxIters = Math.max(agreed.maxIters, row.maxIters);
    }
  }
  return agreed;
}

function findIncrementingArg(pages: TraceEvent[]): { key: string; delta: number } | null {
  if (pages.length < 2) return null;
  const keys = Object.keys(pages[0]!.args ?? {});
  const hits: Array<{ key: string; delta: number }> = [];
  for (const k of keys) {
    const nums = pages.map((p) => (p.args ?? {})[k]);
    if (!nums.every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    const ns = nums as number[];
    const delta = ns[1]! - ns[0]!;
    if (!(delta > 0) || !Number.isFinite(delta)) continue;
    if (!ns.every((v, i) => i === 0 || v - ns[i - 1]! === delta)) continue;
    hits.push({ key: k, delta });
  }
  return hits.length === 1 ? hits[0]! : null;
}

function findPageResultPath(pages: TraceEvent[], pageArg: string): string | null {
  const first = flattenPrimitive(pages[0]!.result);
  const hits: string[] = [];
  for (const [path, v] of first) {
    if (typeof v !== "number") continue;
    if (!pages.every((p) => eq(getPath(p.result, path), (p.args ?? {})[pageArg]))) continue;
    hits.push(path);
  }
  if (hits.length === 1) return hits[0]!;
  const named = hits.filter((h) => {
    const i = h.lastIndexOf(".");
    return (i < 0 ? h : h.slice(i + 1)) === pageArg;
  });
  return named.length === 1 ? named[0]! : (hits[0] ?? pageArg);
}

function pageItems(p: TraceEvent, itemsPath: string): unknown[] {
  const v = getPath(p.result, itemsPath);
  return Array.isArray(v) ? v : [];
}

function offsetUntilExpr(pages: TraceEvent[], itemsPath: string): string | null {
  const last = pages.at(-1)!;
  const rec =
    last.result && typeof last.result === "object" && !Array.isArray(last.result)
      ? (last.result as Record<string, unknown>)
      : null;
  if (rec) {
    const page = rec.page ?? rec.pageIndex;
    const total = rec.totalPages ?? rec.total_pages ?? rec.pages;
    if (typeof page === "number" && typeof total === "number" && page >= total) {
      const earlier = pages.slice(0, -1);
      if (
        earlier.every((p) => {
          const r = p.result as Record<string, unknown> | undefined;
          const pv = r?.page ?? r?.pageIndex;
          const tv = r?.totalPages ?? r?.total_pages ?? r?.pages;
          return typeof pv !== "number" || typeof tv !== "number" || pv < tv;
        })
      ) {
        const pageKey = "page" in rec ? "page" : "pageIndex";
        const totalKey = "totalPages" in rec ? "totalPages" : "total_pages" in rec ? "total_pages" : "pages";
        return `${pageKey} >= ${totalKey}`;
      }
    }
  }
  const lastItems = pageItems(last, itemsPath);
  if (lastItems.length === 0) return `${itemsPath}.length == 0`;
  const prev = pages.length >= 2 ? pageItems(pages[pages.length - 2]!, itemsPath).length : 0;
  if (prev > 0 && lastItems.length < prev) return `${itemsPath}.length < ${prev}`;
  return null;
}

function lastPageTerminal(pages: TraceEvent[], itemsPath: string): boolean {
  return offsetUntilExpr(pages, itemsPath) != null;
}

/**
 * Repeating list-page calls whose integer page/offset arg steps by a constant,
 * last page terminal (short page, empty items, or page >= totalPages).
 * Not a cursor token. Not same-args poll.
 */
export function inferOffsetWalk(traces: StretchTrace[], tool: string, times: number): OffsetWalk | null {
  if (times < 2 || traces.length === 0) return null;
  let agreed: OffsetWalk | null = null;
  for (const t of traces) {
    const pages = okNamed(t, tool);
    if (pages.length < 2) return null;
    const inc = findIncrementingArg(pages);
    if (!inc) return null;
    const itemsPath = findItemsPath(pages);
    if (!itemsPath) return null;
    if (!lastPageTerminal(pages, itemsPath)) return null;
    const until = offsetUntilExpr(pages, itemsPath);
    if (!until) return null;
    const pageResultPath = findPageResultPath(pages, inc.key);
    if (!pageResultPath) return null;
    const first = (pages[0]!.args ?? {})[inc.key];
    if (typeof first !== "number") return null;
    const row: OffsetWalk = {
      until,
      maxIters: pages.length,
      pageArg: inc.key,
      pageResultPath,
      delta: inc.delta,
      itemsPath,
      init: { kind: "literal", value: first - inc.delta },
    };
    if (!agreed) agreed = row;
    else if (
      agreed.pageArg !== row.pageArg ||
      agreed.pageResultPath !== row.pageResultPath ||
      agreed.itemsPath !== row.itemsPath ||
      agreed.until !== row.until ||
      agreed.delta !== row.delta
    ) {
      return null;
    } else {
      agreed.maxIters = Math.max(agreed.maxIters, row.maxIters);
    }
  }
  return agreed;
}

export function concatPageItems(t: StretchTrace, tool: string, itemsPath: string): unknown[] {
  return okNamed(t, tool).flatMap((e) => {
    const v = getPath(e.result, itemsPath);
    return Array.isArray(v) ? v : [];
  });
}

/** Stable field==value that selects exactly the taken subset. */
export function inferFilterPred(arr: unknown[], taken: unknown[]): string | null {
  if (taken.length < 2 || arr.length <= taken.length) return null;
  const takenSet = new Set(taken.map((x) => canonicalizeLoose(x)));
  const selected = arr.filter((x) => takenSet.has(canonicalizeLoose(x)));
  const rejected = arr.filter((x) => !takenSet.has(canonicalizeLoose(x)));
  if (selected.length !== taken.length || rejected.length === 0) return null;
  const fields = commonPrimitiveFields(selected);
  const hits: string[] = [];
  for (const f of fields) {
    const v0 = getPath(selected[0], f);
    if (v0 == null || typeof v0 === "object") continue;
    if (!selected.every((x) => eq(getPath(x, f), v0))) continue;
    if (!rejected.every((x) => !eq(getPath(x, f), v0))) continue;
    hits.push(predExpr(f, v0));
  }
  return hits.length === 1 ? hits[0]! : null;
}

function predExpr(field: string, v: unknown): string {
  if (typeof v === "string") return `${field} == ${JSON.stringify(v)}`;
  if (typeof v === "boolean" || typeof v === "number") return `${field} == ${v}`;
  return `${field} == ${JSON.stringify(v)}`;
}

function commonPrimitiveFields(items: unknown[]): string[] {
  if (!items.length) return [];
  const first = flattenPrimitive(items[0]!);
  const keys = [...first.keys()].filter((k) =>
    items.every((it) => {
      const v = getPath(it, k);
      return v != null && typeof v !== "object";
    }),
  );
  return keys;
}

function flattenPrimitive(v: unknown, prefix = "", depth = 0): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (v == null || typeof v !== "object" || Array.isArray(v) || depth > 3) {
    if (prefix) out.set(prefix, v);
    return out;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (val != null && typeof val === "object" && !Array.isArray(val)) {
      for (const [pk, pv] of flattenPrimitive(val, path, depth + 1)) out.set(pk, pv);
    } else if (val == null || typeof val !== "object") {
      out.set(path, val);
    }
  }
  return out;
}

function canonicalizeLoose(v: unknown): string {
  if (v && typeof v === "object" && !Array.isArray(v) && "id" in (v as object)) {
    return `id:${String((v as { id: unknown }).id)}`;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function itemsMatchTaken(arr: unknown[], taken: unknown[]): boolean {
  if (arr.length !== taken.length) return false;
  return taken.every((t, i) => eq(arr[i], t) || canonicalizeLoose(arr[i]) === canonicalizeLoose(t));
}

/** Equal-length pair of prior arrays walked lockstep. */
export function inferZipOver(
  t: StretchTrace,
  leftTool: string,
  rightTool: string,
  takenLeft: unknown[],
  takenRight: unknown[],
): { leftPath: string; rightPath: string } | null {
  if (leftTool === rightTool || takenLeft.length < 2 || takenLeft.length !== takenRight.length) return null;
  const leftEv = t.events.find((e) => e.ok && effectiveEventName(e) === leftTool);
  const rightEv = t.events.find((e) => e.ok && effectiveEventName(e) === rightTool);
  const lefts = collectArrays(leftEv?.result);
  const rights = collectArrays(rightEv?.result);
  const lhit = lefts.filter((a) => a.arr.length === takenLeft.length && itemsMatchTaken(a.arr, takenLeft));
  const rhit = rights.filter((a) => a.arr.length === takenRight.length && itemsMatchTaken(a.arr, takenRight));
  if (lhit.length !== 1 || rhit.length !== 1) return null;
  return { leftPath: lhit[0]!.path, rightPath: rhit[0]!.path };
}

export function chunkSizeFor(arr: unknown[], groups: unknown[][]): number | null {
  if (groups.length < 2 || arr.length < 4) return null;
  const n = groups[0]?.length;
  if (!n || n < 2) return null;
  if (groups.some((g) => g.length !== n && g !== groups.at(-1))) {
    const last = groups.at(-1)!;
    if (groups.slice(0, -1).some((g) => g.length !== n)) return null;
    if (last.length > n) return null;
  }
  const rebuilt: unknown[][] = [];
  for (let i = 0; i < arr.length; i += n) rebuilt.push(arr.slice(i, i + n));
  if (rebuilt.length !== groups.length) return null;
  if (!rebuilt.every((g, i) => itemsMatchTaken(g, groups[i]!))) return null;
  return n;
}

export function inferGroupKey(arr: unknown[], groups: Array<{ key?: unknown; items: unknown[] }>): string | null {
  if (groups.length < 2 || arr.length < 4) return null;
  const fields = commonPrimitiveFields(arr);
  for (const f of fields) {
    const map = new Map<string, unknown[]>();
    const order: string[] = [];
    for (const item of arr) {
      const k = canonicalizeLoose(getPath(item, f));
      if (!map.has(k)) {
        map.set(k, []);
        order.push(k);
      }
      map.get(k)!.push(item);
    }
    if (order.length !== groups.length) continue;
    let ok = true;
    for (let i = 0; i < order.length; i++) {
      const got = map.get(order[i]!)!;
      const want = groups[i]!.items;
      if (!itemsMatchTaken(got, want)) {
        ok = false;
        break;
      }
    }
    if (ok) return f;
  }
  return null;
}

export function lookupArg(
  haystack: unknown[],
  item: unknown,
  want: unknown,
): { joinField: string; itemPath: string; wantPath: string } | null {
  if (!haystack.length || item == null || typeof item !== "object") return null;
  const itemFields = flattenPrimitive(item);
  const hits: Array<{ joinField: string; itemPath: string; wantPath: string }> = [];
  for (const h of haystack) {
    if (!h || typeof h !== "object") continue;
    const hFields = flattenPrimitive(h);
    const wantPaths = [...hFields].filter(([, v]) => eq(v, want) || canonicalizeLoose(v) === canonicalizeLoose(want));
    if (!wantPaths.length) continue;
    for (const [joinField, hv] of hFields) {
      for (const [itemPath, iv] of itemFields) {
        if (!eq(hv, iv)) continue;
        const matched = haystack.filter((x) => eq(getPath(x, joinField), iv));
        if (matched.length !== 1) continue;
        for (const [wantPath] of wantPaths) {
          if (wantPath === joinField) continue;
          hits.push({ joinField, itemPath, wantPath });
        }
      }
    }
  }
  const uniq = hits.filter(
    (h, i, a) =>
      a.findIndex((x) => x.joinField === h.joinField && x.itemPath === h.itemPath && x.wantPath === h.wantPath) === i,
  );
  return uniq.length === 1 ? uniq[0]! : null;
}

/** Recursively collect leaves: nodes whose `key` array is missing or empty. */
export function collectLeaves(node: unknown, key: string, depth = 0): unknown[] {
  if (node == null || typeof node !== "object" || depth > 12) return [];
  const kids = getPath(node, key);
  if (!Array.isArray(kids) || kids.length === 0) return [node];
  return kids.flatMap((ch) => collectLeaves(ch, key, depth + 1));
}

function isRecursiveChildKey(node: unknown, key: string): boolean {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  const kids = (node as Record<string, unknown>)[key];
  if (!Array.isArray(kids) || !kids.length) return false;
  return kids.some((ch) => {
    if (!ch || typeof ch !== "object" || Array.isArray(ch)) return false;
    const nested = (ch as Record<string, unknown>)[key];
    return Array.isArray(nested);
  });
}

/** Nested objects with a recursive children-style key (not one-level concat). */
export function collectDeepTrees(
  result: unknown,
  prefix = "",
  depth = 0,
): Array<{ path: string; node: unknown; key: string }> {
  if (result == null || typeof result !== "object" || Array.isArray(result) || depth > 4) return [];
  const rec = result as Record<string, unknown>;
  const out: Array<{ path: string; node: unknown; key: string }> = [];
  for (const k of Object.keys(rec)) {
    if (isRecursiveChildKey(rec, k)) out.push({ path: prefix, node: rec, key: k });
  }
  for (const [k, v] of Object.entries(rec)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const childPath = prefix ? `${prefix}.${k}` : k;
      out.push(...collectDeepTrees(v, childPath, depth + 1));
    }
  }
  return out;
}
