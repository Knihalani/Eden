import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cheapSkipHost, headerSkipHost } from "./gate";
import { skipHost } from "./extract";
import { BytePipe, emptyWarcStats, pushWarcBytes, type WetRecord } from "./warc";
import { gzipSync } from "node:zlib";
import { ingestWetGzip, ingestWetSlice, lastWetFetch, keepWet, wetHeaderSkip, wetRangeHeader } from "./cc";
import { compactLeader, DEFAULT_CC_SLICES, LIVE_PER_HOST, shardOwns, shardWetIndex, wetByteCap } from "./defaults";
import { EDENBOT } from "./ua";

const FACT =
  "RFC 3986 Uniform Resource Identifier Generic Syntax. Kenya is a country in East Africa whose capital is Nairobi. ";

function rec(uri: string, text: string): Uint8Array {
  const body = `${text}\n`;
  const hdr = `WARC/1.0\r\nWARC-Type: conversion\r\nWARC-Target-URI: ${uri}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  return Buffer.concat([Buffer.from(hdr, "utf8"), Buffer.from(body, "utf8")]);
}

function mixBlob(): Buffer {
  const mix: Uint8Array[] = [];
  for (let i = 0; i < 80; i++) mix.push(rec(`https://www.rfc-editor.org/rfc/rfc${2000 + i}.html`, FACT.repeat(6)));
  for (let i = 0; i < 200; i++) mix.push(rec(`https://www.nytimes.com/story-${i}`, FACT.repeat(8)));
  for (let i = 0; i < 200; i++) mix.push(rec(`https://spam.xyz/p/${i}`, FACT.repeat(8)));
  return Buffer.concat(mix);
}

describe("ingest scale", () => {
  test("header skip matches skipHost and junk TLD without decoding", () => {
    expect(headerSkipHost("https://www.nytimes.com/a")).toBe(true);
    expect(headerSkipHost("https://www.rfc-editor.org/rfc/rfc3986.html")).toBe(false);
    expect(wetHeaderSkip("https://www.nytimes.com/a")).toBe(true);
    expect(cheapSkipHost("https://casino-offer.xyz/x")).toBe("junk-host");
    expect(wetHeaderSkip("https://casino-offer.xyz/x")).toBe(true);
    expect(wetHeaderSkip("https://www.rfc-editor.org/rfc/rfc3986.html", undefined, 40)).toBe(true);
    expect(wetHeaderSkip("https://www.rfc-editor.org/rfc/rfc3986.html", undefined, 800)).toBe(false);
  });

  test("skip-payload keeps the same keepWet URI set as full decode", () => {
    const mix: Array<{ uri: string; text: string }> = [];
    for (let i = 0; i < 12; i++) mix.push({ uri: `https://www.rfc-editor.org/rfc/rfc${2000 + i}.html`, text: FACT.repeat(6) });
    for (let i = 0; i < 20; i++) mix.push({ uri: `https://www.nytimes.com/story-${i}`, text: FACT.repeat(8) });
    for (let i = 0; i < 20; i++) mix.push({ uri: `https://spam.xyz/p/${i}`, text: FACT.repeat(8) });
    const blob = Buffer.concat(mix.map((m) => rec(m.uri, m.text)));
    const full: WetRecord[] = [];
    pushWarcBytes(new Uint8Array(blob), full, 10_000);
    const skipped: WetRecord[] = [];
    const stats = emptyWarcStats();
    pushWarcBytes(new Uint8Array(blob), skipped, 10_000, (uri, _t, len) => wetHeaderSkip(uri, undefined, len), stats);
    const keepFull = full.filter((r) => keepWet(r)).map((r) => r.uri).sort();
    const keepSkip = skipped.filter((r) => keepWet(r)).map((r) => r.uri).sort();
    expect(keepSkip).toEqual(keepFull);
    expect(keepFull.length).toBe(12);
    expect(stats.decoded).toBe(12);
    expect(stats.skippedBodies).toBeGreaterThanOrEqual(40);
    expect(stats.decoded).toBeLessThan(full.length);
  });

  test("streaming chunks do not re-emit parsed records", () => {
    const pipe = new BytePipe();
    const all: WetRecord[] = [];
    for (let i = 0; i < 20; i++) {
      pipe.append(rec(`https://www.rfc-editor.org/rfc/rfc${4000 + i}.html`, FACT.repeat(6)));
      const chunk: WetRecord[] = [];
      pipe.setLeftover(pushWarcBytes(pipe.view(), chunk, 100));
      all.push(...chunk);
    }
    expect(all.length).toBe(20);
    expect(new Set(all.map((r) => r.uri)).size).toBe(20);
  });

  test("BytePipe copies less than naive concat on 200 records", () => {
    const parts = Array.from({ length: 80 }, (_, i) => rec(`https://www.rfc-editor.org/rfc/rfc${3000 + i}.html`, FACT.repeat(4)));
    let naive = 0;
    let buf = new Uint8Array(0);
    for (const p of parts) {
      naive += buf.length + p.length;
      const n = new Uint8Array(buf.length + p.length);
      n.set(buf);
      n.set(p, buf.length);
      buf = n;
    }
    const pipe = new BytePipe();
    for (const p of parts) pipe.append(p);
    expect(pipe.view().length).toBe(buf.length);
    expect(pipe.copies).toBeLessThan(naive);
  });

  test("shardWetIndex is exclusive across two boxes", () => {
    const a = new Set(Array.from({ length: 50 }, (_, s) => shardWetIndex(s, 0, 2)));
    const b = new Set(Array.from({ length: 50 }, (_, s) => shardWetIndex(s, 1, 2)));
    expect([...a].some((x) => b.has(x))).toBe(false);
    expect(a.size + b.size).toBe(100);
  });

  test("lowercase WARC header fields still parse and skip", () => {
    const body = `${FACT.repeat(6)}\n`;
    const keep = Buffer.concat([
      Buffer.from(
        `WARC/1.0\r\nwarc-type: conversion\r\nwarc-target-uri: https://www.rfc-editor.org/rfc/rfc9110.html\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n`,
      ),
      Buffer.from(body, "utf8"),
    ]);
    const drop = Buffer.concat([
      Buffer.from(
        `WARC/1.0\r\nwarc-type: conversion\r\nwarc-target-uri: https://www.nytimes.com/x\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n`,
      ),
      Buffer.from(body, "utf8"),
    ]);
    const blob = Buffer.concat([keep, drop]);
    const recs: WetRecord[] = [];
    const stats = emptyWarcStats();
    pushWarcBytes(new Uint8Array(blob), recs, 10, (uri, _t, len) => wetHeaderSkip(uri, undefined, len), stats);
    expect(recs.map((r) => r.uri)).toEqual(["https://www.rfc-editor.org/rfc/rfc9110.html"]);
    expect(stats.decoded).toBe(1);
    expect(stats.skippedBodies).toBe(1);
  });

  test("tick prefetches robots for live origins", () => {
    const loop = readFileSync(join(import.meta.dir, "loop.ts"), "utf8");
    expect(loop).toContain("fetchRobots");
    expect(loop).toContain("skipGather(WIKIDATA_SPARQL_URL");
    expect(loop.includes("due(WIKIDATA_SPARQL_URL) ? gather")).toBe(false);
    expect(loop).toContain("wetLane");
    expect(loop.indexOf("const wetLane = Promise.all")).toBeGreaterThan(0);
    expect(loop.indexOf("const wetLane")).toBeLessThan(loop.indexOf("await tickLive"));
    expect(loop.indexOf("await wetLane")).toBeGreaterThan(loop.indexOf("await tickLive"));
    expect(loop).toContain("collectCdx(store");
    expect(loop).toContain("collectCcSlice");
    expect(loop).toContain("collectNewsRecords");
    expect(loop).toContain("commitCdx(store");
    expect(loop).toContain("commitCcRecords");
    expect(loop).toContain("commitNewsRecords");
    const cdx = readFileSync(join(import.meta.dir, "cdx.ts"), "utf8");
    expect(cdx).toContain("cdxVariantByHost");
    const worker = readFileSync(join(import.meta.dir, "worker.ts"), "utf8");
    expect(worker).toContain("EDEN_KNOW_INGEST_CHILD");
    expect(worker).toContain("Bun.spawn");
    expect(worker).toContain("wetBytes");
    expect(worker).toContain("ccSlices");
    expect(worker).toContain("wet:");
    expect(loop).toContain("lastWetFetch");
    const cc = readFileSync(join(import.meta.dir, "cc.ts"), "utf8");
    expect(cc).toContain("wetRangeHeader");
    expect(cc).toContain("Range:");
    expect(LIVE_PER_HOST).toBe(3);
    expect(EDENBOT).toMatch(/Edenbot\/0\.1/);
  });

  test("health HTTP answers in the parent while the ingest child starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-health-"));
    const port = 18000 + (process.pid % 4000) + 17;
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "worker.ts")], {
      env: {
        ...process.env,
        PORT: String(port),
        EDEN_KNOW_LISTEN: "127.0.0.1",
        EDEN_KNOW_DIR: dir,
        EDEN_KNOW_CC: "0",
        EDEN_KNOW_LIVE: "0",
        EDEN_KNOW_NEWS: "0",
        EDEN_KNOW_INTERVAL: "3600",
        EDEN_KNOW_S3: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const url = `http://127.0.0.1:${port}/health`;
      let r: Response | undefined;
      const tWait = performance.now();
      while (performance.now() - tWait < 8000) {
        try {
          r = await fetch(url, { signal: AbortSignal.timeout(500) });
          if (r.ok) break;
        } catch {
          /* parent not listening yet */
        }
        await new Promise((res) => setTimeout(res, 100));
      }
      expect(r).toBeDefined();
      const t0 = performance.now();
      const hot = await fetch(url, { signal: AbortSignal.timeout(1000) });
      const ms = performance.now() - t0;
      const j = (await hot.json()) as { ok?: boolean; caps?: { cc?: number; shards?: number; wetBytes?: number; ccSlices?: number } };
      expect(hot.ok).toBe(true);
      expect(j.ok).toBe(true);
      expect(j.caps?.cc).toBe(0);
      expect(j.caps?.shards).toBe(1);
      expect(j.caps?.wetBytes).toBe(wetByteCap());
      expect(j.caps?.ccSlices).toBe(DEFAULT_CC_SLICES);
      expect(ms).toBeLessThan(200);
    } finally {
      proc.kill();
      await Promise.race([proc.exited, new Promise((res) => setTimeout(res, 2000))]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gzip prefix keep set matches a scan-cap abort from the start", () => {
    const gz = gzipSync(mixBlob());
    const cap = Math.max(2048, Math.floor(gz.length * 0.55));
    const prefix = gz.subarray(0, cap);
    const fromPrefix = ingestWetGzip(prefix, 80, undefined, 10_000);
    const fromAbort = ingestWetGzip(gz, 80, undefined, fromPrefix.stats.scanned || 1);
    const a = fromPrefix.recs.map((r) => r.uri).sort();
    const b = fromAbort.recs.map((r) => r.uri).sort();
    expect(a).toEqual(b);
    expect(fromPrefix.gzipFetchedBytes).toBe(prefix.byteLength);
    expect(fromPrefix.gzipFetchedBytes).toBeLessThan(gz.byteLength);
  });

  test("empty gzip slice keeps nothing", () => {
    const gz = gzipSync(Buffer.from("WARC/1.0\r\nWARC-Type: warcinfo\r\nContent-Length: 0\r\n\r\n"));
    const got = ingestWetGzip(gz, 40, undefined, 100);
    expect(got.recs).toEqual([]);
    expect(got.stats.decoded).toBe(0);
  });

  test("Range 206 fetches a prefix; 416 falls back without changing keep set", async () => {
    const gz = gzipSync(mixBlob());
    const keepAll = ingestWetGzip(gz, 80, undefined, 10_000).recs.map((r) => r.uri).sort();
    const cap = Math.min(wetByteCap(), gz.byteLength);
    const port206 = 19000 + (process.pid % 3000);
    const srv206 = Bun.serve({
      port: port206,
      hostname: "127.0.0.1",
      fetch(req) {
        const range = req.headers.get("range");
        expect(req.headers.get("user-agent")).toMatch(/Edenbot\/0\.1/);
        if (range) {
          expect(range).toBe(wetRangeHeader(wetByteCap()));
          const end = Math.min(cap, gz.byteLength) - 1;
          return new Response(gz.subarray(0, end + 1), {
            status: 206,
            headers: { "Content-Range": `bytes 0-${end}/${gz.byteLength}` },
          });
        }
        return new Response(gz);
      },
    });
    try {
      const recs = await ingestWetSlice(`http://127.0.0.1:${srv206.port}/wet.gz`, 80, undefined, 10_000);
      const meter = lastWetFetch();
      expect(meter.rangePrefix).toBe(true);
      expect(meter.status).toBe(206);
      expect(meter.gzipFetchedBytes).toBeLessThanOrEqual(cap);
      expect(recs.map((r) => r.uri).sort()).toEqual(keepAll);
    } finally {
      srv206.stop(true);
    }

    const port416 = port206 + 1;
    const srv416 = Bun.serve({
      port: port416,
      hostname: "127.0.0.1",
      fetch(req) {
        if (req.headers.get("range")) return new Response(null, { status: 416 });
        return new Response(gz);
      },
    });
    try {
      const recs = await ingestWetSlice(`http://127.0.0.1:${srv416.port}/wet.gz`, 80, undefined, 10_000);
      const meter = lastWetFetch();
      expect(meter.rangePrefix).toBe(false);
      expect(meter.status).toBe(200);
      expect(meter.gzipFetchedBytes).toBeLessThanOrEqual(wetByteCap());
      expect(recs.map((r) => r.uri).sort()).toEqual(keepAll);
    } finally {
      srv416.stop(true);
    }
  });

  test("stream inflate aborts the GET when the scan window is full", async () => {
    const fat: Uint8Array[] = [];
    for (let i = 0; i < 80; i++) fat.push(rec(`https://www.rfc-editor.org/rfc/rfc${2000 + i}.html`, FACT.repeat(6)));
    for (let i = 0; i < 2_000; i++) fat.push(rec(`https://www.nytimes.com/story-${i}`, FACT.repeat(8)));
    const blob = Buffer.concat(fat);
    const gz = gzipSync(blob);
    expect(gz.byteLength).toBeGreaterThan(16_384);
    const keepAll = ingestWetGzip(gz, 80, undefined, 80).recs.map((r) => r.uri).sort();
    let pulled = 0;
    const port = 19100 + (process.pid % 3000);
    const srv = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch() {
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= gz.byteLength) {
              controller.close();
              return;
            }
            const n = Math.min(2048, gz.byteLength - sent);
            controller.enqueue(gz.subarray(sent, sent + n));
            sent += n;
            pulled = sent;
          },
        });
        return new Response(body, {
          status: 206,
          headers: {
            "Content-Range": `bytes 0-${gz.byteLength - 1}/${gz.byteLength}`,
            "Content-Type": "application/gzip",
          },
        });
      },
    });
    try {
      const recs = await ingestWetSlice(`http://127.0.0.1:${srv.port}/wet.gz`, 80, undefined, 80);
      const meter = lastWetFetch();
      expect(recs.map((r) => r.uri).sort()).toEqual(keepAll);
      expect(meter.gzipFetchedBytes).toBeGreaterThan(0);
      expect(meter.gzipFetchedBytes).toBeLessThan(gz.byteLength);
      expect(meter.gzipFetchedBytes).toBeLessThan(8_388_608);
      expect(pulled).toBeGreaterThanOrEqual(meter.gzipFetchedBytes);
    } finally {
      srv.stop(true);
    }
  });

  test("live URLs have one owner; only one compact publisher across shards", () => {
    const urls = [
      "https://en.wikipedia.org/wiki/Kenya",
      "https://www.rfc-editor.org/rfc/rfc3986.html",
      "https://arxiv.org/abs/2401.00001",
    ];
    for (const u of urls) {
      const owners = [0, 1, 2, 3].filter((i) => shardOwns(u, i, 4));
      expect(owners.length).toBe(1);
    }
    expect(compactLeader(0, 2)).toBe(true);
    expect(compactLeader(1, 2)).toBe(false);
    expect(compactLeader(0, 1)).toBe(true);
  });
});
