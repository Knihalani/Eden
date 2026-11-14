/**
 * What a session has already been given. The partner never repeats itself: an item delivered in a session is not
 * delivered again within `cooldownTurns` turns (it is still in the agent's context). An answer to an explicit ask
 * ignores the ledger, since the agent asked.
 *
 * A delivery may also record each item's version (a hash of its words). Then `revised` tells an item delivered
 * within the cooldown whose words have changed since: what the agent holds is a superseded copy (`syncPollBehind`,
 * D65), and the corrected one is news.
 */
/** What a session was handed of an item (`revisionNotice`): its words' version and its source. */
export interface ShownCopy {
  version: number;
  sourceId: string;
  /** `revisionDiff` (D342): the times and dates the agent was shown in any version of the item, oldest first. */
  times?: string[];
}

/** Times and dates kept per shown item (`revisionDiff`), the most recently shown kept. */
const MAX_SHOWN_TIMES = 16;

/**
 * Items a session's ledger keeps at most, oldest delivery dropped first. The cooldown sweep in `mark` only runs as
 * turns pass, and an ask-only session (the MCP server's, which sends no events) never moves its turn, so without a cap
 * every item its answers cited stayed for the session's life (audit A5). Far above what one session's context holds.
 */
export const MAX_LEDGER_ITEMS = 2_048;

/** Items whose handed-out version a session keeps (`revisionNotice`), most recently shown kept longest. */
const MAX_SHOWN_COPIES = 256;

export interface LedgerEntry {
  turn: number;
  version?: number;
}

export class Ledger {
  private readonly delivered = new Map<string, number>();
  private readonly versions = new Map<string, number>();
  /**
   * `revisionNotice`: the version of each item the agent was handed in this session (a packet taken, an answer
   * returned), kept past the cooldown and bounded by count: the agent's transcript holds it whatever the turn.
   */
  private readonly shown = new Map<string, ShownCopy>();

  constructor(private readonly cooldownTurns = 40) {}

  isFresh(itemId: string, turn: number): boolean {
    const at = this.delivered.get(itemId);
    return at === undefined || turn - at >= this.cooldownTurns;
  }

  /** Delivered within the cooldown with a recorded version other than `version`: the agent holds an older copy. */
  /** Whether the ledger holds a delivered version of the item: `revised` is false for any other (D1885). */
  holdsVersion(itemId: string): boolean {
    return this.versions.has(itemId);
  }

  revised(itemId: string, version: number, turn: number): boolean {
    const was = this.versions.get(itemId);
    return was !== undefined && was !== version && !this.isFresh(itemId, turn);
  }

  mark(itemIds: string[], turn: number, versions?: readonly number[]): void {
    for (let i = 0; i < itemIds.length; i++) {
      const id = itemIds[i]!;
      this.delivered.delete(id); // Re-insert so Map order stays oldest-first.
      this.delivered.set(id, turn);
      if (versions) this.versions.set(id, versions[i]!);
      else this.versions.delete(id);
    }
    // Entries past their cooldown no longer suppress anything; drop them so a long session stays bounded.
    for (const [id, at] of this.delivered) {
      if (turn - at < this.cooldownTurns) break;
      this.delivered.delete(id);
      this.versions.delete(id);
    }
    while (this.delivered.size > MAX_LEDGER_ITEMS) {
      const oldest = this.delivered.keys().next().value as string;
      this.delivered.delete(oldest);
      this.versions.delete(oldest);
    }
  }

  /** What the ledger holds for an item: the turn it was last delivered in and its version, if one was recorded. */
  entry(itemId: string): LedgerEntry | undefined {
    const turn = this.delivered.get(itemId);
    if (turn === undefined) return undefined;
    const version = this.versions.get(itemId);
    return version === undefined ? { turn } : { turn, version };
  }

  /**
   * Puts an item's entry back to what `entry` returned before a delivery that did not reach the agent (a packet
   * withdrawn before it was taken, `readerPushBehind`): an earlier delivery and its version stand again, and an item
   * never delivered is fresh again. Not a bare unmark, which would forget a copy the agent does hold. The entry goes
   * last in the map's order; one older than those before it is dropped once they have expired, so the ledger stays
   * bounded.
   */
  restore(itemId: string, was: LedgerEntry | undefined): void {
    this.delivered.delete(itemId);
    this.versions.delete(itemId);
    if (!was) return;
    this.delivered.set(itemId, was.turn);
    if (was.version !== undefined) this.versions.set(itemId, was.version);
  }

  /** The agent now holds `version` of the item (handed out, or an update for it queued). */
  noteShown(itemId: string, version: number, sourceId: string, times?: readonly string[]): void {
    const was = this.shown.get(itemId);
    this.shown.delete(itemId); // Re-insert so Map order stays least recently shown first.
    // `revisionDiff`: every version's times stay, an old one too, since the agent's transcript holds them all.
    const all = [...(was?.times ?? [])];
    for (const t of times ?? []) {
      const at = all.indexOf(t);
      if (at >= 0) all.splice(at, 1);
      all.push(t);
    }
    this.shown.set(
      itemId,
      all.length ? { version, sourceId, times: all.slice(-MAX_SHOWN_TIMES) } : { version, sourceId },
    );
    while (this.shown.size > MAX_SHOWN_COPIES) this.shown.delete(this.shown.keys().next().value as string);
  }

  /** `revisionDiff`: the times and dates the agent was shown for the item, in any version (oldest first). */
  seenTimes(itemId: string): readonly string[] {
    return this.shown.get(itemId)?.times ?? [];
  }

  /** The agent was handed another version of the item than `version`: what it holds is superseded. */
  superseded(itemId: string, version: number): boolean {
    const was = this.shown.get(itemId);
    return was !== undefined && was.version !== version;
  }

  /** The copies the agent was handed, least recently shown first. */
  shownCopies(): IterableIterator<[string, ShownCopy]> {
    return this.shown.entries();
  }

  get shownCount(): number {
    return this.shown.size;
  }

  get size(): number {
    return this.delivered.size;
  }
}
