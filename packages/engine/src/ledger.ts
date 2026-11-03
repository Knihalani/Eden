/**
 * What a session has already been given. The partner never repeats itself: an item delivered in a session is not
 * delivered again within `cooldownTurns` turns (it is still in the agent's context). An answer to an explicit ask
 * ignores the ledger, since the agent asked.
 *
 * A delivery may also record each item's version (a hash of its words). Then `revised` tells an item delivered
 * within the cooldown whose words have changed since: what the agent holds is a superseded copy (`syncPollBehind`,
 * D65), and the corrected one is news.
 */
export interface LedgerEntry {
  turn: number;
  version?: number;
}

export class Ledger {
  private readonly delivered = new Map<string, number>();
  private readonly versions = new Map<string, number>();

  constructor(private readonly cooldownTurns = 40) {}

  isFresh(itemId: string, turn: number): boolean {
    const at = this.delivered.get(itemId);
    return at === undefined || turn - at >= this.cooldownTurns;
  }

  /** Delivered within the cooldown with a recorded version other than `version`: the agent holds an older copy. */
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

  get size(): number {
    return this.delivered.size;
  }
}
