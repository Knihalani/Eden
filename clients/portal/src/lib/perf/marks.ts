/** F82 — portal performance marks (queryable in dogfood via Performance API). */

export type EdenPerfMark =
  | "eden:page"
  | "eden:table_query"
  | "eden:panel_open";

const MARK_STORE_KEY = "__eden_perf_marks";

type MarkEntry = { name: EdenPerfMark; detail?: string; at: number };

/** Module-level fallback so marks work in vitest/node (no `window`). */
let moduleStore: MarkEntry[] = [];

function getStore(): MarkEntry[] {
  if (typeof window === "undefined") return moduleStore;
  const w = window as Window & { [MARK_STORE_KEY]?: MarkEntry[] };
  if (!w[MARK_STORE_KEY]) w[MARK_STORE_KEY] = [];
  return w[MARK_STORE_KEY];
}

function storeMark(entry: MarkEntry): void {
  const list = getStore();
  list.push(entry);
  if (list.length > 200) list.shift();
  if (typeof window === "undefined") {
    moduleStore = list;
  }
}

export function markEden(name: EdenPerfMark, detail?: string): void {
  const now =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    const label = detail ? `${name}:${detail}` : name;
    try {
      performance.mark(label);
    } catch {
      // duplicate mark names are fine to ignore
    }
  }
  storeMark({ name, detail, at: now });
}

export function measureEden(
  name: EdenPerfMark,
  startMark: string,
  endMark?: string,
): number | null {
  if (typeof performance === "undefined") return null;
  const end = endMark ?? `${name}:end`;
  try {
    performance.mark(end);
    const m = performance.measure(name, startMark, end);
    return m.duration;
  } catch {
    return null;
  }
}

export function readEdenMarks(): MarkEntry[] {
  return [...getStore()];
}

export function clearEdenMarks(): void {
  if (typeof window === "undefined") {
    moduleStore = [];
    return;
  }
  const w = window as Window & { [MARK_STORE_KEY]?: MarkEntry[] };
  w[MARK_STORE_KEY] = [];
  moduleStore = [];
}
