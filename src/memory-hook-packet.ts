/**
 * The packet a memory hook delivers to Claude Code: its shape (D28, A4 §5.1 step 8) and its wording (D14, A4 §5.8).
 *
 * - **Shape.** Bullets follow the retrieval order, and a bullet is skipped once its kind is full: ≤ 2 rules,
 *   ≤ 1 procedure, ≤ 2 episodes (gists included), and 4 bullets in all, D28's soft limit. Nothing is pulled in to
 *   fill a short packet, and a bullet saying the same as an earlier one is dropped. `Updated:` items (A4 §4: the
 *   window was given an earlier value) count toward neither: they may take the packet to D28's hard limit of 6.
 * - **Wording.** Project information, never an instruction to Claude (R0 F20). A rule the user set reads "Rule you
 *   set: …"; every other bullet ends with its source and age, e.g. "(you said, 3 weeks ago)". An `Updated:` item
 *   says so and names the value it replaces, "(was jest; you said, …)", unless its text already names it. The
 *   source comes from the row's `src`, and a row without one claims no authority (A6 §2.1): a plain bullet,
 *   "… (3 weeks ago)", even for a rule. The header is every packet's (`MEMORY_PACKET_MARK`).
 * - **Size.** The packet stays within 900 bytes; a bullet that does not fit is skipped, never cut.
 */
import { MEMORY_PACKET_MARK, PACKET_BYTE_CAP } from "./memory-sota";
import { knownNoteSource, noteKindToken, stripPacketLabel, type ProvenanceNote } from "./memory-provenance";
import { memoryNow } from "./memory-clock";

export const PACKET_SOFT_BULLETS = 4;
/** D28's hard limit, which only `Updated:` items reach. */
export const PACKET_HARD_BULLETS = 6;

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

/** Whether a text already names a value, as a whole word in any case. */
function names(text: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w@.-])${escaped}(?![\\w@-])`, "i").test(text);
}

/** One bullet, worded as information about the project (D14), claiming only the source the row shows (A6 §2.1). */
export function declarativeBullet(note: ProvenanceNote, now: number): string {
  const text = body(note);
  const source = knownNoteSource(note);
  const provenance = [source && SOURCE_WORDS[source], ageInWords(note.at, now)].filter(Boolean).join(", ");
  if (note.update) {
    const was = note.update.was && !names(text, note.update.was) ? `was ${note.update.was}` : "";
    const said = [was, provenance].filter(Boolean).join("; ");
    return `Updated: ${text}${said ? ` (${said})` : ""}`;
  }
  if (packetKind(note) === "rule" && source === "user") return `Rule you set: ${text}`;
  return provenance ? `${text} (${provenance})` : text;
}

/** D28: the bullets worth a packet, in retrieval order (see the header). */
export function shapePacket<T extends ProvenanceNote>(notes: readonly T[]): T[] {
  const taken = new Map<PacketKind, number>();
  const said = new Set<string>();
  const shaped: T[] = [];
  let soft = 0;
  for (const note of notes) {
    if (shaped.length >= PACKET_HARD_BULLETS) break;
    const kind = packetKind(note);
    const key = body(note).toLowerCase().replace(/\s+/g, " ");
    if (!key || said.has(key)) continue;
    if (!note.update) {
      const count = taken.get(kind) ?? 0;
      if (soft >= PACKET_SOFT_BULLETS || count >= (KIND_LIMIT[kind] ?? Infinity)) continue;
      taken.set(kind, count + 1);
      soft++;
    }
    said.add(key);
    shaped.push(note);
  }
  return shaped;
}

/** The packet text, or "" when no bullet fits. */
export function renderPacket(notes: readonly ProvenanceNote[], now = memoryNow()): string {
  return packetOf(notes, now).packet;
}

/** The packet text ("" when no bullet fits) and the notes whose bullet made it in, in order. */
export function packetOf<T extends ProvenanceNote>(
  notes: readonly T[],
  now = memoryNow(),
): { packet: string; delivered: T[] } {
  let packet = MEMORY_PACKET_MARK;
  const delivered: T[] = [];
  for (const note of notes) {
    const line = `\n- ${declarativeBullet(note, now)}`;
    if (Buffer.byteLength(packet + line, "utf8") > PACKET_BYTE_CAP) continue;
    packet += line;
    delivered.push(note);
  }
  return delivered.length ? { packet, delivered } : { packet: "", delivered };
}
