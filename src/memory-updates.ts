/**
 * `Updated:` items outside a human Submit (A4 §5.2, D24; P3.4): the live keyed rows, typed or mined (D8), whose
 * `(scope, slot)` a window was given at another value (A4 §4's key comparison, `novelNotes`).
 *
 * - **SessionStart** (startup, clear) reads the repo's last session's window: what that session was given may have
 *   changed since, by a typed change in another session, the heavy sleep's mining, or a FileChanged re-check.
 * - **A non-human Submit** (D24) reads its own window: a value changed while the agent ran on its own.
 *
 * Only a changed value is news: a value the window was never given is not, and a value that ended with no successor
 * (a failed citation) has no row to state it. The last session's window is the newest other main-thread window whose
 * ledger holds one of the repo's cids, among the 64 most recently written.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isLiveRow, type MemoryRecord } from "./index";
import { deliveredKeys, liveDeliveries, novelNotes, readLedger, type LiveDelivery } from "./memory-ledger";
import { isCited, isUntyped, type ProvenanceNote } from "./memory-provenance";
import type { Invalidation } from "./memory-validity";
import { LIVE_LEDGER } from "./memory-window";

/** How many of the most recently written windows are read for the repo's last session. */
const RECENT_WINDOWS = 64;

/** The `Updated:` items for what a window holds (see the header), newest row first. */
export function updatedItems(
  rows: readonly MemoryRecord[],
  held: readonly LiveDelivery[],
  opts: { repo?: string; invalid?: readonly Invalidation[] },
): (MemoryRecord & Pick<ProvenanceNote, "update">)[] {
  const changed = (key: LiveDelivery) => held.some((delivery) => delivery.cid === key.cid && delivery.ver !== key.ver);
  const candidates = rows
    .filter((row) => isLiveRow(row) && (isCited(row) || !isUntyped(row)) && row.slots?.length)
    .filter((row) => deliveredKeys(row, opts.repo).some(changed))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return novelNotes(candidates, held, opts).filter((note) => note.update);
}

/** The window's ledger file's last write; 0 when it has none. */
function writtenAt(dir: string): number {
  let newest = 0;
  for (const name of [LIVE_LEDGER, LIVE_LEDGER.replace(/\.log$/, ".json")])
    newest = Math.max(newest, statSync(join(dir, name), { throwIfNoEntry: false })?.mtimeMs ?? 0);
  return newest;
}

/** What the repo's last session was given (see the header); none when no other window of the repo has a ledger. */
export function lastSessionDeliveries(windowsRoot: string, repo: string, except?: string): LiveDelivery[] {
  let names: string[];
  try {
    names = readdirSync(join(windowsRoot, "windows"));
  } catch {
    return [];
  }
  const prefix = `${repo.slice(0, 8)}/`;
  const windows = names
    .filter((name) => !name.includes("--") && join(windowsRoot, "windows", name) !== except)
    .map((name) => ({ dir: join(windowsRoot, "windows", name), at: writtenAt(join(windowsRoot, "windows", name)) }))
    .filter((window) => window.at > 0)
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_WINDOWS);
  for (const { dir } of windows) {
    if (![...readLedger(dir).delivered.keys()].some((cid) => cid.startsWith(prefix))) continue;
    // Everything the last session was given, however long its transcript grew: size 0 keeps every delivery.
    return liveDeliveries(dir, 0).filter((delivery) => delivery.cid.startsWith(prefix));
  }
  return [];
}
