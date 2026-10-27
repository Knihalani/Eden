/**
 * The worker side of `WorkerPool` (pool.ts). The first message names the task module; the worker imports it and
 * replies `ready` (or the import error). Every later message is a batch: each task names an exported function and
 * its input, and the reply carries one result or error per task, in order. A task that throws fails alone.
 */
declare const self: {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
};

type Task = { fn: string; input: unknown };
export type TaskResult = { ok: true; value: unknown } | { ok: false; error: string };

let tasks: Record<string, unknown> | undefined;

/** Imports the task module once, then answers batches with a synchronous handler. */
self.onmessage = async (e: MessageEvent) => {
  const data = e.data as { module: string };
  try {
    tasks = (await import(data.module)) as Record<string, unknown>;
    // Swapped before replying, so no batch can reach the init handler.
    self.onmessage = runBatch;
    self.postMessage({ ready: true });
  } catch (error) {
    self.postMessage({ ready: false, error: String(error) });
  }
};

function runBatch(e: MessageEvent): void {
  const data = e.data as { id: number; batch: Task[] };
  const results: TaskResult[] = [];
  for (const task of data.batch) {
    try {
      // Inside the try: under `bun test` reading a missing export from a module namespace throws.
      const fn = tasks?.[task.fn];
      if (typeof fn !== "function") throw new Error(`no task named ${task.fn}`);
      results.push({ ok: true, value: fn(task.input) });
    } catch (error) {
      results.push({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  self.postMessage({ id: data.id, results });
}
