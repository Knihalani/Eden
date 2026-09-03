import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cheapSkipHost } from "./gate";
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
    expect(skipHost("https://www.nytimes.com/a")).toBeTruthy();
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

  test("tick skips SPARQL and overlaps WET/NEWS/CDX fetches", () => {
    const loop = readFileSync(join(import.meta.dir, "loop.ts"), "utf8");
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
  });
});
