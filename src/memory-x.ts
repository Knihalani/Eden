/**
 * Product retrieve extras: identity floor, fat packet, math/chatter silence.
 * EDEN_MEMORY_X=0|off|none disables (kill switch). Fail-open: relevant() throw surfaces.
 * Not a memory_search tool. Not BrainMemory. No network embed.
 */
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

export type XMem = {
  relevant(text: string, cap?: number, fuse?: boolean): MemoryRecord[];
  memories(): MemoryRecord[];
  dir: string;
  howtoDir: string;
};

export function memoryXOn(): boolean {
  try {
    const raw = String(process.env.EDEN_MEMORY_X ?? "").trim().toLowerCase();
    return raw !== "0" && raw !== "off" && raw !== "none";
  } catch {
    return true;
  }
}

export function memoryXFat(): boolean {
  return memoryXOn();
}

export function memoryXMathSilent(): boolean {
  return memoryXOn();
}

export function memoryXNofilter(): boolean {
  return false;
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

function identityRows(mem: XMem): MemoryRecord[] {
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
  return out;
}

export function retrieveX(mem: XMem, text: string, cap: number, fuse = true): MemoryRecord[] {
  const cue0 = String(text ?? "").trim();
  if (!cue0) return mem.relevant(text, cap, fuse);
  const recs = mem.relevant(cue0, cap, fuse);
  return unionById(identityRows(mem), recs);
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
