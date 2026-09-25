/**
 * Product retrieve extras: fat packet + math/chatter silence.
 * Identity floor lives on AgentMemory.notesFor. EDEN_MEMORY_X=0|off|none kills.
 * Fail-open: relevant() throw surfaces. Not BrainMemory. No network embed.
 */

export const MEMORY_X_FAT_CHARS = 2400;

export function memoryXOn(): boolean {
  try {
    const raw = String(process.env.EDEN_MEMORY_X ?? "").trim().toLowerCase();
    return raw !== "0" && raw !== "off" && raw !== "none";
  } catch {
    return true;
  }
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

type FatRec = { id?: string; text?: string; kind?: string; tags?: string[] };

/** Fat packet: identity/rules first, then the rest, up to MEMORY_X_FAT_CHARS. */
export function fatPacket<T extends FatRec>(recs: T[], k: number): T[] {
  try {
    const list = Array.isArray(recs) ? recs : [];
    const ident = list.filter((r) => r.kind === "constraint" || (r.tags ?? []).includes("x-identity") || (r.tags ?? []).includes("semantic"));
    const rest = list.filter((r) => !ident.includes(r));
    const ordered = [...ident, ...rest];
    const out: T[] = [];
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
