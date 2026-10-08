/**
 * The packet a memory hook delivers to Claude Code: its shape (D28, A4 §5.1 step 8) and its wording (D14, A4 §5.8).
 *
 * - **Shape.** Bullets follow the retrieval order, and a bullet is skipped once its kind is full: ≤ 2 rules,
 *   ≤ 1 procedure, ≤ 2 episodes (gists included), and 4 bullets in all, D28's soft limit. Nothing is pulled in to
 *   fill a short packet, and a bullet saying the same as an earlier one is dropped. D28's hard limit of 6 is for
 *   `Updated:` items (P1.1), which may exceed the soft limit; none exist yet.
 * - **Wording.** Project information, never an instruction to Claude (R0 F20). A rule the user set reads "Rule you
 *   set: …"; every other bullet ends with its source and age, e.g. "(you said, 3 weeks ago)". The source comes from
 *   the row's `src`, and a row without one claims no authority (A6 §2.1): a plain bullet, "… (3 weeks ago)", even
 *   for a rule. The header is every packet's (`MEMORY_PACKET_MARK`).
 * - **Size.** The packet stays within 900 bytes; a bullet that does not fit is skipped, never cut.
 */
import { MEMORY_PACKET_MARK, PACKET_BYTE_CAP } from "./memory-sota";
import { knownNoteSource, noteKindToken, stripPacketLabel, type ProvenanceNote } from "./memory-provenance";
import { memoryNow } from "./memory-clock";

export const PACKET_SOFT_BULLETS = 4;

type PacketKind = "rule" | "procedure" | "episode" | "fact";

const KIND_LIMIT: Partial<Record<PacketKind, number>> = { rule: 2, procedure: 1, episode: 2 };

/** A6 §2.1's source labels. */
const SOURCE_WORDS = { user: "you said", tool: "from a tool result", sleep: "earlier session notes" };

const AGE_UNITS: [ms: number, unit: string][] = [
  [7 * 86_400_000, "week"],
  [86_400_000, "day"],
  [3_600_000, "hour"],
  [60_000, "minute"],
];

function packetKind(note: ProvenanceNote): PacketKind {
  const kind = noteKindToken(note);
  if (kind === "rule" || kind === "procedure" || kind === "fact") return kind;
  return "episode";
}

function body(note: ProvenanceNote): string {
  return stripPacketLabel(String(note.text ?? ""))
    .body.replace(/^\s*-\s+/, "")
    .trim();
}

/**
 * Times are epoch ms (~1.7e12). A smaller number is no time: a list serial a store from before P0.3 kept as one
 * (A1 D8), which has no age.
 */
const LEGACY_SERIAL = 1e11;

/** "3 weeks ago", "1 hour ago", "just now"; undefined for a row whose time was never kept. */
export function ageInWords(at: unknown, now: number): string | undefined {
  if (typeof at !== "number" || !Number.isFinite(at) || at < LEGACY_SERIAL) return undefined;
  const elapsed = Math.max(0, now - at);
  for (const [ms, unit] of AGE_UNITS) {
    const n = Math.floor(elapsed / ms);
    if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

/** One bullet, worded as information about the project (D14), claiming only the source the row shows (A6 §2.1). */
export function declarativeBullet(note: ProvenanceNote, now: number): string {
  const text = body(note);
  const source = knownNoteSource(note);
  if (packetKind(note) === "rule" && source === "user") return `Rule you set: ${text}`;
  const provenance = [source && SOURCE_WORDS[source], ageInWords(note.at, now)].filter(Boolean).join(", ");
  return provenance ? `${text} (${provenance})` : text;
}

/** D28: the bullets worth a packet, in retrieval order (see the header). */
export function shapePacket<T extends ProvenanceNote>(notes: readonly T[]): T[] {
  const taken = new Map<PacketKind, number>();
  const said = new Set<string>();
  const shaped: T[] = [];
  for (const note of notes) {
    if (shaped.length >= PACKET_SOFT_BULLETS) break;
    const kind = packetKind(note);
    const key = body(note).toLowerCase().replace(/\s+/g, " ");
    const count = taken.get(kind) ?? 0;
    if (!key || said.has(key) || count >= (KIND_LIMIT[kind] ?? Infinity)) continue;
    taken.set(kind, count + 1);
    said.add(key);
    shaped.push(note);
  }
  return shaped;
}

/** The packet text, or "" when no bullet fits. */
export function renderPacket(notes: readonly ProvenanceNote[], now = memoryNow()): string {
  let packet = MEMORY_PACKET_MARK;
  for (const note of notes) {
    const line = `\n- ${declarativeBullet(note, now)}`;
    if (Buffer.byteLength(packet + line, "utf8") <= PACKET_BYTE_CAP) packet += line;
  }
  return packet === MEMORY_PACKET_MARK ? "" : packet;
}
