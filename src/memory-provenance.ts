/**
 * M40.1 packet provenance: `[fact · 3h · user]` / `[procedure · verified]`.
 * Relative age + source only. Never cwd / email / session_id / paths.
 */
import { memoryNow } from "./memory-clock";
import type { RuleRef } from "./memory-policy";
import type { SlotRef } from "./memory-slots";

export const PACKET_KIND = "rule|fact|episode|gist|procedure";
/** Matches `[fact]`, `[fact · 3h · user]`, `[fact | 3h | user]`, `[procedure · verified]`. */
export const PACKET_LABEL_RE = new RegExp(`^(\\s*\\[(?:${PACKET_KIND})(?:\\s*[·|][^\\]]*)?\\]\\s*)`, "i");
const PACKET_KIND_RE = new RegExp(`^\\s*\\[(${PACKET_KIND})(?:\\s*[·|][^\\]]*)?\\]`, "i");

export type MemoryProvenanceSrc = "user" | "tool" | "sleep";

export type ProvenanceNote = {
  id?: string;
  text?: string;
  kind?: string;
  tags?: string[];
  lane?: string;
  at?: number;
  /**
   * An `Updated:` item (A4 §4): the window was given this item's earlier value, named when the store logged it, and
   * the slot entry its delivery renews (`memory-ledger.ts`).
   */
  update?: { was?: string; renews?: { cid: string; ver: string; rule: boolean; sw?: string[] } };
  /** D9: the rules a rule row states, by key (`memory-policy.ts`). */
  rules?: readonly RuleRef[];
  /** D7: the slots a slot row states, by key (`memory-slots.ts`). */
  slots?: readonly SlotRef[];
  /** Where in the repo the row is true (A4 §1, D3); absent on a row written before P3.2 placed encoded rows. */
  scope?: string;
  /** The rows a two-scope bullet shows (`memory-place.ts`): what the ledger records for it (A4 §4). */
  parts?: readonly ProvenanceNote[];
};

/** Times are epoch ms (~1.7e12); a smaller number is a list serial a store from before P0.3 kept, not a time. */
const LEGACY_SERIAL = 1e11;

/** How long ago a row was written ("3h"); undefined for a row whose time was never kept (A1 D6: no "0m" claim). */
export function relativeMemoryAge(at: number | undefined, now = memoryNow()): string | undefined {
  try {
    const t = Number(at);
    if (!Number.isFinite(t) || t < LEGACY_SERIAL) return undefined;
    const ms = Math.max(0, now - t);
    const m = Math.floor(ms / 60_000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d`;
    return `${Math.floor(d / 7)}w`;
  } catch {
    return undefined;
  }
}

export function stripPacketLabel(text: string): { label: string; body: string } {
  let raw = String(text ?? "");
  let label = "";
  try {
    for (let i = 0; i < 8; i++) {
      const m = raw.match(PACKET_LABEL_RE);
      if (!m || m[0].length === 0) break;
      label += m[1]!;
      const next = raw.slice(m[0].length);
      if (next === raw) break;
      raw = next;
    }
  } catch {}
  return { label, body: raw };
}

export function noteKindToken(r: ProvenanceNote, text = String(r.text ?? "")): string | undefined {
  try {
    const kind = String(r.kind ?? "").toLowerCase();
    if (kind === "constraint") return "rule";
    if (kind === "digest" || kind === "gist") return "gist";
    if (kind === "episode") return "episode";
    if (kind === "fact" || kind === "preference") return "fact";
    if (kind === "procedure") return "procedure";
    const tags = (r.tags ?? []).map((t) => String(t).toLowerCase());
    if (tags.some((t) => t === "gist" || t === "digest")) return "gist";
    if (tags.some((t) => t === "howto" || t === "procedure")) return "procedure";
    const m = String(text ?? "").match(PACKET_KIND_RE);
    return m?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The sources of text the user did not type (A6 §2.1): their rows are episodes only (A4 §3.0). */
const UNTYPED_SOURCES = new Set(["src:tool", "src:agent", "src:paste", "src:legacy"]);

/** Whether a row's source shows the user did not type it. A row with no `src` (written before P0.4) does not. */
export function isUntyped(r: ProvenanceNote): boolean {
  return (r.tags ?? []).some((tag) => UNTYPED_SOURCES.has(tag));
}

/** A note's source when the note shows it, else undefined: a row with no `src` makes no authority claim (A6 §2.1). */
export function knownNoteSource(r: ProvenanceNote): MemoryProvenanceSrc | undefined {
  try {
    const tags = (r.tags ?? []).map((t) => String(t).toLowerCase());
    // Content tokens ("sleep", "tool", "gist") are not a source. observe()
    // stores those words as tags. Only kind, lane, and explicit src:* count.
    if (tags.includes("src:user")) return "user";
    if (tags.includes("src:sleep")) return "sleep";
    if (tags.includes("src:tool")) return "tool";
    const kind = String(r.kind ?? "").toLowerCase();
    const lane = String(r.lane ?? "").toLowerCase();
    if (kind === "digest" || kind === "gist") return "sleep";
    if (kind === "procedure" || lane === "trajectory") return "tool";
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `[kind · age · src]` tag's source: the known one, else `user`, except for a row whose source shows the user did
 * not type it (A6 §2.1, §2.6: the agent's or a paste's text is never "user"), which claims none.
 */
export function noteSource(r: ProvenanceNote): MemoryProvenanceSrc | undefined {
  return knownNoteSource(r) ?? (isUntyped(r) ? undefined : "user");
}

function procedureVerified(r: ProvenanceNote, body: string): boolean {
  // `howto` is the lane tag, not proof. A gap (`unknown:`) must not say verified,
  // even when the packet also renders `verify:` from a schema-renamed cmd.
  const hay = `${body}\n${String(r.text ?? "")}`;
  if (/unknown:/i.test(hay)) return false;
  if (/verify:/i.test(hay)) return true;
  return (r.tags ?? []).some((t) => String(t).toLowerCase() === "verified");
}

/** Bracket only. Fail-open to `[kind]` if age/source throws. */
export function provenanceBracket(r: ProvenanceNote, kind: string, body?: string): string {
  try {
    const k = String(kind || "fact").toLowerCase();
    const bare = stripPacketLabel(body ?? String(r.text ?? "")).body;
    if (k === "procedure" && procedureVerified(r, bare)) return "[procedure · verified]";
    return `[${[k, relativeMemoryAge(r.at), noteSource(r)].filter(Boolean).join(" · ")}]`;
  } catch {
    return `[${kind || "fact"}]`;
  }
}

/** Bracket for one note. Hook briefing can reuse this. Fail-open to `[kind]`. */
export function packetKindLabel(r: ProvenanceNote, text?: string): string | undefined {
  try {
    const kind = noteKindToken(r, text ?? r.text);
    if (!kind) return undefined;
    return provenanceBracket(r, kind, text ?? r.text);
  } catch {
    try {
      const kind = noteKindToken(r, text ?? r.text);
      return kind ? `[${kind}]` : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Apply / rewrite a provenance label. Does not put cwd, email, session_id, or paths in the bracket. */
export function applyProvenanceLabel<T extends ProvenanceNote>(r: T, body: string): string {
  try {
    const stripped = stripPacketLabel(body).body;
    const kind = noteKindToken(r, body) ?? noteKindToken(r, stripped);
    if (!kind) return stripped || body;
    return `${provenanceBracket(r, kind, stripped)} ${stripped}`.trim();
  } catch {
    try {
      const stripped = stripPacketLabel(body).body;
      const kind = noteKindToken(r, body);
      return kind ? `[${kind}] ${stripped}`.trim() : stripped || body;
    } catch {
      return body;
    }
  }
}
