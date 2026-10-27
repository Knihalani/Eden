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
