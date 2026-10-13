/**
 * The window ledger (A4 §4, D25): what a context window was given, so a bullet is not given again while it is still
 * in the live window, and comes back as an `Updated:` item when its value changed.
 *
 * - **Records.** A window's `delivery.log` is append-only. It holds `turn` records (human Submits,
 *   `memory-window.ts`); one `deliver` record per bullet, `{cid, ver, off, att, ht}`, where `off` is the transcript's
 *   size, `att` the Submit's `prompt_id` and `ht` the human-turn count; one `packet` record with the packet's tokens;
 *   `epoch` records (SessionStart `compact` or `clear`); and `held` records (PostCompact, below). Records hold ids and
 *   hashes, never row text (X11).
 * - **Snapshot.** At Stop and SubagentStop the log is folded under `delivery.lock`: it is rotated by rename
 *   (`delivery.log.<n>`), the snapshot and every rotated log it does not hold yet are folded into a new
 *   `delivery.json`, written by rename, and the rotated logs are removed. A line a writer appended to a rotated log
 *   after the fold read it goes back to the live log (the writer opened the file before the rename). Readers fold the
 *   snapshot, the rotated logs past its `through`, then the live log.
 * - **The fold** keeps each cid's latest delivery (a union keeping max(`off`) within an epoch), the epoch, the
 *   tokens delivered in it, and the human turns: their count and the last 16 `prompt_id`s, so a Submit repeated after
 *   a fold still counts once (`hturn` is folded from `turn` records, never a counter a Submit increments).
 * - **Overflow.** Above 256 entries a fold evicts deliveries of older epochs first, oldest first, then the least
 *   recent episodes.
 * - **cid / ver.** `cid = <repo8>/<kind letter>:<key>`, `repo8` being the first 8 hex characters of the repo key
 *   (D1), or `_user` for a rule kept for all projects (D11, `memory-user-global.ts`). A rule row with D9 keys
 *   (P2.1) is keyed `P:` by a hash of its rules (A7 §5; `ruleIdentity`: the key, and the action in a class whose
 *   words name distinct ones), so two rows stating one rule share a cid, and its value tokens come from its keys.
 *   A slot row (D7, P3.3) is keyed `s:<scope>|<slot>` (the root's `s:<slot>`), with a hash of its canonical value as
 *   `ver`, so two phrasings of one value share both; a row stating two slots records a key for each. A fact of no D7
 *   slot that the legacy copula reader parses (`legacySlot`) is keyed `s:` by its scope and a hash of its subject. A
 *   rule without keys (`P:`: one on no action class, or written before P2.1), a retraction, and anything else (`E:`)
 *   are keyed by a hash of their normalized content words, so near-identical text gets one cid.
 * - **Live.** A delivery is still in the window when it is of the current epoch, the transcript has grown by less
 *   than 400 KB (rules) or 1.2 MB (everything else) since `off`, and `att` is not on an abandoned branch: a prompt the
 *   delta encoder found abandoned by a rewind (A4 §3.3, `memory-delta.ts`). A prompt whose line it has not read yet
 *   counts as on the branch. A child window's `off` is measured on its own transcript (`childTranscript`, D25).
 * - **Novelty.** A candidate whose every key a live delivery holds at the same `ver` is dropped (refractory). One
 *   with a slot key a live delivery holds at another `ver` is an `Updated:` item: a key comparison (A4 §4). So is a
 *   typed episode or gist whose text switches a live slot away from its value (D7's switch, `use A not B`: it states
 *   the slot's key, read from its text), and a retraction of a live slot's value (A4 §3.1). Delivering either records
 *   the slot at its new value, or the empty one (`renews`, `deliveredKeys`), so a second row stating the same change
 *   is refractory. The value an item replaces is named from the row's own keys (`use A not B`, a switch's `from`),
 *   else from what the store logged (`validity.jsonl`): the ledger keeps only hashes.
 * - **Epochs** (A4 §4 "Re-arm", D25). SessionStart `compact` and `clear` start an epoch, which re-arms everything.
 *   PostCompact, which Claude Code runs right after SessionStart(compact) (R0 F32), then holds what `compact_summary`
 *   still names: each delivery of the epoch the compaction closed whose value tokens (`memory-value-tokens.ts`, kept
 *   hashed as `vt`) the summary names in full moves to the new epoch, as if delivered at the summary (its `off`), on
 *   the current branch (`att` ""). A kind without value tokens is always re-armed. `resume` keeps the ledger as it
 *   is; a fork copies its parent's (`inheritLedger`, `memory-fork.ts`).
 * - **Budget.** After 6k tokens in an epoch, only `Updated:` items are delivered (A4 §4).
 * - **Shadow** (X7): a point in `shadow` writes the same records to `delivery.shadow.log` (snapshot
 *   `delivery.shadow.json`), so its refractory rule is simulated honestly: it reads what was delivered (the live log)
 *   and what it would have delivered (its own), each folded by its own epochs. A live point reads only the live log.
 *   `wouldPreempt` is shadow mode's G1 estimate.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { abandonedPrompts } from "./memory-delta";
import { isUntyped, noteKindToken, stripPacketLabel, type ProvenanceNote } from "./memory-provenance";
import { ruleIdentity } from "./memory-policy";
import { isUserGlobal, USER_GLOBAL } from "./memory-user-global";
import { legacySlot } from "./memory-residual";
import { contentWords } from "./memory-transcript";
import { noteSlots, slotsIn, typedValue, type SlotId, type SlotRef } from "./memory-slots";
import type { Invalidation } from "./memory-validity";
import { keyValueTokens, ruleValueTokens, slotValueTokens, summaryTokens } from "./memory-value-tokens";
import {
  appendRecords,
  existingLedgers,
  LIVE_LEDGER,
  parseRecords,
  SHADOW_LEDGER,
  windowRecords,
  type LedgerFile,
} from "./memory-window";

export const REFRACTORY_BYTES = { rule: 400_000, other: 1_200_000 } as const;
/** A4 §4: past this many tokens in an epoch, only `Updated:` items are delivered. */
export const EPOCH_TOKEN_CAP = 6_000;
/** D25: the entries a snapshot keeps. */
export const OVERFLOW_ENTRIES = 256;
/** The `prompt_id`s a fold keeps, against which a repeated Submit is told apart. */
const RECENT_TURNS = 16;

export interface LedgerKey {
  cid: string;
  ver: string;
  rule: boolean;
  /** Its value tokens, each hashed: what a compaction summary must name for it to stay habituated (see the header). */
  vt?: string[];
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

/** A subject word or value token as the ledger keeps it: a hash, never the word (X11). */
function wordHash(word: string): string {
  return hash(word).slice(0, 8);
}

/** Hashed value tokens, as a key carries them: none for a kind without value tokens. */
function hashedTokens(tokens: readonly string[]): { vt?: string[] } {
  return tokens.length ? { vt: tokens.map(wordHash) } : {};
}

/** The hash a slot's value is its ver by. */
function valueHash(value: string): string {
  return hash(words(value));
}

/** A note's cid and ver (see the header); `repo` is the repo key (D1), whose first 8 characters prefix the cid. */
export function ledgerKey(note: ProvenanceNote, repo?: string): LedgerKey {
  const prefix = isUserGlobal(note) ? `${USER_GLOBAL}/` : repo ? `${repo.slice(0, 8)}/` : "";
  if (note.rules?.length) {
    const keys = hash(note.rules.map(ruleIdentity).sort().join(" "));
    return { cid: `${prefix}P:${keys}`, ver: keys, rule: true, ...hashedTokens(keyValueTokens(note.rules)) };
  }
  const set = setSlots(note)[0];
  if (set) return slotKey(note, set, prefix);
  const slot = noteSlots(note).length ? undefined : legacySlot(note);
  if (slot) {
    // A4 §4's `s:<scope>|<slot>`: two scopes' values of one slot are two items. The root's keeps its old form.
    const cid = `${prefix}s:${placed(note)}${hash(words(slot.subject))}`;
    return { cid, ver: valueHash(slot.value), rule: false, ...hashedTokens(slotValueTokens(slot.value)) };
  }
  const text = String(note.text ?? "");
  const content = contentHash(text);
  return noteKindToken(note) === "rule"
    ? { cid: `${prefix}P:${content}`, ver: content, rule: true, ...hashedTokens(ruleValueTokens(text)) }
    : { cid: `${prefix}E:${content}`, ver: content, rule: false };
}

/** A cid's scope part: `<scope>|`, none at the root (or where the place is unknown). */
function placed(note: ProvenanceNote): string {
  return note.scope ? `${note.scope}|` : "";
}

/** The slots a note sets a value of (`noteSlots`). */
function setSlots(note: ProvenanceNote): SlotRef[] {
  return noteSlots(note).filter((ref) => ref.v !== undefined);
}

/** A slot's key in the ledger: `s:<scope>|<slot>`, its canonical value's hash, and the value's tokens as typed. */
function slotKey(note: ProvenanceNote, ref: SlotRef, prefix: string): LedgerKey {
  const typed = typedValue(stripPacketLabel(String(note.text ?? "")).body, ref.k, ref.v!);
  return {
    cid: `${prefix}s:${placed(note)}${ref.k}`,
    ver: valueHash(ref.v!),
    rule: false,
    ...hashedTokens(slotValueTokens(typed)),
  };
}

/** Every key a note's delivery records: a slot row's key for each slot it sets, else its `ledgerKey`. */
function noteKeys(note: ProvenanceNote, repo?: string): LedgerKey[] {
  const sets = setSlots(note);
  if (!sets.length) return [ledgerKey(note, repo)];
  const prefix = isUserGlobal(note) ? `${USER_GLOBAL}/` : repo ? `${repo.slice(0, 8)}/` : "";
  return sets.map((ref) => slotKey(note, ref, prefix));
}

/** The kind letter of a cid (`s`, `P`, `E`, …), after its repo prefix. */
function kindLetter(cid: string): string {
  return cid.slice(cid.indexOf("/") + 1, cid.indexOf("/") + 2);
}

function refractoryBytes(cid: string): number {
  return kindLetter(cid) === "P" ? REFRACTORY_BYTES.rule : REFRACTORY_BYTES.other;
}

/** A packet's size in tokens, as A5's `tokens_per_epoch` counts them: what A4 §4's budget adds up. */
export function packetTokens(packet: string): number {
  return Math.ceil(packet.length / 4);
}

/** Where and when a packet was delivered. */
export interface Moment {
  off: number;
  att: string;
  ht: number;
}

/**
 * Appends one packet's records: a `deliver` record per key and the packet's tokens, in one write. A delivery point
 * records each delivered note's `deliveredKeys`, so an `Updated:` item also renews the slot it changes.
 */
export function recordPacket(
  dir: string,
  packet: { keys: readonly LedgerKey[]; tokens: number },
  at: Moment,
  file: LedgerFile = LIVE_LEDGER,
): void {
  const delivered = packet.keys.map(({ cid, ver, vt }) => ({
    k: "deliver",
    cid,
    ver,
    off: at.off,
    att: at.att,
    ht: at.ht,
    ...(vt?.length ? { vt } : {}),
  }));
  const tokens = packet.tokens > 0 ? [{ k: "packet", tok: packet.tokens, off: at.off }] : [];
  appendRecords(dir, file, [...delivered, ...tokens]);
}

/** Starts a new epoch (SessionStart `compact` or `clear`). */
export function startEpoch(dir: string, source: string, off: number, file: LedgerFile = LIVE_LEDGER): void {
  appendRecords(dir, file, [{ k: "epoch", source, off }]);
}

/** A cid's latest delivery. */
export interface Delivered {
  ver: string;
  epoch: number;
  off: number;
  att: string;
  ht: number;
  /** How many times the cid was delivered. */
  n: number;
  vt?: string[];
}

/** One ledger file folded (see the header). */
export interface LedgerState {
  epoch: number;
  delivered: Map<string, Delivered>;
  tokensEpoch: number;
  turns: number;
  recentTurns: string[];
}

function emptyState(): LedgerState {
  return { epoch: 0, delivered: new Map(), tokensEpoch: 0, turns: 0, recentTurns: [] };
}

/** A record's list of hashes (`vt`, `cids`): its strings, none when it has no list. */
function hashList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function applyRecord(state: LedgerState, record: Record<string, unknown>): void {
  if (record.k === "epoch") {
    state.epoch++;
    state.tokensEpoch = 0;
  } else if (record.k === "turn") {
    const id = record.prompt_id;
    if (typeof id !== "string" || !id || state.recentTurns.includes(id)) return;
    state.turns++;
    state.recentTurns = [...state.recentTurns, id].slice(-RECENT_TURNS);
  } else if (record.k === "packet") {
    if (typeof record.tok === "number") state.tokensEpoch += record.tok;
  } else if (record.k === "held" && typeof record.off === "number") {
    for (const cid of hashList(record.cids)) {
      const entry = state.delivered.get(cid);
      if (entry) Object.assign(entry, { epoch: state.epoch, off: record.off, att: "" });
    }
  } else if (
    record.k === "deliver" &&
    typeof record.cid === "string" &&
    typeof record.ver === "string" &&
    typeof record.off === "number"
  ) {
    const prior = state.delivered.get(record.cid);
    const n = (prior?.n ?? 0) + 1;
    // A union keeping max(off): a line a fold moved back to the live log late is older than what follows it there.
    if (prior && prior.epoch === state.epoch && prior.off > record.off) {
      prior.n = n;
      return;
    }
    const vt = hashList(record.vt);
    state.delivered.set(record.cid, {
      ver: record.ver,
      epoch: state.epoch,
      off: record.off,
      att: typeof record.att === "string" ? record.att : "",
      ht: typeof record.ht === "number" ? record.ht : 0,
      n,
      ...(vt.length ? { vt } : {}),
    });
  }
}

function snapshotName(file: LedgerFile): string {
  return file.replace(/\.log$/, ".json");
}

function lockName(file: LedgerFile): string {
  return file.replace(/\.log$/, ".lock");
}

/** The snapshot on disk: the fold of every rotated log up to `through`. */
interface Snapshot {
  v: 2;
  epoch: number;
  delivered: Record<string, Delivered>;
  tokens_epoch: number;
  turns: number;
  recent_turns: string[];
  through: number;
}

function readSnapshot(dir: string, file: LedgerFile): { state: LedgerState; through: number } | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, snapshotName(file)), "utf8")) as Partial<Snapshot>;
    if (raw.v !== 2 || typeof raw.through !== "number" || !raw.delivered || typeof raw.delivered !== "object")
      return undefined;
    const state: LedgerState = {
      epoch: Number(raw.epoch) || 0,
      delivered: new Map(Object.entries(raw.delivered)),
      tokensEpoch: Number(raw.tokens_epoch) || 0,
      turns: Number(raw.turns) || 0,
      recentTurns: Array.isArray(raw.recent_turns) ? raw.recent_turns.filter((id) => typeof id === "string") : [],
    };
    return { state, through: raw.through };
  } catch {
    return undefined;
  }
}

function snapshotOf(state: LedgerState, through: number): Snapshot {
  return {
    v: 2,
    epoch: state.epoch,
    delivered: Object.fromEntries(state.delivered),
    tokens_epoch: state.tokensEpoch,
    turns: state.turns,
    recent_turns: state.recentTurns,
    through,
  };
}

/** The rotated logs of a ledger file, oldest first, with their number. */
function rotatedLogs(dir: string, file: LedgerFile): { name: string; n: number }[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const prefix = `${file}.`;
  return names
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map((name) => ({ name, n: Number(name.slice(prefix.length)) }))
    .sort((a, b) => a.n - b.n);
}

/** One ledger file folded: its snapshot, the rotated logs past the snapshot, then the live log (see the header). */
export function readLedger(dir: string, file: LedgerFile = LIVE_LEDGER): LedgerState {
  const snapshot = readSnapshot(dir, file);
  const state = snapshot?.state ?? emptyState();
  const through = snapshot?.through ?? 0;
  for (const { name, n } of rotatedLogs(dir, file))
    if (n > through) for (const record of windowRecords(dir, name)) applyRecord(state, record);
  for (const record of windowRecords(dir, file)) applyRecord(state, record);
  return state;
}

/**
 * A ledger file as `eden memory dump` lists it: a summary of its snapshot (`k: "snapshot"`, counts only), then the
 * records no snapshot holds yet, in order.
 */
export function ledgerListing(dir: string, file: LedgerFile = LIVE_LEDGER): Record<string, unknown>[] {
  const snapshot = readSnapshot(dir, file);
  const through = snapshot?.through ?? 0;
  const head = snapshot
    ? [
        {
          k: "snapshot",
          epoch: snapshot.state.epoch,
          turns: snapshot.state.turns,
          tokens_epoch: snapshot.state.tokensEpoch,
          entries: snapshot.state.delivered.size,
        },
      ]
    : [];
  const unfolded = rotatedLogs(dir, file).flatMap((log) => (log.n > through ? windowRecords(dir, log.name) : []));
  return [...head, ...unfolded, ...windowRecords(dir, file)];
}

/** D25's overflow policy, on a fold above 256 entries: older epochs first, then the least recent episodes. */
function evictOverflow(state: LedgerState): void {
  const excess = state.delivered.size - OVERFLOW_ENTRIES;
  if (excess <= 0) return;
  const entries = [...state.delivered];
  const older = entries
    .filter(([, entry]) => entry.epoch < state.epoch)
    .sort(([, a], [, b]) => a.epoch - b.epoch || a.off - b.off);
  const episodes = entries
    .filter(([cid, entry]) => entry.epoch === state.epoch && kindLetter(cid) === "E")
    .sort(([, a], [, b]) => a.off - b.off);
  for (const [cid] of [...older, ...episodes].slice(0, excess)) state.delivered.delete(cid);
}

/**
 * Folds a ledger file into its snapshot (see the header), at Stop and SubagentStop. Returns whether it wrote one;
 * false when there was nothing to fold or another hook holds the lock (the next fold takes it).
 */
export function foldLedger(dir: string, file: LedgerFile): boolean {
  try {
    return withFileLock(join(dir, lockName(file)), () => foldLocked(dir, file), 0);
  } catch {
    return false;
  }
}

function foldLocked(dir: string, file: LedgerFile): boolean {
  const snapshot = readSnapshot(dir, file);
  const through = snapshot?.through ?? 0;
  const logs = rotatedLogs(dir, file);
  const live = join(dir, file);
  if (existsSync(live) && statSync(live).size > 0) {
    const n = Math.max(through, ...logs.map((log) => log.n)) + 1;
    renameSync(live, join(dir, `${file}.${n}`));
    logs.push({ name: `${file}.${n}`, n });
  }
  const pending = logs.filter((log) => log.n > through);
  // A fold that stopped after writing its snapshot left logs it had folded: they go without being read again.
  for (const log of logs) if (log.n <= through) rmSync(join(dir, log.name), { force: true });
  if (!pending.length) return false;
  const state = snapshot?.state ?? emptyState();
  const taken = pending.map((log) => {
    const bytes = readFileSync(join(dir, log.name));
    for (const record of parseRecords(bytes.toString("utf8"))) applyRecord(state, record);
    return { ...log, read: bytes.length };
  });
  evictOverflow(state);
  writeFileAtomic(join(dir, snapshotName(file)), JSON.stringify(snapshotOf(state, taken.at(-1)!.n)), 0o600);
  for (const log of taken) {
    const late = readFileSync(join(dir, log.name)).subarray(log.read);
    if (late.length) appendFileSync(live, late, { mode: 0o600 });
    rmSync(join(dir, log.name), { force: true });
  }
  return true;
}

/** Folds every ledger file a window has (Stop, SubagentStop). */
export function foldWindow(dir: string): void {
  for (const file of existingLedgers(dir)) foldLedger(dir, file);
}

/**
 * PostCompact (see the header): appends one `held` record with the deliveries of the epoch the compaction closed
 * that `summary` still names. Returns their cids, and how many of that epoch's deliveries stay re-armed.
 */
export function holdSummarized(
  dir: string,
  summary: string,
  off: number,
  file: LedgerFile = LIVE_LEDGER,
): { held: string[]; rearmed: number } {
  const state = readLedger(dir, file);
  const closed = [...state.delivered].filter(([, entry]) => entry.epoch === state.epoch - 1);
  if (!closed.length) return { held: [], rearmed: 0 };
  const named = new Set([...summaryTokens(summary)].map(wordHash));
  const held = closed.flatMap(([cid, entry]) => (entry.vt?.every((token) => named.has(token)) ? [cid] : []));
  if (held.length) appendRecords(dir, file, [{ k: "held", cids: held, off }]);
  return { held, rearmed: closed.length - held.length };
}

/**
 * A fork's copy of its parent's ledger (D25, `memory-fork.ts`): each ledger file the parent has, the deliveries of its
 * current epoch that are on its branch and were not made at a prompt in `after` (the parent's prompts after the fork
 * point), and the tokens of its epoch. They go to the fork's ledger of the same file, in the fork's own epoch, with
 * no human turn (`ht` 0). A fork subagent's transcript is its own (D25: a child's distance is measured on it), so its
 * copies are made at `off` 0, its start; a forked session's keep the parent's offsets, as its transcript does. `into`
 * puts every copy in one ledger file (a fork subagent whose point is in shadow writes only its shadow ledger, X7).
 * Returns how many deliveries were copied.
 */
export function inheritLedger(
  parent: string,
  fork: string,
  after: ReadonlySet<string>,
  opts: { off?: number; into?: LedgerFile } = {},
): number {
  const abandoned = abandonedPrompts(parent);
  let copied = 0;
  for (const file of existingLedgers(parent)) {
    const state = readLedger(parent, file);
    const delivered = [...state.delivered].flatMap(([cid, entry]) => {
      if (entry.epoch !== state.epoch || after.has(entry.att) || abandoned.has(entry.att)) return [];
      const { ver, att, vt } = entry;
      const off = opts.off ?? entry.off;
      return [{ k: "deliver", cid, ver, off, att, ht: 0, ...(vt ? { vt } : {}) }];
    });
    const tokens = state.tokensEpoch > 0 ? [{ k: "packet", tok: state.tokensEpoch }] : [];
    appendRecords(fork, opts.into ?? file, [...delivered, ...tokens]);
    copied += delivered.length;
  }
  return copied;
}

/** The ledgers a point reads (see the header). */
function readLedgers(file: LedgerFile): LedgerFile[] {
  return file === SHADOW_LEDGER ? [LIVE_LEDGER, SHADOW_LEDGER] : [LIVE_LEDGER];
}

/**
 * `hturn` (A4 §4): the human turns this window has seen, in either ledger. A Submit's turn goes to one ledger; a
 * `prompt_id` in both (a repeated Submit across a flag change) counts once.
 */
export function humanTurns(dir: string): number {
  const live = readLedger(dir, LIVE_LEDGER);
  const shadow = readLedger(dir, SHADOW_LEDGER);
  const both = live.recentTurns.filter((id) => shadow.recentTurns.includes(id)).length;
  return live.turns + shadow.turns - both;
}

/** The tokens delivered in this epoch, in the ledgers a point reads: A4 §4's budget. */
export function epochTokens(dir: string, file: LedgerFile = LIVE_LEDGER): number {
  return readLedgers(file).reduce((sum, ledger) => sum + readLedger(dir, ledger).tokensEpoch, 0);
}

/** A delivery still in the window (see the header), from a ledger or from the packets a request carries. */
export interface LiveDelivery {
  cid: string;
  ver: string;
}

/** Whether a delivery made `off` bytes in is still in a window `size` bytes long. */
export function inWindow(cid: string, off: number, size: number): boolean {
  return size - off < refractoryBytes(cid);
}

/** The deliveries still in this window's live part, in the ledgers a point reads (see the header). */
export function liveDeliveries(dir: string, size: number, file: LedgerFile = LIVE_LEDGER): LiveDelivery[] {
  let abandoned: Set<string> | undefined;
  return readLedgers(file).flatMap((ledger) => {
    const state = readLedger(dir, ledger);
    return [...state.delivered].flatMap(([cid, entry]) => {
      if (entry.epoch !== state.epoch || !inWindow(cid, entry.off, size)) return [];
      abandoned ??= abandonedPrompts(dir);
      return abandoned.has(entry.att) ? [] : [{ cid, ver: entry.ver }];
    });
  });
}

/** The value an invalidation logged for a slot's ver, in the form it was typed. */
function loggedValue(ver: string, invalid: readonly Invalidation[]): string | undefined {
  const record = invalid.findLast((r) => r.k === "retract" && r.r !== "forget" && valueHash(r.o) === ver);
  return record?.k === "retract" ? (record.f ?? record.o) : undefined;
}

/**
 * The value an `Updated:` item replaces, from a live slot's ver: one the note itself invalidates (`use A not B`, a
 * switch's `from`), as it types it, else what the store logged.
 */
function replacedValue(note: ProvenanceNote, slot: SlotId, ver: string, invalid: readonly Invalidation[]) {
  const old = noteSlots(note).find((ref) => ref.k === slot && ref.x?.some((value) => valueHash(value) === ver));
  const value = old?.x?.find((x) => valueHash(x) === ver);
  const body = stripPacketLabel(String(note.text ?? "")).body;
  return value === undefined ? loggedValue(ver, invalid) : typedValue(body, slot, value);
}

/**
 * A typed episode's or gist's switch of a live slot (see the header): the slot's key at the value it switches to,
 * and the value it replaces; or `held` when the window already holds the slot at that value. Only a statement that
 * invalidates a value counts (a switch, `use A not B`): an episode that only mentions a value changes nothing.
 */
function episodeSwitch(note: ProvenanceNote, held: readonly LiveDelivery[], prefix: string) {
  const kind = noteKindToken(note);
  if (isUntyped(note) || note.rules?.length || (kind !== "episode" && kind !== "gist")) return undefined;
  const body = stripPacketLabel(String(note.text ?? "")).body;
  for (const { slot, value, was } of slotsIn(body)) {
    if (value === undefined || !was.length) continue;
    const cid = `${prefix}s:${placed(note)}${slot}`;
    const states = held.filter((delivery) => delivery.cid === cid);
    if (states.some((delivery) => delivery.ver === valueHash(value))) return "held" as const;
    if (!states.length) continue;
    const old = was.find((x) => states.some((delivery) => delivery.ver === valueHash(x)));
    const live = old === undefined ? states[0]! : states.find((delivery) => delivery.ver === valueHash(old))!;
    const replaced = old === undefined ? undefined : typedValue(body, slot, old);
    const key = { cid, ver: valueHash(value), rule: false, ...hashedTokens(slotValueTokens(value)) };
    return { key, was: replaced ?? loggedValue(live.ver, []) ?? "" };
  }
  return undefined;
}

/**
 * A retraction of a live slot's value (A4 §3.1): the slot's key at the empty value, and the value it retracts; or
 * `held` when the window already holds the slot at the empty value, which makes the retraction refractory.
 */
function retraction(note: ProvenanceNote, held: readonly LiveDelivery[], prefix: string) {
  const empty = valueHash("");
  for (const ref of noteSlots(note)) {
    if (ref.v !== undefined) continue;
    const cid = `${prefix}s:${placed(note)}${ref.k}`;
    const slot = held.filter((delivery) => delivery.cid === cid);
    if (slot.some((delivery) => delivery.ver === empty)) return "held" as const;
    const live = slot.find((delivery) => ref.x?.some((x) => valueHash(x) === delivery.ver));
    if (!live) continue;
    const was = replacedValue(note, ref.k, live.ver, []) ?? "";
    return { key: { cid, ver: empty, rule: false }, was };
  }
  return undefined;
}

/**
 * Novelty against the live deliveries (see the header): the notes not refractory, each `Updated:` item marked with
 * the value it replaces when it is known. `invalid` is the store's invalidation log. A retraction's item also names
 * the slot entry it renews (`renews`), which the caller records with it (`deliveredKeys`).
 */
export function novelNotes<T extends ProvenanceNote>(
  notes: readonly T[],
  live: readonly LiveDelivery[],
  opts: { repo?: string; invalid?: readonly Invalidation[] } = {},
): (T & Pick<ProvenanceNote, "update">)[] {
  if (!live.length) return [...notes];
  const held = [...live];
  const prefix = opts.repo ? `${opts.repo.slice(0, 8)}/` : "";
  return notes.flatMap((note) => {
    const keys = noteKeys(note, opts.repo);
    const same = keys.map((key) => held.filter((delivery) => delivery.cid === key.cid));
    if (keys.every((key, at) => same[at]!.some((delivery) => delivery.ver === key.ver))) return [];
    const at = keys.findIndex(
      (key, i) => kindLetter(key.cid) === "s" && same[i]!.length && !same[i]!.some((d) => d.ver === key.ver),
    );
    if (at >= 0) {
      held.push(...keys);
      const slot = setSlots(note)[at]?.k;
      const ver = same[at]![0]!.ver;
      const was = slot ? replacedValue(note, slot, ver, opts.invalid ?? []) : loggedValue(ver, opts.invalid ?? []);
      return [{ ...note, update: was ? { was } : {} }];
    }
    const changed = isUserGlobal(note)
      ? undefined
      : (episodeSwitch(note, held, prefix) ?? retraction(note, held, prefix));
    if (changed === "held") return [];
    if (!changed) return [note];
    held.push(changed.key);
    return [{ ...note, update: { ...(changed.was ? { was: changed.was } : {}), renews: changed.key } }];
  });
}

/** What delivering a note records: its keys (`noteKeys`), and the slot entry a retraction renews (`novelNotes`). */
export function deliveredKeys(note: ProvenanceNote, repo?: string): LedgerKey[] {
  const renews = note.update?.renews;
  return [...noteKeys(note, repo), ...(renews ? [renews] : [])];
}

/** A4 §4's budget: past 6k tokens in the epoch, only `Updated:` items. */
export function withinBudget<T extends ProvenanceNote>(notes: readonly T[], tokensEpoch: number): T[] {
  return tokensEpoch < EPOCH_TOKEN_CAP ? [...notes] : notes.filter((note) => note.update);
}

/** EXECUTION X7: how many human turns back a shadow packet counts as one that would have preempted a restatement. */
const PREEMPT_TURNS = 3;

/**
 * `would_preempt` (X7): the cids of shadow deliveries from the last 3 human turns that the user now states again, in
 * one of the prompt's `statements` (its sentences, and the whole prompt, which the store also keeps as a row). A slot
 * counts when its value is the same (D30: equal to the visible value); other rows when their content words are,
 * whatever kind the stored row had. Until P5.1 logs D30's `restate` events, this is the estimate.
 */
export function wouldPreempt(dir: string, statements: readonly string[], hturn: number, repo?: string): string[] {
  const state = readLedger(dir, SHADOW_LEDGER);
  const recent = [...state.delivered].filter(
    ([, entry]) => entry.epoch === state.epoch && entry.ht < hturn && entry.ht >= hturn - PREEMPT_TURNS,
  );
  if (!recent.length) return [];
  const slots = statements
    .flatMap((text) => noteKeys({ text, kind: "fact" }, repo))
    .filter((key) => kindLetter(key.cid) === "s");
  const contents = new Set(statements.map(contentHash));
  return recent
    .filter(([cid, entry]) =>
      kindLetter(cid) === "s" ? slots.some((key) => key.cid === cid && key.ver === entry.ver) : contents.has(entry.ver),
    )
    .map(([cid]) => cid);
}
