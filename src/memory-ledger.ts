/**
 * The window ledger's refractory rule (A4 §4, D25), as far as P0.2 needs it: a bullet already delivered in this
 * window is not delivered again while it is still in the live window.
 *
 * - **Deliveries** are appended to the window's `delivery.log` next to its `turn` records:
 *   `{"k":"deliver","cid":…,"ver":…,"off":…,"att":…,"ht":…}`. `off` is the transcript's size at delivery, `att`
 *   the Submit's `prompt_id`, `ht` the human-turn count.
 * - **cid / ver.** A slot (`legacySlot`) is keyed by its subject, `s:<hash>`, with its value as `ver`, so two rows
 *   saying the same value share a cid. A rule is `P:<hash>` and anything else `E:<hash>`, both of
 *   their normalized content words, so near-identical text gets one cid. P2.1 and P3.3 bring the real keys.
 * - **Still in the window**: the same epoch, the same `ver`, the transcript grown by less than 400 KB (rules) or
 *   1.2 MB (everything else) since `off`, and `att` not on an abandoned branch (a rewind): a prompt whose line is in
 *   the transcript but not on the current `parentUuid` chain. A prompt whose line is not written yet counts as on
 *   the branch.
 * - **Epochs**: SessionStart `compact` or `clear` starts a new one, which re-arms everything (P1.2 re-arms only what
 *   the compact summary dropped); `resume` keeps the ledger.
 * - **Shadow** (X7): a point in `shadow` writes the same records to `delivery.shadow.log`, so its refractory rule is
 *   simulated honestly: it reads what was delivered (the live log) and what it would have delivered (its own), each
 *   folded by its own epochs. A live point reads only the live log. `wouldPreempt` is shadow mode's G1 estimate.
 *
 * P1.1 adds the `delivery.json` snapshot, the overflow policy and `hook.log.d/`'s stage drops.
 */
import { createHash } from "node:crypto";
import { noteKindToken, stripPacketLabel, type ProvenanceNote } from "./memory-provenance";
import { legacySlot } from "./memory-residual";
import { contentWords, tailLines } from "./memory-transcript";
import { appendRecord, LIVE_LEDGER, SHADOW_LEDGER, windowRecords, type LedgerFile } from "./memory-window";

export const REFRACTORY_BYTES = { rule: 400_000, other: 1_200_000 } as const;

/** The transcript tail read for the branch check: past the longest distance, so an older delivery has expired. */
const BRANCH_TAIL_BYTES = 1_500_000;

export interface LedgerKey {
  cid: string;
  ver: string;
  rule: boolean;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function words(text: string): string {
  return [...new Set(contentWords(text))].sort().join(" ");
}

/** The hash of a text's normalized content words: the ver of every row that is not a slot. */
function contentHash(text: string): string {
  return hash(words(stripPacketLabel(text).body));
}

/** A note's cid and ver (see the header). */
export function ledgerKey(note: ProvenanceNote): LedgerKey {
  const slot = legacySlot(note);
  if (slot) return { cid: `s:${hash(words(slot.subject))}`, ver: hash(words(slot.value)), rule: false };
  const content = contentHash(String(note.text ?? ""));
  return noteKindToken(note) === "rule"
    ? { cid: `P:${content}`, ver: content, rule: true }
    : { cid: `E:${content}`, ver: content, rule: false };
}

/** Appends the deliveries of one packet. */
export function recordDeliveries(
  dir: string,
  notes: readonly ProvenanceNote[],
  at: { off: number; att: string; ht: number },
  file: LedgerFile = LIVE_LEDGER,
): void {
  for (const note of notes) {
    const { cid, ver } = ledgerKey(note);
    appendRecord(dir, file, { k: "deliver", cid, ver, off: at.off, att: at.att, ht: at.ht });
  }
}

/** Starts a new epoch (SessionStart `compact` or `clear`). */
export function startEpoch(dir: string, source: string, off: number, file: LedgerFile = LIVE_LEDGER): void {
  appendRecord(dir, file, { k: "epoch", source, off });
}

type Delivery = { cid: string; ver: string; off: number; att: string; ht: number };

/** This epoch's deliveries in one ledger file, oldest first. */
function epochDeliveries(dir: string, file: LedgerFile): Delivery[] {
  const out: Delivery[] = [];
  for (const record of windowRecords(dir, file)) {
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
        ht: typeof record.ht === "number" ? record.ht : 0,
      });
  }
  return out;
}

/** The ledgers a point's refractory rule reads (see the header). */
function readLedgers(file: LedgerFile): LedgerFile[] {
  return file === SHADOW_LEDGER ? [LIVE_LEDGER, SHADOW_LEDGER] : [LIVE_LEDGER];
}

/** The `promptId`s of a transcript tail's main-thread lines, and those on the current `parentUuid` chain. */
function branchPrompts(transcriptPath: string): { seen: Set<string>; onBranch: Set<string> } {
  const seen = new Set<string>();
  const onBranch = new Set<string>();
  const parent = new Map<string, string | null>();
  const prompt = new Map<string, string>();
  let last: string | undefined;
  for (const line of tailLines(transcriptPath, BRANCH_TAIL_BYTES)) {
    if (typeof line.uuid !== "string" || line.isSidechain === true) continue;
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
  return { seen, onBranch };
}

/** The notes still eligible: those not delivered in this window's live part (see the header). */
export function notRefractory<T extends ProvenanceNote>(
  dir: string,
  notes: readonly T[],
  now: { size: number; transcriptPath: string },
  file: LedgerFile = LIVE_LEDGER,
): T[] {
  const deliveries = readLedgers(file).flatMap((ledger) => epochDeliveries(dir, ledger));
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

/** EXECUTION X7: how many human turns back a shadow packet counts as one that would have preempted a restatement. */
const PREEMPT_TURNS = 3;

/**
 * `would_preempt` (X7): the cids of shadow deliveries from the last 3 human turns that the user now states again, in
 * one of the prompt's `statements` (its sentences, and the whole prompt, which the store also keeps as a row). A slot
 * counts when its value is the same (D30: equal to the visible value); other rows when their content words are,
 * whatever kind the stored row had. Until P5.1 logs D30's `restate` events, this is the estimate.
 */
export function wouldPreempt(dir: string, statements: readonly string[], hturn: number): string[] {
  const recent = epochDeliveries(dir, SHADOW_LEDGER).filter((d) => d.ht < hturn && d.ht >= hturn - PREEMPT_TURNS);
  if (!recent.length) return [];
  const slots = statements.map((text) => ledgerKey({ text, kind: "fact" })).filter((key) => key.cid.startsWith("s:"));
  const contents = new Set(statements.map(contentHash));
  const restated = recent.filter((d) =>
    d.cid.startsWith("s:") ? slots.some((key) => key.cid === d.cid && key.ver === d.ver) : contents.has(d.ver),
  );
  return [...new Set(restated.map((d) => d.cid))];
}
