import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, Scope } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { ItemCache } from "./cache";
import { CORE_CONFIG } from "./parts";
import { ContextPartner } from "./partner";
import { EncryptedFrozenDisk } from "./persist";
import type { UsageRecord } from "./trace";

// A3/D2006: `context_reset` — the agent compacted or replaced its transcript, so the session's shown marks clear
// and a later delivery of the same item is news again, not a repeat. The session itself stays open.

const DOC = {
  ref: "d1",
  title: "Globex renewal",
  text: "Dana Lee wants 12% off the Globex renewal, signed by 2026-11-20",
};
const setup = () => {
  const got: UsageRecord[] = [];
  const p = new ContextPartner({
    sources: async () => [new StaticSource("crm", "deals", [DOC])],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    config: CORE_CONFIG,
    onUsage: (u) => got.push(u),
  });
  return { p, got };
};
const ref = { tenantId: "t", userId: "u", sessionId: "s" };
const ev = (e: Record<string, unknown>) => ({ ...ref, at: Date.UTC(2026, 10, 7), ...e }) as AgentEvent;
const QUESTION = "Globex renewal with Dana Lee";

async function delivered(p: ContextPartner): Promise<string> {
  const r = await p.observe(ev({ kind: "user_message", text: QUESTION }), { waitMs: 1_000 });
  const inj = r.injection ?? p.takePending(ref)[0];
  if (!inj) throw new Error("nothing delivered");
  return inj.id;
}

describe("context_reset (D2006)", () => {
  test("a compacted session may be shown the same item again", async () => {
    const { p } = setup();
    await delivered(p);
    await p.observe(ev({ kind: "context_reset" }));
    // The same request after the reset: the item the agent no longer has is delivered again.
    const again = await delivered(p);
    expect(again).toBeTruthy();
  });

  test("a compaction is no verdict: the reset emits a `reset` record so the handed bytes still reach the digest", async () => {
    const { p, got } = setup();
    const id = await delivered(p);
    await p.observe(ev({ kind: "context_reset" }));
    expect(got).toEqual([
      {
        sessionId: "s",
        injectionId: id,
        used: false,
        how: "reset",
        sourceIds: ["crm"],
        injectionBytes: expect.any(Number),
      },
    ]);
  });

  test("feedback on a pre-reset delivery still lands: `recorded` is the user's, not the marks'", async () => {
    const { p, got } = setup();
    const id = await delivered(p);
    await p.observe(ev({ kind: "context_reset" }));
    expect(p.feedback({ ...ref, injectionId: id, used: true, how: "explicit" })).toBe(true);
    expect(got).toEqual([
      {
        sessionId: "s",
        injectionId: id,
        used: false,
        how: "reset",
        sourceIds: ["crm"],
        injectionBytes: expect.any(Number),
      },
      {
        sessionId: "s",
        injectionId: id,
        used: true,
        how: "explicit",
        sourceIds: ["crm"],
        injectionBytes: expect.any(Number),
      },
    ]);
  });

  test("without the reset the repeat stays blocked", async () => {
    const { p } = setup();
    await delivered(p);
    const r = await p.observe(ev({ kind: "user_message", text: QUESTION }), { waitMs: 1_000 });
    const inj = r.injection ?? p.takePending(ref)[0];
    expect(inj?.citations.map((c) => c.itemId) ?? []).not.toContain("crm:d1");
  });
});

// A reset on a cold user still clears what the blob saved: `ready` thaws so the seed can be dropped — a
// `pendingThaw` would early-return and the next event's thaw would re-seed the marks (D2006 review).
const KEY = new Uint8Array(32).map((_, i) => i + 7);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function diskPartner(dir: string, onUsage?: (record: UsageRecord) => void): ContextPartner {
  const cache = new ItemCache();
  cache.persist(new EncryptedFrozenDisk({ dir, key: KEY, maxBytes: 64 << 20, maxAgeMs: 7 * 24 * 3_600_000 }));
  return new ContextPartner({
    sources: async () => [new StaticSource("crm", "deals", [DOC])],
    sourceMap: new SourceMap(),
    cache,
    budget: new Budget(),
    model: null,
    config: CORE_CONFIG,
    onUsage,
  });
}

describe("context_reset on a cold or evicted session", () => {
  test("a cold reset drops the saved seed too: the next event is not re-suppressed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-reset-"));
    dirs.push(dir);
    const user: Scope = { tenantId: "t", userId: "u" };
    const a = diskPartner(dir);
    await delivered(a);
    expect(a.release(user)).toBe(true);
    // A respawn: nothing is live or restored yet — the reset must thaw the blob to drop the seed.
    const b = diskPartner(dir);
    await b.observe(ev({ kind: "context_reset" }));
    const r = await b.observe(ev({ kind: "user_message", text: QUESTION }), { waitMs: 1_000 });
    const inj = r.injection ?? b.takePending(ref)[0];
    expect(inj?.citations.map((c) => c.itemId)).toContain("crm:d1");
  });

  test("an evicted session's reset keeps pre-reset feedback answerable", async () => {
    const got: UsageRecord[] = [];
    const p = new ContextPartner({
      sources: async () => [new StaticSource("crm", "deals", [DOC])],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      config: { ...CORE_CONFIG, sessionIdleMs: 0 },
      onUsage: (u) => got.push(u),
    });
    const id = await delivered(p);
    // `sessionIdleMs: 0`: another session's first event evicts this one into `restoredSessions`.
    await p.observe(
      { ...ref, sessionId: "x", at: Date.UTC(2026, 10, 7), kind: "user_message", text: "hi" } as AgentEvent,
      { waitMs: 0 },
    );
    await p.observe(ev({ kind: "context_reset" }));
    expect(p.feedback({ ...ref, injectionId: id, used: true, how: "explicit" })).toBe(true);
    expect(got).toEqual([
      {
        sessionId: "s",
        injectionId: id,
        used: false,
        how: "reset",
        sourceIds: ["crm"],
        injectionBytes: expect.any(Number),
      },
      {
        sessionId: "s",
        injectionId: id,
        used: true,
        how: "explicit",
        sourceIds: ["crm"],
        injectionBytes: expect.any(Number),
      },
    ]);
  });
});
