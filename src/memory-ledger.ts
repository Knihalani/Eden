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
 *   (D1). A rule row with D9 keys (P2.1) is keyed `P:` by a hash of its keys (A7 §5), so two rows stating one rule
 *   share a cid, and its value tokens come from its keys. Until P3.3 brings slot keys, a slot (`legacySlot`) is keyed
 *   `s:` by its subject, with its value as `ver`, and a rule without keys (`P:`: one on no action class, or written
 *   before P2.1) or anything else (`E:`) by a hash of its normalized content words, so near-identical text gets one
 *   cid.
 * - **Live.** A delivery is still in the window when it is of the current epoch, the transcript has grown by less
 *   than 400 KB (rules) or 1.2 MB (everything else) since `off`, and `att` is not on an abandoned branch: a prompt the
 *   delta encoder found abandoned by a rewind (A4 §3.3, `memory-delta.ts`). A prompt whose line it has not read yet
 *   counts as on the branch. A child window's `off` is measured on its own transcript (P2.5 brings child delivery).
 * - **Novelty.** A candidate whose cid a live delivery holds at the same `ver` is dropped (refractory). One whose cid
 *   it holds at another `ver`, or whose text retracts or switches away from a live slot's value (D7, A4 §3.1), is an
 *   `Updated:` item. A switch is tied to the slot by subject: every subject word it names is one of the slot's (slot
 *   keys keep their subject words hashed, `sw`), so "the docs site from GitHub to GitLab" is not the CI provider's
 *   change. Delivering a switch's item also records the slot at its new value (`deliveredKeys`), so a second row
 *   stating the same change is refractory. The value an item replaces is named from what the store logged
 *   (`validity.jsonl`) or the switch's own text: the ledger keeps only hashes. Until P3.3's keyed slots, a switch is
 *   how a legacy row carries a slot's new value.
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
import { noteKindToken, stripPacketLabel, type ProvenanceNote } from "./memory-provenance";
import { legacySlot } from "./memory-residual";
import { contentWords } from "./memory-transcript";
import { invalidationsIn, subjectWords, type Invalidation } from "./memory-validity";
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
  /** A slot's subject words, each hashed: what ties a switch to the slot it switches (see the header). */
  sw?: string[];
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
  const prefix = repo ? `${repo.slice(0, 8)}/` : "";
  if (note.rules?.length) {
    const keys = hash(
      note.rules
        .map((rule) => rule.k)
        .sort()
        .join(" "),
    );
    return { cid: `${prefix}P:${keys}`, ver: keys, rule: true, ...hashedTokens(keyValueTokens(note.rules)) };
  }
  const slot = legacySlot(note);
  if (slot) {
    const sw = subjectWords(slot.subject).map(wordHash);
    const cid = `${prefix}s:${hash(words(slot.subject))}`;
    return { cid, ver: valueHash(slot.value), rule: false, sw, ...hashedTokens(slotValueTokens(slot.value)) };
  }
  const text = String(note.text ?? "");
  const content = contentHash(text);
  return noteKindToken(note) === "rule"
    ? { cid: `${prefix}P:${content}`, ver: content, rule: true, ...hashedTokens(ruleValueTokens(text)) }
    : { cid: `${prefix}E:${content}`, ver: content, rule: false };
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
  const delivered = packet.keys.map(({ cid, ver, sw, vt }) => ({
    k: "deliver",
    cid,
    ver,
    off: at.off,
    att: at.att,
    ht: at.ht,
    ...(sw?.length ? { sw } : {}),
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
  sw?: string[];
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

/** A record's list of hashes (`sw`, `vt`): its strings, none when it has no list. */
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
    const sw = hashList(record.sw);
    const vt = hashList(record.vt);
    state.delivered.set(record.cid, {
      ver: record.ver,
      epoch: state.epoch,
      off: record.off,
      att: typeof record.att === "string" ? record.att : "",
      ht: typeof record.ht === "number" ? record.ht : 0,
      n,
      ...(sw.length ? { sw } : {}),
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
 * no human turn (`ht` 0). Returns how many deliveries were copied.
 */
export function inheritLedger(parent: string, fork: string, after: ReadonlySet<string>): number {
  const abandoned = abandonedPrompts(parent);
  let copied = 0;
  for (const file of existingLedgers(parent)) {
    const state = readLedger(parent, file);
    const delivered = [...state.delivered].flatMap(([cid, entry]) => {
      if (entry.epoch !== state.epoch || after.has(entry.att) || abandoned.has(entry.att)) return [];
      const { ver, off, att, sw, vt } = entry;
      return [{ k: "deliver", cid, ver, off, att, ht: 0, ...(sw ? { sw } : {}), ...(vt ? { vt } : {}) }];
    });
    const tokens = state.tokensEpoch > 0 ? [{ k: "packet", tok: state.tokensEpoch }] : [];
    appendRecords(fork, file, [...delivered, ...tokens]);
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
  sw?: string[];
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
      return abandoned.has(entry.att) ? [] : [{ cid, ver: entry.ver, ...(entry.sw ? { sw: entry.sw } : {}) }];
    });
  });
}

/** A slot value a note retracts or switches away from (D7, A4 §3.1), tied to the live slot it changes. */
interface SlotChange {
  /** The live slot it changes, and the ver it gives it: the new value's hash, or the empty value's. */
  slot: LiveDelivery;
  to: string;
  /** The value it switches to, as typed ("" for a retraction). */
  value: string;
  /** The value it replaces, as the note types it. */
  was: string;
}

/**
 * The live slot a note changes: one holding the value it retracts or switches away from (or the value it switches
 * to), whose subject words hold every subject word the change names. A retraction names none, and validity applies
 * it to every subject too.
 */
function slotChange(note: ProvenanceNote, slots: readonly LiveDelivery[]): SlotChange | undefined {
  const body = stripPacketLabel(String(note.text ?? "")).body;
  for (const record of invalidationsIn(body, 0)) {
    if (record.k !== "retract" || record.r === "forget") continue;
    const subject = (record.w ?? []).map(wordHash);
    const from = valueHash(record.o);
    const to = valueHash(record.n ?? "");
    const slot = slots.find(
      (s) => (s.ver === from || s.ver === to) && subject.every((word) => s.sw?.includes(word) ?? false),
    );
    const typed = body.split(/[^\w@.+-]+/).find((token) => token.toLowerCase() === record.o);
    if (slot) return { slot, to, value: record.n ?? "", was: typed ?? record.f ?? record.o };
  }
  return undefined;
}

/** The value an invalidation logged for a slot's ver, in the form it was typed. */
function loggedValue(ver: string, invalid: readonly Invalidation[]): string | undefined {
  const record = invalid.findLast((r) => r.k === "retract" && r.r !== "forget" && valueHash(r.o) === ver);
  return record?.k === "retract" ? (record.f ?? record.o) : undefined;
}

/**
 * Novelty against the live deliveries (see the header): the notes not refractory, each `Updated:` item marked with
 * the value it replaces when the store logged it. `invalid` is the store's invalidation log. A switch's item also
 * names the slot entry it renews (`renews`), which the caller records with it (`deliveredKeys`), so the slot is then
 * held at its new value: a second row stating the same change, in this packet or a later one, is refractory.
 */
export function novelNotes<T extends ProvenanceNote>(
  notes: readonly T[],
  live: readonly LiveDelivery[],
  opts: { repo?: string; invalid?: readonly Invalidation[] } = {},
): (T & Pick<ProvenanceNote, "update">)[] {
  if (!live.length) return [...notes];
  const held = [...live];
  return notes.flatMap((note) => {
    const key = ledgerKey(note, opts.repo);
    const same = held.filter((delivery) => delivery.cid === key.cid);
    if (same.some((delivery) => delivery.ver === key.ver)) return [];
    const changed = same.find((delivery) => kindLetter(delivery.cid) === "s");
    if (changed) {
      held.push(key);
      const was = loggedValue(changed.ver, opts.invalid ?? []);
      return [{ ...note, update: was ? { was } : {} }];
    }
    const slots = held.filter((delivery) => kindLetter(delivery.cid) === "s");
    const change = slotChange(note, slots);
    if (!change) return [note];
    if (held.some((delivery) => delivery.cid === change.slot.cid && delivery.ver === change.to)) return [];
    const renews = {
      cid: change.slot.cid,
      ver: change.to,
      rule: false,
      ...(change.slot.sw ? { sw: change.slot.sw } : {}),
      ...hashedTokens(slotValueTokens(change.value)),
    };
    held.push(renews);
    return [{ ...note, update: { was: change.was, renews } }];
  });
}

/** What delivering a note records: its own key, and the slot entry an `Updated:` item renews (`novelNotes`). */
export function deliveredKeys(note: ProvenanceNote, repo?: string): LedgerKey[] {
  const renews = note.update?.renews;
  return [ledgerKey(note, repo), ...(renews ? [renews] : [])];
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
    .map((text) => ledgerKey({ text, kind: "fact" }, repo))
    .filter((key) => kindLetter(key.cid) === "s");
  const contents = new Set(statements.map(contentHash));
  return recent
    .filter(([cid, entry]) =>
      kindLetter(cid) === "s" ? slots.some((key) => key.cid === cid && key.ver === entry.ver) : contents.has(entry.ver),
    )
    .map(([cid]) => cid);
}
