/**
 * Every MCP deadline in the process on one timer (D1840): each request's timeout (`McpClient`) and each POST's
 * (`StreamableHttpTransport`). A `setTimeout` and `clearTimeout` per request, and another pair per POST, were about 5%
 * of a small call's CPU; here an add is a heap push and a cancel sets a flag, and the one timer is armed for the
 * earliest deadline. Deadlines that tie fire in the order they were added, so a request's own timeout still fires
 * before the deadline of the POST that carries it (added after it, with the same 60 s), as two timers did.
 *
 * A cancelled deadline stays in the heap until it reaches the top or the heap is compacted (when cancelled ones are
 * over half of it), so the heap is bounded by twice the deadlines pending. With none pending the timer is cleared and
 * the heap emptied, so an idle process is not kept alive by a deadline no one waits on.
 */

export interface Deadline {
  /** When it fires, `performance.now()` milliseconds. */
  readonly due: number;
  readonly seq: number;
  fn: (() => void) | null;
}

export class Deadlines {
  private heap: Deadline[] = [];
  private pending = 0;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The due time the timer is armed for; Infinity when it is not. */
  private armedFor = Infinity;

  /** Calls `fn` once, `ms` from now, unless `cancel` is called first. */
  add(ms: number, fn: () => void): Deadline {
    // As `setTimeout` reads its delay: below 1 ms, past its 32-bit limit, or not a number, it is 1 ms.
    if (!(ms >= 1 && ms <= 2_147_483_647)) ms = 1;
    const d: Deadline = { due: performance.now() + ms, seq: this.seq++, fn };
    push(this.heap, d);
    this.pending++;
    if (d.due < this.armedFor) this.arm(d.due);
    return d;
  }

  /** Stops `d` from firing; nothing when it has fired or was cancelled. */
  cancel(d: Deadline): void {
    if (d.fn === null) return;
    d.fn = null;
    if (--this.pending === 0) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.armedFor = Infinity;
      this.heap = [];
    } else if (this.heap.length > 64 && this.pending * 2 < this.heap.length) {
      this.heap = this.heap.filter((x) => x.fn !== null);
      heapify(this.heap);
    }
  }

  private arm(due: number): void {
    clearTimeout(this.timer);
    this.armedFor = due;
    // Rounded up, so the timer never fires before the deadline (it would only re-arm).
    this.timer = setTimeout(this.fire, Math.max(0, Math.ceil(due - performance.now())));
  }

  private readonly fire = (): void => {
    this.timer = undefined;
    this.armedFor = Infinity;
    const now = performance.now();
    // `this.heap` is read afresh each time: a deadline's function may cancel others, which can replace it.
    while (this.heap.length > 0 && this.heap[0]!.due <= now) {
      const d = pop(this.heap);
      const fn = d.fn;
      if (fn === null) continue;
      d.fn = null;
      this.pending--;
      try {
        fn();
      } catch (e) {
        // As from a timer of its own: reported as uncaught, and the other deadlines still fire.
        queueMicrotask(() => {
          throw e;
        });
      }
    }
    if (this.pending === 0) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.armedFor = Infinity;
      this.heap = [];
    } else if (this.heap.length > 0 && this.heap[0]!.due < this.armedFor) this.arm(this.heap[0]!.due);
  };
}

/** The process's one set of MCP deadlines. */
export const deadlines = new Deadlines();

const before = (a: Deadline, b: Deadline) => a.due < b.due || (a.due === b.due && a.seq < b.seq);

function push(h: Deadline[], d: Deadline): void {
  let i = h.length;
  h.push(d);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!before(d, h[p]!)) break;
    h[i] = h[p]!;
    i = p;
  }
  h[i] = d;
}

function pop(h: Deadline[]): Deadline {
  const top = h[0]!;
  const last = h.pop()!;
  if (h.length > 0) {
    h[0] = last;
    down(h, 0);
  }
  return top;
}

function down(h: Deadline[], i: number): void {
  const d = h[i]!;
  const n = h.length;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= n) break;
    if (c + 1 < n && before(h[c + 1]!, h[c]!)) c++;
    if (!before(h[c]!, d)) break;
    h[i] = h[c]!;
    i = c;
  }
  h[i] = d;
}

function heapify(h: Deadline[]): void {
  for (let i = (h.length >> 1) - 1; i >= 0; i--) down(h, i);
}
