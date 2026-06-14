/**
 * localStorage adapter for the builder.
 *
 * Keys:
 *   - ``eden.builder.graph``     → the active ``SavedGraph`` (the
 *     one the canvas is currently showing).
 *   - ``eden.builder.saved``     → a ``Map<graphName, SavedGraph>``
 *     of every saved graph, LRU-capped at 5 by ``updatedAt``.
 *     Powers the "Recent ▾" dropdown.
 *   - ``eden.builder.recent``    → a ``SavedGraphMeta[]`` for the
 *     dropdown's fast-path list (no need to hydrate full graphs).
 *   - ``eden.builder.agentId.<graphName>`` → the backend
 *     ``agent_id`` to re-use for the next push of this graph.
 *
 * Every read/write is wrapped in try/catch so private-mode
 * ``QuotaExceededError``, corrupt JSON, and missing
 * ``window.localStorage`` (SSR) all degrade silently to a
 * no-op rather than crashing the page.
 */

import type { SavedGraph, SavedGraphMeta } from "@/lib/types";

const KEY_ACTIVE = "eden.builder.graph";
const KEY_SAVED = "eden.builder.saved";
const KEY_RECENT = "eden.builder.recent";
const KEY_AGENT_ID = (name: string) => `eden.builder.agentId.${name}`;

const MAX_SAVED = 5;
const SAVE_DEBOUNCE_MS = 500;

type SavedMap = Record<string, SavedGraph>;

function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // QuotaExceededError or private-mode — silently ignore. The
    // page keeps working in-memory; the user just loses
    // persistence for this session.
  }
}

function safeRemove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function safeJson<T>(s: string | null, fallback: T): T {
  if (s === null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// ── Active graph ───────────────────────────────────────────────────

export function loadGraph(): SavedGraph | null {
  return safeJson<SavedGraph | null>(safeGet(KEY_ACTIVE), null);
}

export function writeGraph(g: SavedGraph): void {
  safeSet(KEY_ACTIVE, JSON.stringify(g));
}

// Debounced write — coalesce a burst of state changes into one
// localStorage write 500ms after the last one.
let _debounceHandle: ReturnType<typeof setTimeout> | null = null;
let _pending: SavedGraph | null = null;

export function saveGraphDebounced(g: SavedGraph): void {
  _pending = g;
  if (_debounceHandle !== null) clearTimeout(_debounceHandle);
  _debounceHandle = setTimeout(() => {
    if (_pending) writeGraph(_pending);
    _pending = null;
    _debounceHandle = null;
  }, SAVE_DEBOUNCE_MS);
}

/** Flush any pending debounced write immediately. */
export function flushGraph(): void {
  if (_debounceHandle !== null) {
    clearTimeout(_debounceHandle);
    _debounceHandle = null;
  }
  if (_pending) writeGraph(_pending);
  _pending = null;
}

// ── Saved map (Recent ▾) ───────────────────────────────────────────

function readSavedMap(): SavedMap {
  return safeJson<SavedMap>(safeGet(KEY_SAVED), {});
}

function writeSavedMap(m: SavedMap): void {
  safeSet(KEY_SAVED, JSON.stringify(m));
}

function pruneToLru(m: SavedMap): SavedMap {
  const entries = Object.entries(m);
  if (entries.length <= MAX_SAVED) return m;
  entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const trimmed = entries.slice(entries.length - MAX_SAVED);
  return Object.fromEntries(trimmed);
}

export function persistGraph(g: SavedGraph): void {
  // 1. update the saved-map
  const m = readSavedMap();
  m[g.graphName] = g;
  writeSavedMap(pruneToLru(m));

  // 2. update the recent-meta list
  const meta: SavedGraphMeta = {
    graphName: g.graphName,
    updatedAt: g.updatedAt,
    summary: deriveSummary(g),
  };
  pushRecent(meta);

  // 3. mirror to active
  writeGraph(g);
}

/** Push a meta entry to the top of the recent list (LRU-capped). */
export function pushRecent(meta: SavedGraphMeta): void {
  const list = safeJson<SavedGraphMeta[]>(safeGet(KEY_RECENT), []);
  const without = list.filter((m) => m.graphName !== meta.graphName);
  const next = [meta, ...without].slice(0, MAX_SAVED);
  safeSet(KEY_RECENT, JSON.stringify(next));
}

export function listRecent(): SavedGraphMeta[] {
  return safeJson<SavedGraphMeta[]>(safeGet(KEY_RECENT), []);
}

export function listSaved(): SavedGraph[] {
  const m = readSavedMap();
  return Object.values(m).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadSavedByName(name: string): SavedGraph | null {
  const m = readSavedMap();
  return m[name] ?? null;
}

export function deleteSaved(name: string): void {
  const m = readSavedMap();
  delete m[name];
  writeSavedMap(m);
  const list = safeJson<SavedGraphMeta[]>(safeGet(KEY_RECENT), []).filter(
    (x) => x.graphName !== name,
  );
  safeSet(KEY_RECENT, JSON.stringify(list));
  safeRemove(KEY_AGENT_ID(name));
}

export function clearAll(): void {
  // Read first — once we remove the maps, we lose the names of
  // the per-graph agentId keys we need to wipe.
  const saved = readSavedMap();
  const active = safeJson<SavedGraph | null>(safeGet(KEY_ACTIVE), null);
  const names = new Set<string>(Object.keys(saved));
  if (active) names.add(active.graphName);

  safeRemove(KEY_ACTIVE);
  safeRemove(KEY_SAVED);
  safeRemove(KEY_RECENT);
  for (const name of names) safeRemove(KEY_AGENT_ID(name));
}

// ── Per-graph agent_id cache ───────────────────────────────────────

export function rememberAgentId(name: string, agentId: string): void {
  safeSet(KEY_AGENT_ID(name), agentId);
}

export function lookupAgentId(name: string): string | null {
  return safeGet(KEY_AGENT_ID(name));
}

// ── Helpers ────────────────────────────────────────────────────────

function deriveSummary(g: SavedGraph): SavedGraphMeta["summary"] {
  const nodes = g.nodes as Array<{ data?: { kind?: string; value?: number } }>;
  const agents = nodes.filter((n) => n.data?.kind === "agent").length;
  const tools = nodes.filter((n) => n.data?.kind === "tool").length;
  const scenarios = nodes.filter((n) => n.data?.kind === "scenario").length;
  const seedNode = nodes.find((n) => n.data?.kind === "seed");
  return {
    agents,
    tools,
    scenarios,
    ...(seedNode && typeof seedNode.data?.value === "number"
      ? { seed: seedNode.data.value }
      : {}),
  };
}
