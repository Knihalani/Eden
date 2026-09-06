export class DeoptError extends Error {
  readonly deopt = true;
  /**
   * How many tool calls the program had already issued when it bailed.
   *
   * A caller falling back to the naive path needs to know whether the world has
   * been touched. Deciding that from the reason string cannot work: "island X
   * needs an island caller" reads like a pre-flight failure but fires wherever
   * the island happens to sit, which is routinely *after* a write. runProgram()
   * knows the answer exactly, so it puts it here rather than leaving the caller
   * to guess.
   *
   * 0 means the program provably did nothing and replaying is safe.
   */
  stepsRun = 0;
  /** Wall of the failed compiled attempt. 0 if it bailed before work. */
  ms = 0;
  llmCalls = 0;
  cents = 0;
  /**
   * Tool steps that COMPLETED before the failure (a step counts only once it
   * returned). Sibling calls suppressed against this run read this to decide
   * whether their work was already done: absent from the list means nobody
   * performed it and the raw call must still run.
   */
  toolCalls: string[] = [];

  constructor(readonly reason: string) {
    super(`deopt: ${reason}`);
    this.name = "DeoptError";
  }
}

export function isDeopt(err: unknown): err is DeoptError {
  if (err instanceof DeoptError) return true;
  if (!err || typeof err !== "object") return false;
  const rec = err as { deopt?: boolean; name?: string };
  return rec.deopt === true && rec.name === "DeoptError";
}

/**
 * True only when the failed run cannot have changed anything, so the caller may
 * re-run the sequence itself. Anything unknown answers false.
 */
export function isReplaySafe(err: unknown): boolean {
  if (!isDeopt(err)) return false;
  return (err.stepsRun ?? 0) === 0;
}
