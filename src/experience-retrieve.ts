/**
 * Experience retrieve (M24): this-turn cue → trajectory **file slices**.
 * Lexical + place (url/path) over `{memoryRoot}/experience/*.jsonl`.
 * Silent inject later merges these; this file does not format `[episode]`.
 *
 * Extra slice budget — not MCC k=40, not chat `EDEN_MEMORY_CAP` (6–10).
 * Default 3, hard max 10. Token-capped. Empty cue → [] (Start stays pins+gists).
 * Fail-open: never throw. Missing dir / torn lines → []. No `memory_search`.
 */
import { redact } from "../packages/ir/src/redact";
import { ExperienceStore, type ExperienceState, type ExperienceTraj } from "./experience-store";
import { scrubTombstonedIdentity } from "./gist-store";
import { scrubMemoryText } from "./memory-scrub";

/** Extra inject slots for file slices. Chat k stays 6–10. Not retrieve@40. */
export const EXPERIENCE_RETRIEVE_K = 3;
export const EXPERIENCE_RETRIEVE_K_MAX = 10;
export const EXPERIENCE_SLICE_TOKEN_CAP = 300;
/** ~300 tokens as chars (same budget as how-to / procedure). */
export const EXPERIENCE_SLICE_CHAR_CAP = EXPERIENCE_SLICE_TOKEN_CAP * 4;

export type ExperienceSlice = {
  id: string;
  text: string;
  t: number;
  url?: string;
  score: number;
  kind: "episode" | "procedure";
};

const STOP = new Set([
  "the",
  "of",
  "is",
  "a",
  "an",
  "on",
  "to",
  "and",
  "in",
  "for",
  "this",
  "that",
  "with",
  "from",
  "into",
  "about",
  "these",
  "then",
  "still",
  "has",
  "out",
  "please",
  "how",
  "should",
  "what",
  "why",
  "was",
  "are",
  "you",
  "your",
  "its",
  "our",
  "not",
  "never",
  "use",
  "used",
  "just",
  "last",
  "week",
  "down",
  "look",
  "next",
  "need",
  "before",
  "or",
  "no",
  "do",
  "does",
  "did",
  "can",
  "could",
  "would",
  "which",
  "where",
  "when",
  "who",
  "whom",
  "shown",
  "show",
  "page",
]);
/** AX chrome is not a place cell — "heading" must not pull every snapshot. */
const AX_SKIP = new Set([
  "heading",
  "button",
  "landmark",
  "rootwebarea",
  "role",
  "banner",
  "navigation",
  "main",
  "contentinfo",
  "complementary",
  "form",
  "img",
  "link",
  "text",
  "statictext",
  "submit",
  "click",
  "snapshot",
  "tree",
  "area",
  "web",
  "open",
]);

/** Keep hyphen/dot compounds (`change-request`, `auth.ts`) plus alphanumerics.
 *  Query may split compounds so `change-request` still hits `change`+`request` in hay.
 *  Hay must NOT split (`other-catalog` is not the token `catalog`). */
export function tokList(s: string, splitParts = true): string[] {
  const raw =
    String(s ?? "")
      .toLowerCase()
      .match(/[a-z0-9]+(?:[.-][a-z0-9]+)+|[a-z0-9]+/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (w: string) => {
    if (!w || seen.has(w)) return;
    seen.add(w);
    out.push(w);
  };
  for (const w of raw) {
    push(w);
    if (splitParts && (w.includes("-") || w.includes("."))) {
      for (const part of w.split(/[-.]+/)) {
        if (part.length >= 3) push(part);
      }
    }
  }
  return out;
}

function queryToks(cue: string): string[] {
  return tokList(cue).filter((w) => w.length >= 3 && !STOP.has(w) && !AX_SKIP.has(w) && !/^\d+$/.test(w));
}

function capK(k?: number): number {
  if (k === undefined) return EXPERIENCE_RETRIEVE_K;
  const n = Math.floor(Number(k));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(EXPERIENCE_RETRIEVE_K_MAX, n);
}

function asUrl(raw: string): URL | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    if (/^https?:\/\//i.test(s)) return new URL(s);
  } catch {}
  return null;
}

/** Place cells: path segments + hyphenated compounds + dotted files. Not bare hostnames. */
export function placeCues(text: string): Set<string> {
  const out = new Set<string>();
  const lower = String(text ?? "").toLowerCase();
  if (!lower.trim()) return out;
  for (const m of lower.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    const u = asUrl(m[0]!);
    if (!u) continue;
    for (const seg of u.pathname.split("/")) {
      const t = decodeURIComponentSafe(seg).toLowerCase();
      if (t.length >= 3) out.add(t);
    }
  }
  for (const m of lower.matchAll(/(?:^|[\s"'`(,:])((?:[a-z0-9_.-]+\/)+[a-z0-9_.-]*)/g)) {
    for (const seg of m[1]!.split("/")) {
      if (seg.length >= 3) out.add(seg.toLowerCase());
    }
  }
  for (const m of lower.matchAll(/[a-z0-9]+(?:-[a-z0-9]+)+/g)) out.add(m[0]!);
  for (const m of lower.matchAll(/[a-z0-9_-]+(?:\.[a-z]{1,5})+/g)) {
    const v = m[0]!.toLowerCase();
    if (v.length >= 3 && !/^(?:com|org|net|io|dev|test|local|example)$/.test(v.split(".").pop() || "")) {
      // dotted files (auth.ts), not example.test hosts
      if (/\.(ts|js|tsx|jsx|mjs|cjs|py|go|rs|md|json|jsonl|html|css|map|toml|yml|yaml)$/.test(v)) out.add(v);
    }
  }
  return out;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function stateHay(st: ExperienceState): string {
  return [st.url, st.action, st.thought, st.tree].filter((x) => typeof x === "string" && x).join("\n");
}

function trajHay(traj: ExperienceTraj): string {
  return traj.states.map(stateHay).filter(Boolean).join("\n");
}

function scrubState(st: ExperienceState): ExperienceState {
  const scrub = (s?: string): string | undefined => {
    if (typeof s !== "string" || !s) return s;
    let t = s;
    try {
      const r = redact(t);
      if (typeof r === "string") t = r;
    } catch {}
    try {
      t = scrubMemoryText(t);
    } catch {}
    return t;
  };
  const next: ExperienceState = { ...st };
  if (next.url) next.url = scrub(next.url) || next.url;
  if (next.action) next.action = scrub(next.action) || next.action;
  if (next.thought) next.thought = scrub(next.thought) || next.thought;
  if (next.tree) next.tree = scrub(next.tree) || next.tree;
  return next;
}

function scrubTraj(traj: ExperienceTraj): ExperienceTraj {
  return { ...traj, states: traj.states.map(scrubState) };
}

/** Presentation copy: tombstoned identity is not the current slice. Disk traj is unchanged. */
function withoutTombstone(traj: ExperienceTraj, dir: string): ExperienceTraj | null {
  try {
    const states: ExperienceState[] = [];
    for (const st of traj.states) {
      const next: ExperienceState = { ...st };
      for (const key of ["thought", "action", "goal", "outcome"] as const) {
        const v = next[key];
        if (typeof v !== "string" || !v.trim()) continue;
        let cleaned = v;
        try {
          cleaned = scrubTombstonedIdentity(v, dir);
        } catch {
          cleaned = v;
        }
        if (cleaned) next[key] = cleaned;
        else delete next[key];
      }
      const useful = [next.url, next.action, next.thought, next.tree, next.goal, next.outcome].some(
        (x) => typeof x === "string" && x.trim(),
      );
      if (useful) states.push(next);
    }
    if (!states.length) return null;
    return { ...traj, states };
  } catch {
    return traj;
  }
}

function overlap(qToks: string[], hay: string): number {
  if (!qToks.length || !hay) return 0;
  const toks = new Set(tokList(hay, false));
  const lower = hay.toLowerCase();
  let n = 0;
  for (const w of qToks) {
    if (toks.has(w)) n++;
    else if (w.length >= 8 && (w.includes("-") || w.includes(".")) && lower.includes(w)) n++;
  }
  return n;
}

function compoundHits(qToks: string[], hay: string): number {
  const lower = hay.toLowerCase();
  const toks = new Set(tokList(hay, false));
  let n = 0;
  for (const w of qToks) {
    if (!w.includes("-") && !w.includes(".")) continue;
    if (toks.has(w) || lower.includes(w)) n++;
  }
  return n;
}

function placeHits(qPlaces: Set<string>, hayPlaces: Set<string>): number {
  if (!qPlaces.size || !hayPlaces.size) return 0;
  let n = 0;
  for (const p of qPlaces) if (hayPlaces.has(p)) n++;
  return n;
}

function bestState(traj: ExperienceTraj, qToks: string[], qPlaces: Set<string>): ExperienceState | null {
  if (!traj.states.length) return null;
  let best: ExperienceState | null = null;
  let bestN = -1;
  let bestCompound = -1;
  let bestTree = false;
  for (const st of traj.states) {
    const hay = stateHay(st);
    const n = overlap(qToks, hay) + 3 * placeHits(qPlaces, placeCues(hay));
    const compound = compoundHits(qToks, hay);
    const hasTree = Boolean(st.tree && (overlap(qToks, st.tree) > 0 || compoundHits(qToks, st.tree) > 0));
    const better =
      n > bestN ||
      (n === bestN && compound > bestCompound) ||
      (n === bestN && compound === bestCompound && hasTree && !bestTree);
    if (better) {
      best = st;
      bestN = n;
      bestCompound = compound;
      bestTree = hasTree;
    }
  }
  return bestN > 0 ? best : (traj.states[traj.states.length - 1] ?? null);
}

function windowAround(hay: string, needles: string[], cap: number): string {
  const t = String(hay ?? "");
  if (!t) return "";
  if (t.length <= cap) return t;
  const lower = t.toLowerCase();
  let at = 0;
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  for (const n of ordered) {
    if (!n || n.length < 3) continue;
    const i = lower.indexOf(n);
    if (i >= 0) {
      at = i;
      break;
    }
  }
  const pad = Math.floor(cap / 5);
  const start = Math.max(0, at - pad);
  return t.slice(start, start + cap);
}

function sliceKind(_st: ExperienceState, _traj: ExperienceTraj): "episode" | "procedure" {
  // M24 file slices are episodes. How-to [procedure] is M25 (exit 0 + verify).
  return "episode";
}

function formatSlice(st: ExperienceState, qToks: string[]): string {
  const fields: { key: string; text: string; pri: number }[] = [];
  if (st.tree) fields.push({ key: "tree", text: st.tree, pri: 0 });
  if (st.url) fields.push({ key: "url", text: st.url, pri: 1 });
  if (st.action) fields.push({ key: "action", text: st.action, pri: 2 });
  if (st.thought) fields.push({ key: "thought", text: st.thought, pri: 3 });
  const scored = fields.map((f) => {
    const hit = overlap(qToks, f.text) + compoundHits(qToks, f.text);
    return { ...f, hit };
  });
  scored.sort((a, b) => (b.hit > 0 ? 1 : 0) - (a.hit > 0 ? 1 : 0) || a.pri - b.pri);
  let text = "";
  for (const f of scored) {
    if (!f.hit && text) continue; // unmatched thought/action must not evict the gold window
    const chunk = windowAround(f.text, qToks, EXPERIENCE_SLICE_CHAR_CAP);
    if (!chunk) continue;
    const next = text ? `${text} · ${chunk}` : chunk;
    if (next.length > EXPERIENCE_SLICE_CHAR_CAP) {
      if (!text) text = chunk.slice(0, EXPERIENCE_SLICE_CHAR_CAP);
      break;
    }
    text = next;
  }
  return text.trim();
}

function latestT(traj: ExperienceTraj): number {
  let t = 0;
  for (const st of traj.states) {
    if (typeof st.t === "number" && Number.isFinite(st.t) && st.t > t) t = st.t;
  }
  return t;
}

/**
 * Rank traj files by lexical overlap + url/path place. ≤k token-capped slices.
 * Empty cue / missing dir / throw → [].
 */
export function retrieveExperience(dir: string, cue: string, opts?: { k?: number }): ExperienceSlice[] {
  try {
    const q = String(cue ?? "").trim();
    if (!q) return [];
    const k = capK(opts?.k);
    if (!k) return [];
    const qToks = queryToks(q);
    const qPlaces = placeCues(q);
    if (!qToks.length && !qPlaces.size) return [];
    const store = new ExperienceStore(dir);
    const ids = store.ids();
    if (!Array.isArray(ids) || !ids.length) return [];
    const ranked: { traj: ExperienceTraj; score: number; st: ExperienceState; compounds: number; place: number }[] = [];
    for (const id of ids) {
      try {
        const loaded = store.get(id);
        if (!loaded || !loaded.states.length) continue;
        const scrubbed = scrubTraj(loaded);
        const traj = withoutTombstone(scrubbed, dir);
        if (!traj || !traj.states.length) continue;
        const hay = trajHay(traj);
        const lex = overlap(qToks, hay);
        const place = placeHits(qPlaces, placeCues(hay));
        const compounds = compoundHits(qToks, hay);
        const score = lex + 3 * place;
        if (score <= 0) continue;
        const st = bestState(traj, qToks, qPlaces);
        if (!st) continue;
        ranked.push({ traj, score, st, compounds, place });
      } catch {
        // Skip one torn file.
      }
    }
    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        b.compounds - a.compounds ||
        latestT(b.traj) - latestT(a.traj) ||
        a.traj.id.localeCompare(b.traj.id),
    );
    const best = ranked[0]?.score ?? 0;
    const floor = best > 0 ? Math.max(1, Math.ceil(best * 0.5)) : 1;
    const out: ExperienceSlice[] = [];
    for (const hit of ranked) {
      if (out.length >= k) break;
      if (hit.score < floor) continue;
      if (ranked[0] && ranked[0].compounds > 0 && hit.compounds === 0 && hit.place === 0) continue;
      let text = formatSlice(hit.st, qToks);
      try {
        text = scrubTombstonedIdentity(text, dir);
      } catch {}
      if (!text) continue;
      const row: ExperienceSlice = {
        id: hit.traj.id,
        text,
        t: typeof hit.st.t === "number" && Number.isFinite(hit.st.t) ? hit.st.t : latestT(hit.traj),
        score: hit.score,
        kind: sliceKind(hit.st, hit.traj),
      };
      if (hit.st.url) row.url = hit.st.url;
      out.push(row);
    }
    return out;
  } catch {
    return [];
  }
}
