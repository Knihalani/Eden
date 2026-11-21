import { describe, expect, test } from "bun:test";
import { tmpDir } from "@eden/primitives";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readerKey, type ReaderInput, type ReaderMaker } from "@eden/engine";
import {
  decide,
  DistilledReaderMaker,
  FEATURE_NAMES,
  parseDistill,
  poolFeatures,
  scorePool,
  type DistilledModel,
} from "./distilled-reader";

const input: ReaderInput = {
  request: "Book the boardroom for the Acme review on Tuesday",
  today: "2026-11-03",
  items: [
    {
      id: "a",
      source: "mail",
      title: "Boardroom closed",
      date: "2026-11-01",
      from: "Facilities",
      text: "The boardroom is closed for repairs until 2026-11-20.",
      card: "kind=absence; actions=book-venue; about=boardroom; until=2026-11-20",
      hash: "h1",
    },
    { id: "b", source: "chat", title: "Lunch", date: "", from: "", text: "Pizza on Friday?", hash: "h2" },
  ],
};

/** A model with no trees whose base log-odds fixes every score, and the given cuts. */
const flat = (p: number, silent: number, bind: number | null): DistilledModel => ({
  version: 1,
  features: FEATURE_NAMES,
  base: Math.log(p / (1 - p)),
  trees: [],
  silent,
  bind,
});

class Fixed implements ReaderMaker {
  calls = 0;
  async read() {
    this.calls++;
    return { bears: [{ i: 0, kind: "blocks" as const, why: "closed" }], rejected: [1], costUsd: 0.0004 };
  }
}

describe("distilled reader", () => {
  test("one feature row per candidate, FEATURE_NAMES long, finite", () => {
    const xs = poolFeatures(input);
    expect(xs.length).toBe(2);
    for (const x of xs) {
      expect(x.length).toBe(FEATURE_NAMES.length);
      expect(x.every(Number.isFinite)).toBe(true);
    }
    // The card's action meets the request ("book" is in book-venue's description) and its end is ahead.
    expect(xs[0]![FEATURE_NAMES.indexOf("cardActionMeets")]).toBe(1);
    expect(xs[0]![FEATURE_NAMES.indexOf("untilAhead")]).toBe(1);
    expect(xs[1]![FEATURE_NAMES.indexOf("hasCard")]).toBe(0);
  });

  test("decide: silent below the cut, a lone confident candidate bound, otherwise escalated", () => {
    expect(decide(flat(0.01, 0.05, null), [0.01, 0.02])).toEqual({ bears: [], rejected: [], costUsd: 0 });
    expect(decide(flat(0.5, 0.05, 0.9), [0.95, 0.01])!.bears).toEqual([{ i: 0, kind: "changes", why: "" }]);
    // Two above the silent cut: the reader decides which binds.
    expect(decide(flat(0.5, 0.05, 0.9), [0.95, 0.2])).toBeNull();
    // Bind off: a confident candidate still goes to the reader.
    expect(decide(flat(0.5, 0.05, null), [0.95, 0.01])).toBeNull();
    expect(scorePool(flat(0.2, 0.05, null), input).map((s) => +s.toFixed(3))).toEqual([0.2, 0.2]);
  });

  test("cascade: a confident call never reaches the reader; the rest do, counted per suite", async () => {
    const dir = tmpDir("distill-");
    const file = join(dir, "m.json");
    const inner = new Fixed();
    const silent = new DistilledReaderMaker("cascade", inner, file, flat(0.01, 0.05, null));
    silent.task = "train1/hidden/41/t/x";
    expect((await silent.read(input, new AbortController().signal)).bears).toEqual([]);
    expect(inner.calls).toBe(0);
    const unsure = new DistilledReaderMaker("cascade", inner, file, flat(0.3, 0.05, null));
    unsure.task = "train1/hidden/41/t/x";
    expect((await unsure.read(input, new AbortController().signal)).bears![0]!.i).toBe(0);
    expect(inner.calls).toBe(1);
    expect(unsure.stats.bySuite.train1).toEqual({ silent: 0, bind: 0, escalated: 1 });
  });

  test("a fold model is used for its own suite", async () => {
    const inner = new Fixed();
    const model = { ...flat(0.3, 0.05, null), folds: { train2: flat(0.01, 0.05, null) } };
    const m = new DistilledReaderMaker("cascade", inner, "unused", model);
    m.task = "train2/control/41/t/x";
    await m.read(input, new AbortController().signal);
    expect(m.stats.silent).toBe(1);
    m.task = "train3/control/41/t/x";
    await m.read(input, new AbortController().signal);
    expect(m.stats.escalated).toBe(1);
  });

  test("record writes the verdict; labels replays it by task and key with no model", async () => {
    const dir = tmpDir("distill-");
    const rec = join(dir, "rec.jsonl");
    const inner = new Fixed();
    const r = new DistilledReaderMaker("record", inner, rec);
    r.task = "train1/hidden/41/t/a";
    r.planted = { id: "a", role: "hidden" };
    await r.read(input, new AbortController().signal);
    const call = JSON.parse(readFileSync(rec, "utf8").trim());
    expect(call.key).toBe(readerKey(input));
    expect(call.bears).toEqual([{ i: 0, kind: "blocks" }]);
    const labels = join(dir, "labels.jsonl");
    const row = { task: call.task, key: call.key, n: 2, planted: { ...call.planted, at: 0 }, bears: call.bears };
    writeFileSync(labels, `${JSON.stringify({ ...row, rejected: [1] })}\n`);
    const l = new DistilledReaderMaker("labels", null, labels, null, join(dir, "out.jsonl"));
    l.task = "train1/hidden/41/t/a";
    const got = await l.read(input, new AbortController().signal);
    expect(got.bears).toEqual([{ i: 0, kind: "blocks", why: "" }]);
    expect(got.costUsd).toBe(0);
    l.task = "train1/hidden/41/t/other";
    expect((await l.read(input, new AbortController().signal)).bears).toBeNull();
    expect(l.missed).toBe(1);
  });

  test("parseDistill", () => {
    expect(parseDistill("cascade:m.json")).toEqual({ mode: "cascade", file: "m.json", out: "" });
    expect(parseDistill("labels:l.jsonl,o.jsonl")).toEqual({ mode: "labels", file: "l.jsonl", out: "o.jsonl" });
    expect(() => parseDistill("labels:l.jsonl")).toThrow();
    expect(() => parseDistill("nope")).toThrow();
  });
});
