/**
 * The window ledger's refractory rule (A4 §4, D25), as far as P0.2 needs it: a bullet already delivered in this
 * window is not delivered again while it is still in the live window.
 *
 * - **Deliveries** are appended to the window's `delivery.log` next to its `turn` records:
 *   `{"k":"deliver","cid":…,"ver":…,"off":…,"att":…,"ht":…}`. `off` is the transcript's size at delivery, `att`
 *   the Submit's `prompt_id`, `ht` the human-turn count.
 * - **cid / ver.** A slot (`legacySlot`) is keyed by its subject, `F:<hash>`, with its value as `ver`, so two rows
 *   saying the same value share a cid. A rule is `P:<hash>` and anything else `E:<hash>`, both of
 *   their normalized content words, so near-identical text gets one cid. P2.1 and P3.3 bring the real keys.
 * - **Still in the window**: the same epoch, the same `ver`, the transcript grown by less than 400 KB (rules) or
 *   1.2 MB (everything else) since `off`, and `att` not on an abandoned branch (a rewind): a prompt whose line is in
 *   the transcript but not on the current `parentUuid` chain. A prompt whose line is not written yet counts as on
 *   the branch.
 * - **Epochs**: SessionStart `compact` or `clear` starts a new one, which re-arms everything (P1.2 re-arms only what
 *   the compact summary dropped); `resume` keeps the ledger.
 *
 * P1.1 adds the `delivery.json` snapshot, the overflow policy and `hook.log.d/`.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { noteKindToken, stripPacketLabel, type ProvenanceNote } from "./memory-provenance";
import { legacySlot } from "./memory-residual";
import { appendRecord, windowRecords } from "./memory-window";

export const REFRACTORY_BYTES = { rule: 400_000, other: 1_200_000 } as const;

/** The transcript tail read for the branch check: past the longest distance, so an older delivery has expired. */
const BRANCH_TAIL_BYTES = 1_500_000;

const STOPWORDS = new Set("a an the and or but to of in on at for with by is are was were be it this that".split(" "));

export interface LedgerKey {
  cid: string;
  ver: string;
  rule: boolean;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function words(text: string): string {
  const tokens = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => !STOPWORDS.has(token));
  return [...new Set(tokens)].sort().join(" ");
}

/** A note's cid and ver (see the header). */
export function ledgerKey(note: ProvenanceNote): LedgerKey {
  const slot = legacySlot(note);
  if (slot) return { cid: `F:${hash(words(slot.subject))}`, ver: hash(words(slot.value)), rule: false };
  const content = hash(words(stripPacketLabel(String(note.text ?? "")).body));
  return noteKindToken(note) === "rule"
    ? { cid: `P:${content}`, ver: content, rule: true }
    : { cid: `E:${content}`, ver: content, rule: false };
}

/** Appends the deliveries of one packet. */
export function recordDeliveries(
  dir: string,
  notes: readonly ProvenanceNote[],
  at: { off: number; att: string; ht: number },
): void {
  for (const note of notes) {
    const { cid, ver } = ledgerKey(note);
    appendRecord(dir, "delivery.log", { k: "deliver", cid, ver, off: at.off, att: at.att, ht: at.ht });
  }
}

/** Starts a new epoch (SessionStart `compact` or `clear`). */
export function startEpoch(dir: string, source: string, off: number): void {
  appendRecord(dir, "delivery.log", { k: "epoch", source, off });
}

type Delivery = { cid: string; ver: string; off: number; att: string };

/** This epoch's deliveries, oldest first. */
function epochDeliveries(dir: string): Delivery[] {
  const out: Delivery[] = [];
  for (const record of windowRecords(dir, "delivery.log")) {
    if (record.k === "epoch") out.length = 0;
    else if (
      record.k === "deliver" &&
      typeof record.cid === "string" &&
      typeof record.ver === "string" &&
      typeof record.off === "number"
    )
      out.push({
        cid: record.cid,
        ver: record.ver,
        off: record.off,
        att: typeof record.att === "string" ? record.att : "",
      });
  }
  return out;
}

/** The `promptId`s of a transcript tail's main-thread lines, and those on the current `parentUuid` chain. */
function branchPrompts(transcriptPath: string): { seen: Set<string>; onBranch: Set<string> } {
  const seen = new Set<string>();
  const onBranch = new Set<string>();
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - BRANCH_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const parent = new Map<string, string | null>();
    const prompt = new Map<string, string>();
    let last: string | undefined;
    for (const text of lines) {
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!line || typeof line.uuid !== "string" || line.isSidechain === true) continue;
      parent.set(line.uuid, typeof line.parentUuid === "string" ? line.parentUuid : null);
      if (typeof line.promptId === "string") {
        prompt.set(line.uuid, line.promptId);
        seen.add(line.promptId);
      }
      last = line.uuid;
    }
    for (let uuid = last, steps = 0; uuid && steps < parent.size; steps++) {
      const id = prompt.get(uuid);
      if (id) onBranch.add(id);
      uuid = parent.get(uuid) ?? undefined;
    }
  } catch {
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
  }
  return { seen, onBranch };
}

/** The notes still eligible: those not delivered in this window's live part (see the header). */
export function notRefractory<T extends ProvenanceNote>(
  dir: string,
  notes: readonly T[],
  now: { size: number; transcriptPath: string },
): T[] {
  const deliveries = epochDeliveries(dir);
  if (!deliveries.length) return [...notes];
  let branch: ReturnType<typeof branchPrompts> | undefined;
  const abandoned = (att: string) => {
    branch ??= now.transcriptPath ? branchPrompts(now.transcriptPath) : { seen: new Set(), onBranch: new Set() };
    return branch.seen.has(att) && !branch.onBranch.has(att);
  };
  return notes.filter((note) => {
    const key = ledgerKey(note);
    const distance = key.rule ? REFRACTORY_BYTES.rule : REFRACTORY_BYTES.other;
    return !deliveries.some(
      (d) => d.cid === key.cid && d.ver === key.ver && now.size - d.off < distance && !abandoned(d.att),
    );
  });
}
