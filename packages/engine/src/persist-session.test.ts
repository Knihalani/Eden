/**
 * A frozen user keeps its sessions' delivery knowledge (ledger snapshot and delivered list, written in the blob's
 * `extra.sessions`): a daemon respawned between turns, or a user handed between machines, serves fresh sessions
 * seeded with it, so nothing the agent already holds is handed out again.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, Scope } from "@eden/protocol";
import { StaticSource, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { EncryptedFrozenDisk } from "./persist";
import type { UsageRecord } from "./trace";

const HOUR = 3_600_000;
const KEY = new Uint8Array(32).map((_, i) => i + 3);
const user: Scope = { tenantId: "t", userId: "u1" };
let clock = 1_700_000_000_000;
const ev = (e: Record<string, unknown>) => ({ ...user, sessionId: "a", at: clock++, ...e }) as AgentEvent;

const crm: Source = new StaticSource("crm", "Deals and accounts", [
  {
    ref: "deal-9",
    title: "Globex renewal",
    text: "Globex renewal due 2026-11-30, Dana Lee is the champion, wants 12% off",
  },
]);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function partner(dir: string, onUsage?: (record: UsageRecord) => void, idleMs?: number): ContextPartner {
  const cache = new ItemCache();
  cache.persist(new EncryptedFrozenDisk({ dir, key: KEY, maxBytes: 64 << 20, maxAgeMs: 7 * 24 * HOUR }));
  return new ContextPartner({
    sources: async () => [crm],
    sourceMap: new SourceMap(),
    cache,
    budget: new Budget(),
    model: null,
    config: { ...CORE_CONFIG, ...(idleMs === undefined ? {} : { sessionIdleMs: idleMs }) },
    onUsage,
  });
}

describe("session knowledge carried with a frozen user", () => {
  test("a restored user's new session is not handed what the released one delivered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-sess-"));
    dirs.push(dir);
    const a = partner(dir);
    const got = await a.observe(ev({ kind: "user_message", text: "What about the Globex renewal?" }), {
      waitMs: 2_000,
    });
    expect(got.injection?.citations.map((c) => c.itemId)).toContain("crm:deal-9");
    expect(a.release(user)).toBe(true);

    const b = partner(dir);
    // The same session continuing after the respawn: what it already handed stays handed.
    const again = await b.observe(
      ev({ kind: "user_message", sessionId: "a", text: "What about the Globex renewal?" }),
      { waitMs: 2_000 },
    );
    expect(again.injection).toBeNull();
    // A new conversation of the same user is not seeded (BUG_0001): its agent never held the item.
    const fresh = await b.observe(
      ev({ kind: "user_message", sessionId: "c", text: "What about the Globex renewal?" }),
      { waitMs: 2_000 },
    );
    expect(fresh.injection?.citations.map((c) => c.itemId)).toContain("crm:deal-9");
  });

  test("an injection still awaiting a use verdict survives the respawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-sess-"));
    dirs.push(dir);
    const a = partner(dir);
    const got = await a.observe(ev({ kind: "user_message", text: "What about the Globex renewal?" }), {
      waitMs: 2_000,
    });
    const injectionId = got.injection?.id;
    expect(injectionId).toBeTruthy();
    expect(a.release(user)).toBe(true);

    const b = partner(dir);
    await b.observe(ev({ kind: "user_message", sessionId: "a", text: "anything to get the session live" }), {
      waitMs: 2_000,
    });
    // Outstanding rode the blob: explicit feedback still reaches the use verdict for `crm`.
    expect(
      b.feedback({ tenantId: "t", userId: "u1", sessionId: "a", injectionId: injectionId!, used: true, how: "explicit" }),
    ).toBe(true);
  });

  test("a judged injection is not re-seeded when the session is evicted and reopened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-sess-"));
    dirs.push(dir);
    const a = partner(dir);
    const got = await a.observe(ev({ kind: "user_message", text: "What about the Globex renewal?" }), {
      waitMs: 2_000,
    });
    const injectionId = got.injection?.id;
    expect(injectionId).toBeTruthy();
    expect(a.release(user)).toBe(true);

    const records: UsageRecord[] = [];
    const b = partner(
      dir,
      (r) => {
        if (r.injectionId === injectionId) records.push(r);
      },
      0,
    );
    await b.observe(ev({ kind: "user_message", sessionId: "a", text: "back again" }), { waitMs: 2_000 });
    expect(
      b.feedback({ tenantId: "t", userId: "u1", sessionId: "a", injectionId: injectionId!, used: true, how: "explicit" }),
    ).toBe(true);
    expect(records).toHaveLength(1);

    // `sessionIdleMs: 0`: creating session "x" evicts "a" without learning; the user then returns to it before
    // any re-freeze, so `restoredSessions` still holds the blob it was thawed from.
    await b.observe(ev({ kind: "user_message", sessionId: "x", text: "unrelated" }), { waitMs: 0 });
    await b.observe(ev({ kind: "user_message", sessionId: "a", text: "and again" }), { waitMs: 0 });
    // The judged injection must not come back as outstanding: a second verdict would count it twice.
    b.feedback({ tenantId: "t", userId: "u1", sessionId: "a", injectionId: injectionId!, used: true, how: "explicit" });
    expect(records).toHaveLength(1);
  });

  test("a restored user still corrects an ended session's verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-sess-"));
    dirs.push(dir);
    const a = partner(dir);
    const got = await a.observe(ev({ kind: "user_message", text: "What about the Globex renewal?" }), {
      waitMs: 2_000,
    });
    const injectionId = got.injection!.id;
    // session_end learns the outstanding injection "ended" (unused) into `recorded`.
    await a.observe(ev({ kind: "session_end" }));
    expect(a.release(user)).toBe(true);

    const b = partner(dir);
    // Any event on the scope thaws the user; the injection's session is gone — only `recorded` can answer.
    await b.observe(ev({ kind: "user_message", sessionId: "n1", text: "hi" }), { waitMs: 0 });
    expect(b.feedback({ ...user, sessionId: "a", injectionId, used: true, how: "explicit" })).toBe(true);
  });
});
