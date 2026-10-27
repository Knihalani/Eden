/**
 * The worker side of bench/message.bench.ts: returns its input by each transport, so the bench times only the
 * transport (and, for the byte transports, the UTF-8 encode/decode they need). Runs under Bun's Worker or
 * node:worker_threads (`workerData: "node"`).
 */
import { parentPort, workerData } from "node:worker_threads";

declare const self: { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown, t?: unknown[]): void };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Decodes `ends.length` UTF-8 items laid end to end, then encodes them again: what a byte transport costs. */
function roundTripBytes(bytes: Uint8Array, ends: Uint32Array): { out: Uint8Array; outEnds: Uint32Array } {
  const items: string[] = [];
  let at = 0;
  for (let i = 0; i < ends.length; i++) {
    items.push(decoder.decode(bytes.subarray(at, ends[i])));
    at = ends[i]!;
  }
  const out = new Uint8Array(bytes.length);
  const outEnds = new Uint32Array(items.length);
  let w = 0;
  for (let i = 0; i < items.length; i++) {
    w += encoder.encodeInto(items[i]!, out.subarray(w)).written;
    outEnds[i] = w;
  }
  return { out, outEnds };
}

function onMessage(data: any, post: (m: unknown, t?: ArrayBufferLike[]) => void): void {
  if (data.kind === "clone") post({ id: data.id, items: data.items });
  else if (data.kind === "transfer") {
    const { out, outEnds } = roundTripBytes(new Uint8Array(data.buf), data.ends);
    post({ id: data.id, buf: out.buffer, ends: outEnds }, [out.buffer, outEnds.buffer]);
  } else if (data.kind === "sab") serveShared(data.sab, post);
  else if (data.kind === "ping") post({ id: data.id });
}

/**
 * Shared-memory transport: control word 0 is the state (0 idle, 1 request ready, 2 response ready), word 1 the item
 * count; item ends follow at word 2; the bytes live after a fixed header. The worker blocks in Atomics.wait.
 */
function serveShared(sab: SharedArrayBuffer, post: (m: unknown) => void): void {
  const ctl = new Int32Array(sab, 0, 1026);
  const bytes = new Uint8Array(sab, 4104);
  post({ ready: true });
  for (;;) {
    Atomics.wait(ctl, 0, 0);
    if (Atomics.load(ctl, 0) === 3) return; // close
    const n = ctl[1]!;
    const ends = new Uint32Array(n);
    for (let i = 0; i < n; i++) ends[i] = ctl[2 + i]!;
    const { out, outEnds } = roundTripBytes(bytes.slice(0, ends[n - 1] ?? 0), ends);
    bytes.set(out);
    for (let i = 0; i < n; i++) ctl[2 + i] = outEnds[i]!;
    Atomics.store(ctl, 0, 2);
    Atomics.notify(ctl, 0);
    Atomics.wait(ctl, 0, 2); // until the main thread has read the response
  }
}

if (workerData === "node") {
  parentPort!.on("message", (data) => onMessage(data, (m, t) => parentPort!.postMessage(m, t as any)));
} else {
  self.onmessage = (e) => onMessage(e.data, (m, t) => self.postMessage(m, t));
}
