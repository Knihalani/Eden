/**
 * `Updated:` items outside a human Submit (A4 §5.2, D24; P3.4): the live keyed rows, typed or mined (D8), whose
 * `(scope, slot)` a window was given at another value (A4 §4's key comparison, `novelNotes`).
 *
 * - **SessionStart** (startup, clear) reads the repo's last session's window: what that session was given may have
 *   changed since, by a typed change in another session, the heavy sleep's mining, or a FileChanged re-check.
 * - **A non-human Submit** (D24) reads its own window: a value changed while the agent ran on its own.
 *
 * Only a changed value is news: a value the window was never given is not, and a value that ended with no successor
 * (a failed citation) has no row to state it. A row is read through validity first (A4 §5.1 step 5), as a Submit's
 * notes are: one that validity cuts at all (a row stating two slots, one of them since ended) states no change. The
 * last session's window is the one the repo's store names in `last-session.json`, which each main-thread
 * SessionStart rewrites with its own after reading it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../packages/cli/src/home";
import { isLiveRow, type MemoryRecord } from "./index";
import { deliveredKeys, liveDeliveries, novelNotes, type LiveDelivery } from "./memory-ledger";
import { isCited, isUntyped, type ProvenanceNote } from "./memory-provenance";
import { validText, type Invalidation } from "./memory-validity";
import { windowDir } from "./memory-window";

const LAST_SESSION = "last-session.json";

/** The `Updated:` items for what a window holds (see the header), newest row first. */
export function updatedItems(
  rows: readonly MemoryRecord[],
  held: readonly LiveDelivery[],
  opts: { repo?: string; invalid?: readonly Invalidation[] },
): (MemoryRecord & Pick<ProvenanceNote, "update">)[] {
  const changed = (key: LiveDelivery) => held.some((delivery) => delivery.cid === key.cid && delivery.ver !== key.ver);
  const invalid = opts.invalid ?? [];
  const candidates = rows
    .filter((row) => isLiveRow(row) && (isCited(row) || !isUntyped(row)) && row.slots?.length)
    .filter((row) => validText(row.text, row.at, invalid, row.scope) === row.text)
    .filter((row) => deliveredKeys(row, opts.repo).some(changed))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return novelNotes(candidates, held, opts).filter((note) => note.update);
}

/**
 * What the repo's last session was given (see the header), however long its transcript grew; none before the
 * repo's first session, or when its window is gone.
 */
export function lastSessionDeliveries(store: string, root: string, repo: string): LiveDelivery[] {
  let win: unknown;
  try {
    win = (JSON.parse(readFileSync(join(store, LAST_SESSION), "utf8")) as { win?: unknown }).win;
  } catch {
    return [];
  }
  const dir = typeof win === "string" ? windowDir(root, win) : undefined;
  const prefix = `${repo.slice(0, 8)}/`;
  // Size 0 keeps every delivery of the window's current epoch.
  return dir ? liveDeliveries(dir, 0).filter((delivery) => delivery.cid.startsWith(prefix)) : [];
}

/** Names a session as the repo's last session (see the header): its id, which names its window. */
export function noteLastSession(store: string, win: string): void {
  writeFileAtomic(join(store, LAST_SESSION), `${JSON.stringify({ win })}\n`, 0o600);
}
