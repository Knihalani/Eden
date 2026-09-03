import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cheapSkipHost, headerSkipHost } from "./gate";
import { skipHost } from "./extract";
import { BytePipe, emptyWarcStats, pushWarcBytes, type WetRecord } from "./warc";
import { keepWet, wetHeaderSkip } from "./cc";
import { shardWetIndex } from "./defaults";

const FACT =
  "RFC 3986 Uniform Resource Identifier Generic Syntax. Kenya is a country in East Africa whose capital is Nairobi. ";

function rec(uri: string, text: string): Uint8Array {
  const body = `${text}\n`;
  const hdr = `WARC/1.0\r\nWARC-Type: conversion\r\nWARC-Target-URI: ${uri}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  return Buffer.concat([Buffer.from(hdr, "utf8"), Buffer.from(body, "utf8")]);
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
    expect(loop).toContain("await Promise.all([");
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
  });

  test("health HTTP answers in the parent while the ingest child starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-health-"));
    const port = 18000 + (process.pid % 4000) + 17;
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "worker.ts")], {
      env: {
        ...process.env,
        PORT: String(port),
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
      await new Promise((r) => setTimeout(r, 500));
      const t0 = performance.now();
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      const ms = performance.now() - t0;
      const j = (await r.json()) as { ok?: boolean; caps?: { cc?: number; shards?: number } };
      expect(r.ok).toBe(true);
      expect(j.ok).toBe(true);
      expect(j.caps?.cc).toBe(0);
      expect(j.caps?.shards).toBe(1);
      expect(ms).toBeLessThan(200);
    } finally {
      proc.kill();
      await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 2000))]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
