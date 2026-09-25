/**
 * Ambitious retrieve experiments. Default inject is unchanged unless
 * EDEN_MEMORY_X is set. Fail-open: throw → caller uses relevant().
 *
 * Strategies (comma-separated):
 *   cluster    — login↔auth CUE_LEX expansion before rank
 *   ripple     — CA3/RippleMem: second pass from tokens of first hits
 *   union      — still merge howto + experience after sf-assemble / gist routes
 *   identity   — live semantic + pins on every non-math cue (core memory)
 *   fat        — token/char budget instead of dropping the 2nd fact at k=6
 *   mathsilent — omit only math/chatter; do not MIN-silence a weak but real cue
 *   nofilter   — do not drop wrap rows because hook set project=cwd hash
 *   aurora     — all of the above
 *
 * Not a memory_search tool. Not BrainMemory. No network embed.
 */
import { retrieveExperience } from "./experience-retrieve";
import { retrieveHowTo } from "./howto-retrieve";
import { SemanticStore } from "./semantic-store";

/** Structural copy of product MemoryRecord — do not import src/index.ts (cycle). */
type MemoryRecord = {
  id: string;
  text: string;
  kind: string;
  tags: string[];
  at: number;
  sal?: number;
  lane?: string;
  ep?: string;
};

export const MEMORY_X_FAT_CHARS = 2400;

const CLUSTER: Record<string, string> = {
  login: "auth authentication clerk permission session sso",
  signin: "auth authentication login clerk",
  flake: "test fail intermittent auth.test",
  db: "database sqlite postgres sql",
  database: "sqlite postgres sql db",
  provider: "auth clerk authentication",
};

export type XMem = {
  relevant(text: string, cap?: number, fuse?: boolean): MemoryRecord[];
  memories(): MemoryRecord[];
  dir: string;
  howtoDir: string;
};

export function memoryXRaw(): string {
  try {
    return String(process.env.EDEN_MEMORY_X ?? "").trim();
  } catch {
    return "";
  }
}

export function memoryXParts(): Set<string> {
  const raw = memoryXRaw().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "none") return new Set();
  if (raw === "aurora" || raw === "all" || raw === "1" || raw === "on") {
    return new Set(["cluster", "ripple", "union", "identity", "fat", "mathsilent", "nofilter"]);
  }
  if (!raw || raw === "default") {
    return new Set(["cluster", "identity", "fat", "mathsilent"]);
  }
  return new Set(raw.split(/[,\s]+/).filter(Boolean));
}

export function memoryXOn(): boolean {
  return memoryXParts().size > 0;
}

export function memoryXHas(name: string): boolean {
  return memoryXParts().has(name);
}

export function memoryXFat(): boolean {
  return memoryXHas("fat");
}

export function memoryXMathSilent(): boolean {
  return memoryXHas("mathsilent");
}

export function memoryXNofilter(): boolean {
  return memoryXHas("nofilter");
}

/** Pure arithmetic / thanks / asdf. Project words force not-math. */
export function isMathChatterCue(cue: string): boolean {
  try {
    const t = String(cue ?? "").trim();
    if (!t) return false;
    if (/\b(?:auth|sqlite|postgres|clerk|flake|commit|test|database|provider|session|file|src\/|\.ts|\.py|adr)\b/i.test(t)) {
      return false;
    }
    const lower = t.toLowerCase();
    if (/^(?:ok|okay|thanks|thank you|lol|lmao|asdf|qwerty|hi|hey|yo)\s*[.!?]?\s*$/i.test(lower)) return true;
    if (/^\s*(?:what(?:'s| is)\s+)?\d+\s*(?:\+|plus|\-|minus|\*|x|×|times|\/|÷|divided by)\s*\d+\s*\??\s*$/i.test(lower)) {
      return true;
    }
    if (/\b(?:times|plus|minus|divided by)\b/.test(lower) && /\d/.test(lower) && lower.split(/\s+/).length <= 8) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function expandClusters(cue: string): string {
  const toks = cue.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const extra: string[] = [];
  for (const t of toks) {
    const add = CLUSTER[t];
    if (add) extra.push(add);
  }
  return extra.length ? `${cue} ${extra.join(" ")}` : cue;
}

function contentToks(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !/^(this|that|with|from|have|been|were|they|them|then|than|what|when|which|your|into|just|only|about)$/.test(w));
}

function unionById(a: MemoryRecord[], b: MemoryRecord[]): MemoryRecord[] {
  const out = a.slice();
  const seen = new Set(a.map((r) => r.id));
  for (const r of b) {
    if (!r || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

function identityRows(mem: XMem, cue: string): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  try {
    const live = new SemanticStore(mem.dir).live();
    for (const row of live) {
      const s = String(row.s ?? "").trim();
      const p = String(row.p ?? "").trim() || "is";
      const o = String(row.o ?? "").trim();
      if (!s || !o) continue;
      out.push({
        id: `sem:${s}:${p}`,
        text: `${s} ${p} ${o}`.replace(/\s+/g, " "),
        kind: "fact",
        lane: "chat",
        tags: ["fact", "semantic", "x-identity"],
        at: Number.isFinite(row.t) ? row.t : 0,
      });
    }
  } catch {}
  try {
    for (const r of mem.memories()) {
      const tags = r.tags ?? [];
      if (r.kind === "constraint" || tags.includes("pin") || tags.includes("always")) out.push(r);
    }
  } catch {}
  void cue;
  return out;
}

function unionLanes(mem: XMem, cue: string, lexical: MemoryRecord[]): MemoryRecord[] {
  let out = lexical;
  try {
    const views = retrieveHowTo(mem.howtoDir, cue);
    for (const view of views ?? []) {
      if (!view?.id) continue;
      const files = Array.isArray(view.files) ? view.files.filter((f) => typeof f === "string").join(" ") : "";
      const verify = typeof view.verify === "string" ? view.verify : "";
      const text = [view.cue, files && `→ ${files}`, verify && `· verify: ${verify}`].filter(Boolean).join(" ");
      out = unionById(out, [{
        id: view.id,
        text: text || view.cue || view.id,
        kind: "procedure",
        tags: ["howto", "procedure"],
        at: view.t ?? 0,
        sal: 0,
      }]);
    }
  } catch {}
  try {
    const hits = retrieveExperience(mem.dir, cue);
    for (const hit of hits ?? []) {
      const body = String(hit?.text ?? "").trim();
      if (!body) continue;
      out = unionById(out, [{
        id: `exp:${hit.id}`,
        text: body,
        kind: "episode",
        lane: "trajectory",
        tags: ["experience", "trajectory"],
        at: Number.isFinite(hit.t) ? hit.t : 0,
      }]);
    }
  } catch {}
  return out;
}

function ripple(mem: XMem, cue: string, first: MemoryRecord[], cap: number): MemoryRecord[] {
  try {
    const bag = new Set<string>();
    for (const r of first.slice(0, 4)) for (const w of contentToks(r.text)) bag.add(w);
    for (const w of contentToks(cue)) bag.delete(w);
    const extra = [...bag].slice(0, 12);
    if (!extra.length) return first;
    const second = mem.relevant(`${cue} ${extra.join(" ")}`, cap);
    return unionById(first, second);
  } catch {
    return first;
  }
}

function sameEpisode(mem: XMem, first: MemoryRecord[]): MemoryRecord[] {
  try {
    const eps = new Set(first.map((r) => r.ep).filter(Boolean) as string[]);
    if (!eps.size) return first;
    const extra = mem.memories().filter((r) => r.ep && eps.has(r.ep));
    return unionById(first, extra);
  } catch {
    return first;
  }
}

export function retrieveX(mem: XMem, text: string, cap: number, fuse = true): MemoryRecord[] {
  const cue0 = String(text ?? "").trim();
  if (!cue0) return mem.relevant(text, cap, fuse);
  const cue = memoryXHas("cluster") ? expandClusters(cue0) : cue0;
  // Do not swallow relevant() — inject fail-open requires the throw to surface.
  let recs = mem.relevant(cue, cap, fuse);
  if (memoryXHas("ripple")) recs = ripple(mem, cue, recs, cap);
  recs = sameEpisode(mem, recs);
  if (memoryXHas("union")) recs = unionLanes(mem, cue, recs);
  if (memoryXHas("identity")) recs = unionById(identityRows(mem, cue), recs);
  return recs;
}

/** Fat packet: identity/rules first, then the rest, up to MEMORY_X_FAT_CHARS. */
export function fatPacket(recs: MemoryRecord[], k: number): MemoryRecord[] {
  try {
    const list = Array.isArray(recs) ? recs : [];
    const ident = list.filter((r) => r.kind === "constraint" || (r.tags ?? []).includes("x-identity") || (r.tags ?? []).includes("semantic"));
    const rest = list.filter((r) => !ident.includes(r));
    const ordered = [...ident, ...rest];
    const out: MemoryRecord[] = [];
    let chars = 0;
    const floor = Math.max(1, Math.floor(Number(k) || 6));
    for (const r of ordered) {
      const n = String(r.text ?? "").length;
      if (out.length >= floor && chars + n > MEMORY_X_FAT_CHARS) continue;
      out.push(r);
      chars += n;
      if (chars >= MEMORY_X_FAT_CHARS && out.length >= floor) break;
    }
    return out.length ? out : list.slice(0, floor);
  } catch {
    return Array.isArray(recs) ? recs : [];
  }
}
