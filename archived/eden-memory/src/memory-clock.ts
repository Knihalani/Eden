/**
 * The memory clock: the time a row is stamped with (A4 §1 `t`), an invalidation is logged at, and an age is
 * measured to. The harness hands hooks and the CLI a simulated clock as `EDEN_NOW` (epoch milliseconds, A5 §4), so
 * a script's skipped days are real to the store; without it, the wall clock.
 */
export function memoryNow(): number {
  const simulated = Number(process.env.EDEN_NOW);
  return Number.isFinite(simulated) && simulated > 0 ? Math.floor(simulated) : Date.now();
}
