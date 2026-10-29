/**
 * A small pool of Bun workers for CPU-bound, synchronous, pure functions (redacting and tokenizing a lookup's
 * items), so that work stops blocking the event loop every other user's request waits on.
 *
 * - Tasks are functions exported by one module (`module`), which both the workers and, for inline runs, the
 *   calling thread import. Inputs and outputs travel by structured clone (bench/message.bench.ts measured it
 *   cheaper on the main thread than UTF-8 in transferred buffers, and simpler than shared memory).
 * - Batching: tasks queued in the same turn are sent to idle workers in one message per worker, split evenly, at
 *   most `maxBatch` per message. One message is in flight per worker, so a slow batch never queues behind another.
 * - Back-pressure: at most `maxQueue` tasks wait; past that `run` rejects at once with `PoolFullError` (the caller
 *   decides: run inline, shed, or fail), rather than queueing without bound.
 * - Cancellation: an AbortSignal removes a waiting task; a task already sent cannot be stopped mid-run, so its
 *   promise rejects at once and the result is dropped when it arrives.
 * - Deadline: a batch still running after `taskTimeoutMs` has its worker terminated and replaced, and every task in
 *   it rejects with `PoolTimeoutError`. This is what bounds a pathological input; nothing else can stop a
 *   synchronous loop.
 * - Policy: `runOrInline` runs a task on the calling thread when its cost (the caller's estimate, e.g. characters)
 *   is below `inlineBelow`, where the message round trip would cost more than the work, or when the pool is full.
 */

export class PoolFullError extends Error {
  override name = "PoolFullError";
}
export class PoolTimeoutError extends Error {
  override name = "PoolTimeoutError";
}
export class PoolClosedError extends Error {
  override name = "PoolClosedError";
}

export interface PoolOptions {
  /** Absolute URL (or path) of the module whose exported functions are the tasks. */
  module: string;
  /** Workers. Leave one core for the event loop: `navigator.hardwareConcurrency - 1` at most. */
  size: number;
  /** Tasks that may wait for a worker; beyond this `run` rejects with PoolFullError. */
  maxQueue: number;
  /** Most tasks per message to one worker. */
  maxBatch: number;
  /** A batch running longer than this has its worker replaced and its tasks rejected; Infinity disables it. */
  taskTimeoutMs: number;
  /** `runOrInline` runs tasks whose cost is below this on the calling thread. */
  inlineBelow: number;
}

export interface PoolStats {
  workers: number;
  busy: number;
  queued: number;
  completed: number;
  inline: number;
  rejectedFull: number;
  timedOut: number;
  restarts: number;
}

interface Pending {
  fn: string;
  input: unknown;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  /** Settled already (aborted, or rejected by a timeout); a late result is dropped. */
  done: boolean;
  /** Still in the queue, counted in `waiting`. */
  queued: boolean;
}

interface Slot {
  worker: Worker;
  ready: Promise<void>;
  /** The batch in flight, or undefined when idle. */
  batch: Pending[] | undefined;
  batchId: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

type TaskResult = { ok: true; value: unknown } | { ok: false; error: string };

const WORKER_URL = new URL("./pool-worker.ts", import.meta.url).href;

export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private queueHead = 0;
  // Live queued tasks. A task aborted while it waits stays in the array until dispatch skips it, so the array's length
  // over-counts: back-pressure and stats use this instead.
  private waiting = 0;
  private scheduled = false;
  private closed = false;
  private nextBatchId = 1;
  private readonly counts = { completed: 0, inline: 0, rejectedFull: 0, timedOut: 0, restarts: 0 };

  private constructor(
    private readonly options: PoolOptions,
    private readonly local: Record<string, unknown>,
  ) {}

  /** Starts `size` workers and resolves once each has imported the task module (Bun: ~8 ms each, measured). */
  static async start(options: PoolOptions): Promise<WorkerPool> {
    const local = (await import(options.module)) as Record<string, unknown>;
    const pool = new WorkerPool(options, local);
    for (let i = 0; i < options.size; i++) pool.slots.push(pool.spawn());
    try {
      await Promise.all(pool.slots.map((slot) => slot.ready));
    } catch (error) {
      pool.close();
      throw error;
    }
    return pool;
  }

  /** Runs `fn(input)` in a worker. */
  run<T>(fn: string, input: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new PoolClosedError("pool is closed"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.waiting >= this.options.maxQueue) {
      this.counts.rejectedFull++;
      return Promise.reject(new PoolFullError(`${this.options.maxQueue} tasks already waiting`));
    }
    return new Promise<T>((resolve, reject) => {
      const task: Pending = {
        fn,
        input,
        resolve: resolve as (value: unknown) => void,
        reject,
        signal,
        onAbort: undefined,
        done: false,
        queued: true,
      };
      if (signal) {
        task.onAbort = () => this.settle(task, false, signal.reason);
        signal.addEventListener("abort", task.onAbort, { once: true });
      }
      this.queue.push(task);
      this.waiting++;
      this.schedule();
    });
  }

  /**
   * Runs `fn(input)` on the calling thread when `cost` is below `inlineBelow` or the pool is full, else in a worker.
   * The inline path is synchronous work wrapped in a resolved promise: it still blocks the event loop, by design.
   */
  runOrInline<T>(fn: string, input: unknown, cost: number, signal?: AbortSignal): Promise<T> {
    const full = this.waiting >= this.options.maxQueue;
    if (cost >= this.options.inlineBelow && !full && !this.closed) return this.run<T>(fn, input, signal);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const task = this.local[fn];
    if (typeof task !== "function") return Promise.reject(new Error(`no task named ${fn}`));
    this.counts.inline++;
    try {
      return Promise.resolve(task(input) as T);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  stats(): PoolStats {
    return {
      workers: this.slots.length,
      busy: this.slots.filter((slot) => slot.batch !== undefined).length,
      queued: this.waiting,
      ...this.counts,
    };
  }

  /** Terminates every worker; waiting and in-flight tasks reject with PoolClosedError. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new PoolClosedError("pool closed");
    for (const slot of this.slots) {
      if (slot.timer) clearTimeout(slot.timer);
      for (const task of slot.batch ?? []) this.settle(task, false, error);
      slot.worker.terminate();
    }
    for (let i = this.queueHead; i < this.queue.length; i++) this.settle(this.queue[i]!, false, error);
    this.queue.length = 0;
    this.queueHead = 0;
    this.waiting = 0;
  }

  private spawn(): Slot {
    const worker = new Worker(WORKER_URL);
    const slot: Slot = { worker, ready: Promise.resolve(), batch: undefined, batchId: 0, timer: undefined };
    slot.ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent) => {
        const data = event.data as { ready?: boolean; error?: string };
        if (data.ready) {
          worker.onmessage = (e: MessageEvent) => this.onResult(slot, e.data as { id: number; results: TaskResult[] });
          resolve();
          this.schedule();
        } else reject(new Error(`pool worker failed to load ${this.options.module}: ${data.error}`));
      };
    });
    // A worker that dies (an uncaught error outside a task) fails its batch and is replaced.
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      this.replace(slot, new Error(`pool worker crashed: ${event.message}`));
    };
    worker.postMessage({ module: this.options.module });
    return slot;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    // Coalesce every task queued in this turn into as few messages as there are idle workers.
    queueMicrotask(() => {
      this.scheduled = false;
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.closed) return;
    // Drop tasks cancelled while they waited.
    while (this.queueHead < this.queue.length && this.queue[this.queueHead]!.done) this.queueHead++;
    let waiting = this.queue.length - this.queueHead;
    if (waiting === 0) return this.compact();
    const idle = this.slots.filter((slot) => slot.batch === undefined);
    for (let i = 0; i < idle.length && waiting > 0; i++) {
      const share = Math.min(this.options.maxBatch, Math.ceil(waiting / (idle.length - i)));
      const batch: Pending[] = [];
      while (batch.length < share && this.queueHead < this.queue.length) {
        const task = this.queue[this.queueHead++]!;
        if (task.done) continue;
        this.dequeued(task);
        batch.push(task);
      }
      waiting = this.queue.length - this.queueHead;
      if (batch.length > 0) this.send(idle[i]!, batch);
    }
    this.compact();
  }

  /** Drops the consumed head of the queue once it is most of the array (amortized O(1) dequeue). */
  private compact(): void {
    if (this.queueHead > 1024 && this.queueHead * 2 > this.queue.length) {
      this.queue.splice(0, this.queueHead);
      this.queueHead = 0;
    } else if (this.queueHead === this.queue.length) {
      this.queue.length = 0;
      this.queueHead = 0;
    }
  }

  private send(slot: Slot, batch: Pending[]): void {
    slot.batch = batch;
    slot.batchId = this.nextBatchId++;
    const id = slot.batchId;
    slot.worker.postMessage({ id, batch: batch.map((task) => ({ fn: task.fn, input: task.input })) });
    if (Number.isFinite(this.options.taskTimeoutMs)) {
      slot.timer = setTimeout(() => {
        if (slot.batchId !== id || slot.batch === undefined) return;
        this.counts.timedOut += slot.batch.length;
        this.replace(slot, new PoolTimeoutError(`batch ran past ${this.options.taskTimeoutMs} ms`));
      }, this.options.taskTimeoutMs);
    }
  }

  private onResult(slot: Slot, data: { id: number; results: TaskResult[] }): void {
    if (data.id !== slot.batchId || slot.batch === undefined) return;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    const batch = slot.batch;
    slot.batch = undefined;
    for (let i = 0; i < batch.length; i++) {
      const result = data.results[i];
      if (result?.ok) this.settle(batch[i]!, true, result.value);
      else this.settle(batch[i]!, false, new Error(result ? result.error : "missing result"));
    }
    this.counts.completed += batch.length;
    this.dispatch();
  }

  /** Fails the slot's batch with `error`, terminates its worker and starts a fresh one in its place. */
  private replace(slot: Slot, error: Error): void {
    if (slot.timer) clearTimeout(slot.timer);
    for (const task of slot.batch ?? []) this.settle(task, false, error);
    slot.batch = undefined;
    slot.worker.terminate();
    if (this.closed) return;
    this.counts.restarts++;
    const index = this.slots.indexOf(slot);
    const fresh = this.spawn();
    // Until it is ready the fresh slot looks busy, so nothing is sent to a worker still loading.
    fresh.batch = [];
    fresh.ready.then(
      () => {
        fresh.batch = undefined;
        this.dispatch();
      },
      () => undefined,
    );
    this.slots[index] = fresh;
  }

  private dequeued(task: Pending): void {
    if (!task.queued) return;
    task.queued = false;
    this.waiting--;
  }

  private settle(task: Pending, ok: boolean, value: unknown): void {
    if (task.done) return;
    task.done = true;
    this.dequeued(task);
    if (task.onAbort) task.signal?.removeEventListener("abort", task.onAbort);
    if (ok) task.resolve(value);
    else task.reject(value);
  }
}
