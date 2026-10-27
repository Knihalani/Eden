/**
 * What a session has already been given. The partner never repeats itself: an item delivered in a session is not
 * delivered again within `cooldownTurns` turns (it is still in the agent's context). An answer to an explicit ask
 * ignores the ledger, since the agent asked.
 */
export class Ledger {
  private readonly delivered = new Map<string, number>();

  constructor(private readonly cooldownTurns = 40) {}

  isFresh(itemId: string, turn: number): boolean {
    const at = this.delivered.get(itemId);
    return at === undefined || turn - at >= this.cooldownTurns;
  }

  mark(itemIds: string[], turn: number): void {
    for (const id of itemIds) this.delivered.set(id, turn);
  }

  get size(): number {
    return this.delivered.size;
  }
}
