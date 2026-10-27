/**
 * What it costs to hand text to a worker and get it back, by transport: structured clone of a string array (Bun
 * `Worker` and `node:worker_threads`), UTF-8 bytes in a transferred ArrayBuffer, and a SharedArrayBuffer with
 * Atomics (main thread waits with `Atomics.waitAsync`). Also worker start-up. The worker (workers/echo.worker.ts)
 * returns its input, so the round trip is transport only.
 *
 * Reports per payload: round trip (one request in flight) and the main thread's own CPU per round trip
 * (`process.threadCpuUsage`, which counts only the calling thread): the share of the work that still lands on the
 * event loop.
 */
import { Worker as NodeWorker } from "node:worker_threads";
import { corpus } from "./harness";

const url = new URL("./workers/echo.worker.ts", import.meta.url).href;
/** `Atomics.waitAsync` (ES2024; Bun has it, the repo's lib setting is ES2023). */
const waitAsync = (
  Atomics as unknown as {
    waitAsync(array: Int32Array, index: number, value: number): { async: boolean; value: unknown };
  }
).waitAsync;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Port {
  send(m: unknown, transfer?: ArrayBuffer[]): void;
  next(): Promise<any>;
  close(): void;
}

function bunPort(): Port {
  const w = new Worker(url);
  let waiting: ((d: unknown) => void) | undefined;
  w.onmessage = (e) => waiting?.(e.data);
  return {
    send: (m, t) => w.postMessage(m, t ?? []),
    next: () => new Promise((r) => (waiting = r)),
    close: () => w.terminate(),
  };
}

function nodePort(): Port {
  const w = new NodeWorker(new URL(url), { workerData: "node" });
  let waiting: ((d: unknown) => void) | undefined;
  w.on("message", (d) => waiting?.(d));
  return {
    send: (m, t) => w.postMessage(m, t as any),
    next: () => new Promise((r) => (waiting = r)),
    close: () => void w.terminate(),
  };
}

async function startup(make: () => Port): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    const p = make();
    const reply = p.next();
    p.send({ kind: "ping", id: 0 });
    await reply;
    out.push(performance.now() - t0);
    p.close();
  }
  return out.sort((a, b) => a - b);
}

/** Times `iterations` sequential round trips of `once`; returns per-trip wall and main-thread CPU in µs. */
async function measure(once: () => Promise<unknown>, iterations: number) {
  for (let i = 0; i < 30; i++) await once();
  const walls: number[] = [];
  const cpu0 = process.threadCpuUsage();
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await once();
    walls.push((performance.now() - t0) * 1e3);
  }
  const cpu = process.threadCpuUsage(cpu0);
  walls.sort((a, b) => a - b);
  return {
    mean: walls.reduce((s, x) => s + x, 0) / walls.length,
    p50: walls[Math.floor(walls.length * 0.5)]!,
    p99: walls[Math.floor(walls.length * 0.99)]!,
    cpu: (cpu.user + cpu.system) / iterations,
  };
}

function packBytes(items: string[]): { bytes: Uint8Array; ends: Uint32Array } {
  let cap = 0;
  for (const s of items) cap += s.length * 3;
  const bytes = new Uint8Array(cap);
  const ends = new Uint32Array(items.length);
  let w = 0;
  for (let i = 0; i < items.length; i++) {
    w += encoder.encodeInto(items[i]!, bytes.subarray(w)).written;
    ends[i] = w;
  }
  return { bytes: bytes.subarray(0, w), ends };
}

function unpack(bytes: Uint8Array, ends: Uint32Array): string[] {
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < ends.length; i++) {
    out.push(decoder.decode(bytes.subarray(at, ends[i])));
    at = ends[i]!;
  }
  return out;
}

const payloads: [string, string[]][] = [
  ["1 x 200 B", [corpus(200)]],
  ["32 x 2 KB", Array.from({ length: 32 }, (_, i) => corpus(2048, { seed: i + 1 }))],
  ["32 x 8 KB", Array.from({ length: 32 }, (_, i) => corpus(8192, { seed: i + 1 }))],
];

const fmt = (x: number) => x.toFixed(1);
const ms = (xs: number[]) => `p50 ${xs[5]!.toFixed(1)} ms, max ${xs[xs.length - 1]!.toFixed(1)} ms`;
console.log(`Worker start-up to first reply (10 runs): Bun Worker ${ms(await startup(bunPort))}`);
console.log(`Worker start-up to first reply (10 runs): node:worker_threads ${ms(await startup(nodePort))}`);
console.log("\n| Payload | Transport | round trip mean | p50 | p99 | main-thread CPU per trip |");
console.log("|---|---|---:|---:|---:|---:|");
for (const [name, items] of payloads) {
  const rows: [string, () => Promise<unknown>, () => void][] = [];
  for (const [label, port] of [
    ["clone, Bun Worker", bunPort()],
    ["clone, node:worker_threads", nodePort()],
  ] as const) {
    rows.push([
      label,
      async () => {
        const reply = port.next();
        port.send({ kind: "clone", id: 1, items });
        const back = await reply;
        return back.items.length;
      },
      port.close,
    ]);
  }
  const tp = bunPort();
  rows.push([
    "transfer UTF-8, Bun Worker",
    async () => {
      const { bytes, ends } = packBytes(items);
      const buf = bytes.slice().buffer; // the packed copy is what is transferred
      const reply = tp.next();
      tp.send({ kind: "transfer", id: 1, buf, ends }, [buf]);
      const back = await reply;
      return unpack(new Uint8Array(back.buf), back.ends).length;
    },
    tp.close,
  ]);
  // Shared memory: one SharedArrayBuffer per worker, 1 MiB of text.
  const sp = bunPort();
  const sab = new SharedArrayBuffer(4104 + (1 << 20));
  const ctl = new Int32Array(sab, 0, 1026);
  const shared = new Uint8Array(sab, 4104);
  const ready = sp.next();
  sp.send({ kind: "sab", sab });
  await ready;
  rows.push([
    "SharedArrayBuffer + Atomics, Bun Worker",
    async () => {
      let w = 0;
      for (let i = 0; i < items.length; i++) {
        w += encoder.encodeInto(items[i]!, shared.subarray(w)).written;
        ctl[2 + i] = w;
      }
      ctl[1] = items.length;
      Atomics.store(ctl, 0, 1);
      Atomics.notify(ctl, 0);
      const wait = waitAsync(ctl, 0, 1);
      if (wait.async) await wait.value;
      const ends = new Uint32Array(items.length);
      for (let i = 0; i < items.length; i++) ends[i] = ctl[2 + i]!;
      const back = unpack(shared.slice(0, ends[items.length - 1]), ends);
      Atomics.store(ctl, 0, 0);
      Atomics.notify(ctl, 0);
      return back.length;
    },
    () => {
      Atomics.store(ctl, 0, 3);
      Atomics.notify(ctl, 0);
      sp.close();
    },
  ]);
  for (const [label, once, close] of rows) {
    const r = await measure(once, 500);
    console.log(`| ${name} | ${label} | ${fmt(r.mean)} µs | ${fmt(r.p50)} µs | ${fmt(r.p99)} µs | ${fmt(r.cpu)} µs |`);
    close();
  }
}
