/**
 * Real-use scoring + bloat. Hit = gold in a ≤8-line ≤900-byte packet, no qx/stale.
 * Dump-all cannot score 0. Store and prompt are long threads, not one-line clips.
 */
export const MAX_BULLETS = 8;
export const MAX_BYTES = 900;

/** Pre-seeded conversation threads (each is ~48 turns of fat user/assistant walls). */
export const SEED_THREADS = 56;
/** Extra Stop threads observed during every trial, after the seed copy. */
export const LIVE_THREADS = 64;
/** Period-terminated sentences packed into the UserPromptSubmit paste. */
export const PASTE_SENTENCES = 960;
export const TOOL_LOG_LINES = 280;
/** Turns per observed thread. Gold is buried mid-thread inside a 7-sentence wall. */
export const TURNS = 56;

export function qxToken(i: number): string {
  return `qx${i}z`;
}

const WHO = ["Kai", "Sam", "Alex", "Riley", "Jordan", "Casey"] as const;
const ROOM = ["stand-up", "incident", "review", "handoff", "retro", "war-room"] as const;

/** One chat turn: extractable sentence, unique recap id, shared junk vocabulary. */
export function turnLine(salt: number, i: number): string {
  const who = WHO[(salt + i) % WHO.length]!;
  const room = ROOM[(salt + i) % ROOM.length]!;
  return `${who} on the ${room} thread ${salt}-${i} still has the widget catalog recap, unused feature flags, and leftover billing copy from last quarter that nobody asked about, plus recap ${salt}.${i}.`;
}

export function sessionTurns(salt: number, buried?: string): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = 0; i < TURNS; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const wall = `${turnLine(salt, i)} ${turnLine(salt, i + 40)} ${turnLine(salt, i + 80)} ${turnLine(salt, i + 120)}`;
    const content =
      buried && i === 24
        ? `${turnLine(salt, i)} ${turnLine(salt, i + 40)} ${turnLine(salt, i + 80)} ${buried} ${turnLine(salt, i + 120)} ${turnLine(salt, i + 160)} ${turnLine(salt, i + 200)}`
        : wall;
    out.push({ role, content });
  }
  return out;
}

/** Multi-paragraph paste the user dumps, then asks. No blank lines in `tight` mode. */
export function pasteDump(): string {
  const lines: string[] = [];
  for (let i = 0; i < PASTE_SENTENCES; i++) {
    lines.push(
      `log line ${i} of the pasted CI dump still mentions the widget catalog recap and leftover billing copy while printing ${qxToken(50_000 + i)} at src/widget/catalog.ts:${10 + (i % 90)}:3.`,
    );
    if (i % 11 === 0) {
      lines.push(
        `    at Object.<anonymous> (src/widget/catalog.ts:${20 + (i % 70)}:3) unused feature flag copy from last quarter.`,
      );
    }
  }
  return lines.join("\n");
}

export type Glue = "tight" | "para";

/** Real user message: kilobytes of dump, question last. tight = one blob ending `?` so retrieve hay is the paste. */
export function fatPrompt(cue: string, glue: Glue = "tight"): string {
  const body = pasteDump();
  return glue === "para" ? `${body}\n\n${cue}` : `${body}\n${cue}`;
}

export function toolLog(head: string, salt: number): string {
  const tail = Array.from({ length: TOOL_LOG_LINES }, (_, i) =>
    `stdout ${salt}.${i} widget catalog recap leftover ${qxToken(70_000 + salt * 200 + i)} at layer ${i}.`,
  ).join("\n");
  return `${head}\n${tail}`;
}

export function trapLine(i: number): string {
  const traps = [
    "The clerk at the front desk is Maria and handles visitor badges only.",
    "The nonce toy example lives in the tutorial appendix, not production.",
    "The database replica lag dashboard is a red herring for this outage.",
    "Canada goose nesting is closed on the office lawn this week.",
    "Scotland yard tickets are unrelated to the sport origin fact.",
    "Node 20 is what the laptop image uses, not the CI pin.",
    "Auth.test.ts in the billing folder is a copy, not the flake.",
    "Lisbon treaty trivia is unrelated to the incident rotation city.",
    "Sentry duty at the front desk is unrelated to error grouping.",
    "Linear algebra homework is unrelated to the ticket tracker.",
  ];
  return traps[i % traps.length]!.replace(/\.$/, ` (trap ${i}).`);
}

export const TRAP_N = 64;

/** Two-token qx copulas so n>1 leaks qx past unused-id filters. */
export function shortJunk(i: number): string {
  const kinds = [
    `Auth login ${i} is ${qxToken(i)}.`,
    `Checkout payment ${i} is ${qxToken(i)}.`,
    `Feature flags experiment ${i} is ${qxToken(i)}.`,
    `Session cache ${i} is ${qxToken(i)}.`,
    `Database connection ${i} is ${qxToken(i)}.`,
    `Ticket triage ${i} is ${qxToken(i)}.`,
    `Funnel signup ${i} is ${qxToken(i)}.`,
    `Onboard dashboard ${i} is ${qxToken(i)}.`,
    `Walkthrough recording ${i} is ${qxToken(i)}.`,
    `Pipeline yaml ${i} is ${qxToken(i)}.`,
    `Production alias ${i} is ${qxToken(i)}.`,
    `Epic backlog ${i} is ${qxToken(i)}.`,
  ];
  return kinds[i % kinds.length]!;
}

export const SHORT_N = 480;

export function packetText(res: Record<string, unknown> | null | undefined): string {
  if (!res) return "";
  const extra = res.hookSpecificOutput;
  const nested =
    extra && typeof extra === "object"
      ? String((extra as { additionalContext?: unknown }).additionalContext ?? "")
      : "";
  const a = String(res.additional_context ?? "");
  if (a.includes("Eden Memory:")) return a;
  if (nested.includes("Eden Memory:")) return nested;
  return a || nested;
}

export function bulletCount(blob: string): number {
  return [...blob.matchAll(/\n- /g)].length;
}

function hasNeedle(blob: string, needle: string): boolean {
  return new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(blob);
}

export type PacketScore = {
  hit: boolean;
  goldOnly: boolean;
  bytes: number;
  bullets: number;
  reason: string;
};

export function scorePacket(blob: string, gold: string[], stale?: string[]): PacketScore {
  const bytes = Buffer.byteLength(blob);
  const bullets = bulletCount(blob);
  const marked = blob.includes("Eden Memory:");
  const goldOk = gold.length > 0 && gold.every((g) => hasNeedle(blob, g));
  const staleHit = (stale ?? []).some((s) => hasNeedle(blob, s));
  const qxHit = /qx\d+z/i.test(blob);
  const goldOnly = marked && goldOk && !staleHit;
  if (!marked) return { hit: false, goldOnly: false, bytes, bullets, reason: "no-packet" };
  if (!goldOk) return { hit: false, goldOnly: false, bytes, bullets, reason: "gold-miss" };
  if (staleHit) return { hit: false, goldOnly, bytes, bullets, reason: "stale" };
  if (qxHit) return { hit: false, goldOnly, bytes, bullets, reason: "qx" };
  if (bullets > MAX_BULLETS) return { hit: false, goldOnly, bytes, bullets, reason: "bullets" };
  if (bytes > MAX_BYTES) return { hit: false, goldOnly, bytes, bullets, reason: "bytes" };
  return { hit: true, goldOnly: true, bytes, bullets, reason: "hit" };
}

export function dumpOraclePacket(golds: string[]): string {
  const lines = [
    ...golds.map((g) => `- ${g}`),
    ...Array.from({ length: 80 }, (_, i) => `- ${turnLine(3, i)}`),
  ];
  return `Eden Memory:\n${lines.join("\n")}`;
}

export function selectiveOraclePacket(golds: string[]): string {
  return `Eden Memory:\n${golds.map((g) => `- ${g}`).join("\n")}`;
}
