import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import type { ContextItem } from "@eden/protocol";
import { ItemTagger, readTagger, sharedTagger, TAGGER_PATH, TagMemo } from "./tagger";

// The constraint tagger (D908): the shipped weights, their parity with the training code, one copy a process, and the
// per-user memo (isolation, D9; background ingest; an edited item read again; forget).

const item = (id: string, text: string, title = "Note"): ContextItem => ({
  id,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: 0,
});
const A = { tenantId: "t", userId: "a" };
const B = { tenantId: "t", userId: "b" };
const turn = () => new Promise((r) => setImmediate(r));

describe("the shipped tagger", () => {
  test("the weights file stays small (two bits a ternary weight): under 4.5 MB", () => {
    expect(statSync(TAGGER_PATH).size).toBeLessThan(4.5 * 1024 * 1024);
  });

  test("its logits match PyTorch's on the export's checks (generated sim worlds), and its top tag", () => {
    const t = sharedTagger()!;
    expect(t).toBeInstanceOf(ItemTagger);
    expect(t.header.tags[0]).toBe("fact");
    expect(t.header.checks.length).toBeGreaterThan(0);
    for (const c of t.header.checks) {
      const got = t.logits(c.text);
      for (let k = 0; k < got.length; k++) expect(Math.abs(got[k]! - c.logits[k]!)).toBeLessThan(1e-3);
    }
  });

  test("one copy a process: every caller shares it", () => {
    expect(sharedTagger()).toBe(sharedTagger());
  });

  test("a missing file reads as no tagger, logged once (fail open)", () => {
    const logs: string[] = [];
    expect(readTagger("/nonexistent/tags.bin", (m) => logs.push(m))).toBeNull();
    expect(logs.length).toBe(1);
  });
});

describe("TagMemo", () => {
  const t = sharedTagger()!;
  const HOLD = item("m1", "Payments to Harlow are on hold until the deposit dispute ends.", "Harlow venue");

  test("reads are per user: another user's memo is never read or filled", () => {
    const m = new TagMemo(t);
    const p = m.read(A, HOLD);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
    expect(m.size()).toEqual({ users: 1, items: 1 });
    m.read(B, HOLD);
    expect(m.size()).toEqual({ users: 2, items: 2 });
    m.forget(A);
    expect(m.size()).toEqual({ users: 1, items: 1 });
  });

  test("the memo's reading is the network's (to 1/255), and a second read tags nothing", () => {
    const m = new TagMemo(t);
    const p = m.read(A, HOLD);
    expect(Math.abs(p - t.constraintProbability(HOLD))).toBeLessThanOrEqual(1 / 255);
    m.read(A, HOLD);
    expect(m.stats.tagged).toBe(1);
  });

  test("ingest tags in the background, a few items a turn, never in the caller's turn", async () => {
    const m = new TagMemo(t);
    const items = Array.from({ length: 20 }, (_, i) => item(`i${i}`, `Item ${i}: the venue booking is confirmed.`));
    m.ingest(A, items);
    expect(m.stats.tagged).toBe(0);
    for (let k = 0; k < 10 && m.stats.tagged < 20; k++) await turn();
    expect(m.stats.tagged).toBe(20);
    for (const it of items) m.read(A, it);
    expect(m.stats.tagged).toBe(20);
  });

  test("an edited item is read again; forgetting ids or the user drops queued work too", async () => {
    const m = new TagMemo(t);
    m.read(A, HOLD);
    m.read(A, { ...HOLD, text: `${HOLD.text} Update: the dispute is settled.` });
    expect(m.stats.tagged).toBe(2);
    m.forget(A, [HOLD.id]);
    expect(m.size().items).toBe(0);
    m.ingest(B, [item("q1", "one"), item("q2", "two")]);
    m.forget(B);
    for (let k = 0; k < 3; k++) await turn();
    expect(m.size()).toEqual({ users: 0, items: 0 });
  });

  test("a user's memo is bounded, oldest first", () => {
    const m = new TagMemo(t, 3);
    for (let i = 0; i < 5; i++) m.read(A, item(`b${i}`, `text ${i}`));
    expect(m.size().items).toBe(3);
  });
});

describe("length invariance (D908's gate)", () => {
  test("short real constraints read as constraints: at least 97% of the fixture at 0.5 or more", () => {
    // fixtures/short-constraints.jsonl: two hand-written, 30 from M2 v2's test split and 20 from the sim's held-out
    // train5-6, each a fact cut to its title and one sentence (packages/sim/lab/m3r/short_fixture.py).
    const rows = readFileSync(new URL("../fixtures/short-constraints.jsonl", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { title: string; text: string });
    expect(rows.length).toBeGreaterThanOrEqual(32);
    const t = sharedTagger()!;
    const low = rows.filter((r) => t.constraintProbability(r) < 0.5);
    expect(low.length / rows.length).toBeLessThanOrEqual(0.03);
  });
});
