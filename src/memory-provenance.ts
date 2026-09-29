/**
 * M40.1 packet provenance: `[fact · 3h · user]` / `[procedure · verified]`.
 * Relative age + source only. Never cwd / email / session_id / paths.
 */
export const PACKET_KIND = "rule|fact|episode|gist|procedure";
/** Matches `[fact]`, `[fact · 3h · user]`, `[fact | 3h | user]`, `[procedure · verified]`. */
export const PACKET_LABEL_RE = new RegExp(
  `^(\\s*\\[(?:${PACKET_KIND})(?:\\s*[·|][^\\]]*)?\\]\\s*)`,
  "i",
);
const PACKET_KIND_RE = new RegExp(`^\\s*\\[(${PACKET_KIND})(?:\\s*[·|][^\\]]*)?\\]`, "i");

export type MemoryProvenanceSrc = "user" | "tool" | "sleep";

export type ProvenanceNote = {
  id?: string;
  text?: string;
  kind?: string;
  tags?: string[];
  lane?: string;
  at?: number;
};

/** Wall-clock `at` is Date.now() (~1e12). Serial t=8 is not an age. */
const WALL_CLOCK_AT = 1e11;

export function relativeMemoryAge(at: number, now = Date.now()): string {
  try {
    const t = Number(at);
    if (!Number.isFinite(t) || t < WALL_CLOCK_AT) return "0m";
    const ms = Math.max(0, now - t);
    const m = Math.floor(ms / 60_000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d`;
    return `${Math.floor(d / 7)}w`;
  } catch {
    return "0m";
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

export function noteSource(r: ProvenanceNote): MemoryProvenanceSrc {
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
    return "user";
  } catch {
    return "user";
  }
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
    const at = typeof r.at === "number" && Number.isFinite(r.at) ? r.at : Date.now();
    return `[${k} · ${relativeMemoryAge(at)} · ${noteSource(r)}]`;
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
      return kind ? `[${kind}] ${stripped}`.trim() : (stripped || body);
    } catch {
      return body;
    }
  }
}
