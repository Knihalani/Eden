/** Tasks for pool.test.ts: run in the pool's workers and, for inline runs, on the calling thread. */
import { isMainThread } from "node:worker_threads";

export function double(n: number): number {
  return n * 2;
}

/** Where the task ran: "main" or "worker". */
export function where(): string {
  return isMainThread ? "main" : "worker";
}

/** Busy-waits `ms`: a synchronous loop nothing but terminating the worker can stop. */
export function spin(ms: number): number {
  const until = performance.now() + ms;
  let n = 0;
  while (performance.now() < until) n++;
  return n;
}

/**
 * Blocks until the caller stores a non-zero value at index 0 of `flag` (a SharedArrayBuffer's Int32Array), or 60 s
 * pass: a task that holds its worker for exactly as long as a test needs, on a loaded machine as on a quiet one.
 */
export function hold(flag: Int32Array): number {
  Atomics.wait(flag, 0, 0, 60_000);
  return Atomics.load(flag, 0);
}

export function fail(message: string): never {
  throw new Error(message);
}

/** Throws outside any task, after the batch has returned: the worker dies. */
export function crashLater(): number {
  setTimeout(() => {
    throw new Error("worker crashed");
  }, 0);
  return 1;
}

let warmed = false;

/** Warm task (`PoolOptions.warm`): marks this thread warmed. */
export function warmUp(): void {
  warmed = true;
}

/** Whether `warmUp` ran on this thread before this task. */
export function isWarm(): boolean {
  return warmed;
}

/** A warm task that throws: the worker must still serve. */
export function warmFails(): never {
  throw new Error("warm-up failed");
}
