/**
 * `readSse` (D1740): the linear reader against the reader it replaced (kept here as the oracle), on the same streams
 * cut into chunks every way, and its cost on large events.
 */
import { describe, expect, test } from "bun:test";
import { readSse } from "./anthropic";

/** The reader before D1740: it re-sliced the buffer from its start after every event. */
async function oracle(body: ReadableStream<Uint8Array>, onEvent: (e: Record<string, unknown>) => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      onEvent(JSON.parse(data) as Record<string, unknown>);
    }
  };
  for await (const part of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      flush(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flush(buffer);
}

const streamOf = (bytes: Uint8Array, cuts: number[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      let at = 0;
      for (const n of cuts) {
        if (at >= bytes.length) break;
        c.enqueue(bytes.slice(at, at + n));
        at += n;
      }
      if (at < bytes.length) c.enqueue(bytes.slice(at));
      c.close();
    },
  });

async function both(text: string, cuts: number[]) {
  const bytes = new TextEncoder().encode(text);
  const a: unknown[] = [];
  const b: unknown[] = [];
  await readSse(streamOf(bytes, cuts), (e) => a.push(e));
  await oracle(streamOf(bytes, cuts), (e) => b.push(e));
  return { a, b };
}

/** A seeded generator, so a failure names its case. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("readSse (D1740)", () => {
  test("gives the same events as the old reader on fuzzed streams and chunkings", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const events: string[] = [];
      const n = 1 + Math.floor(r() * 12);
      for (let i = 0; i < n; i++) {
        // Text with accented and astral characters (multi-byte UTF-8 split across chunks), newlines inside JSON
        // strings escaped as JSON writes them, a comment line, and the odd [DONE].
        const text = "é€😀 a\nb ".repeat(Math.floor(r() * 30));
        const parts = [`event: e${i}`, `data: ${JSON.stringify({ type: "t", i, text })}`];
        if (r() < 0.2) parts.unshift(": keep-alive");
        if (r() < 0.1) parts.push("data: [DONE]");
        events.push(parts.join("\n"));
      }
      const body = events.join("\n\n") + (r() < 0.5 ? "\n\n" : "");
      const cuts = Array.from({ length: 64 }, () => 1 + Math.floor(r() * (r() < 0.5 ? 4 : 400)));
      const { a, b } = await both(body, cuts);
      expect(a).toEqual(b);
    }
  });

  test("an event's end split over the chunk boundary ('\\n' | '\\n') is found", async () => {
    const text = `data: {"x":1}\n\ndata: {"x":2}\n\n`;
    for (let k = 1; k < text.length; k++) {
      const { a, b } = await both(text, [k]);
      expect(a).toEqual([{ x: 1 }, { x: 2 }]);
      expect(b).toEqual(a);
    }
  });

  test("a stream of many small events in one large chunk, and one large event in many chunks, read in linear time", async () => {
    const one = (i: number) => `event: content_block_delta\ndata: {"type":"content_block_delta","i":${i}}\n\n`;
    const many = (n: number) => new TextEncoder().encode(Array.from({ length: n }, (_, i) => one(i)).join(""));
    const big = (n: number) => new TextEncoder().encode(`data: ${JSON.stringify({ text: "x".repeat(n) })}\n\n`);
    // CPU time, not wall time: a bound on work alone stays in the main run (scripts/test-tail.txt, D811).
    const cpuMs = () => {
      const u = process.cpuUsage();
      return (u.user + u.system) / 1000;
    };
    const time = async (bytes: Uint8Array, cuts: number[]) => {
      const t0 = cpuMs();
      let count = 0;
      await readSse(streamOf(bytes, cuts), () => count++);
      return { ms: cpuMs() - t0, count };
    };
    // 40,000 events in one chunk: the old reader copied the rest of the buffer after each (about 1.6 GB of copies).
    const small = await time(many(40_000), [Number.MAX_SAFE_INTEGER]);
    expect(small.count).toBe(40_000);
    // One 4 MB event in 4 KB chunks: the old reader scanned it from its start at each of about 1,000 chunks.
    const large = await time(
      big(4_000_000),
      Array.from({ length: 1_100 }, () => 4096),
    );
    expect(large.count).toBe(1);
    // Generous bounds (a loaded 4-core box): the quadratic reader took seconds on each (D1740's bench).
    expect(small.ms).toBeLessThan(2_000);
    expect(large.ms).toBeLessThan(2_000);
  });
});
